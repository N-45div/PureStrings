import {
  amountText,
  cents,
  decimal,
  expired,
  fingerprint,
  keyText,
  MAX_ALLOWANCE_DAYS,
  parseSignable,
  type Payee,
  type Payment,
  type PayPal,
  PayPalError,
  PERIODS,
  signedBy,
} from "@purestrings/core";
import type { Context, Hono } from "hono";
import type { Catalog } from "./catalog.ts";
import { body, fail, orderView } from "./http.ts";
import type { Order, ShopAllowance, ShopStore } from "./store.ts";

/** What the shop's payment routes work with. */
export interface ShopContext {
  readonly catalog: Catalog;
  readonly store: ShopStore;
  readonly paypal: PayPal | null;
  readonly shop: Payee;
  readonly now: () => number;
  readonly noPayPal: (c: Context) => Response;
  readonly admin: (c: Context) => boolean;
  readonly webhookId?: string;
}

/**
 * The shop's payments: allowances a linked key signed, checkout (a payment a key signed, or one PureStrings' key
 * signed under an allowance), the orders it keeps with what each was signed for, refunds, and PayPal's webhooks.
 */
export function paymentRoutes(app: Hono, context: ShopContext): void {
  const { catalog, store, paypal, shop, now, noPayPal, admin } = context;
  const options = { webhookId: context.webhookId };
  // Allowances: a linked key says once that PureStrings' key may pay here on its own, within limits ---------

  /** Since when an allowance's limit counts: now, less its day, week or month. */
  const windowStart = (allowance: ShopAllowance) => new Date(now() - PERIODS[allowance.per]).toISOString();
  const allowanceView = (allowance: ShopAllowance) => ({
    id: allowance.id,
    status: allowance.status,
    each: allowance.each,
    total: allowance.total,
    per: allowance.per,
    currency: allowance.currency,
    expires: allowance.expires,
    spent: decimal(store.spentUnder(allowance.id, windowStart(allowance))),
    board: fingerprint(allowance.key),
    agent: fingerprint(allowance.agent),
  });

  /** Why a payment doesn't fit its allowance, or null when it does. */
  const overAllowance = (allowance: ShopAllowance, payment: Payment): string | null => {
    const money = (value: string) => amountText(value, allowance.currency);
    if (allowance.status !== "active") return "That allowance was stopped.";
    if (expired(allowance, now())) return "That allowance has ended.";
    if (payment.currency !== allowance.currency) return `That allowance is in ${allowance.currency}.`;
    const total = cents(payment.total) ?? 0;
    if (total > (cents(allowance.each) ?? 0)) return `${money(payment.total)} is more than the ${money(allowance.each)} a time the allowance lets PureStrings pay.`;
    const spent = store.spentUnder(allowance.id, windowStart(allowance));
    if (spent + total > (cents(allowance.total) ?? 0)) return `That would make ${money(decimal(spent + total))} in a ${allowance.per} under the allowance, more than its ${money(allowance.total)}.`;
    return null;
  };

  /** Takes an allowance a linked key signed: the key it names may then pay for carts here, within its limits. */
  app.post("/allowances", async (c) => {
    const { text, signature, key: given } = await body(c);
    if (typeof text !== "string" || typeof signature !== "string" || typeof given !== "string") return fail(c, 400, "Send the signed allowance as { text, signature, key }.");
    let key: string;
    let allowance;
    try {
      key = keyText(given);
      allowance = parseSignable(text);
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : String(error));
    }
    if (allowance.kind !== "allow") return fail(c, 400, "That's not an allowance.");
    if (allowance.shop.id !== shop.id || allowance.shop.name !== shop.name) return fail(c, 400, `That allowance is for ${allowance.shop.name} (${allowance.shop.id}), not this shop.`);
    if (allowance.currency !== catalog.currency) return fail(c, 400, `${shop.name} sells in ${catalog.currency}, not ${allowance.currency}.`);
    if (!store.customer(key)) return fail(c, 401, `This key isn't linked to a PayPal at ${shop.name}. Link it first.`);
    if (!signedBy(text, signature, key)) return fail(c, 401, "That isn't this key's signature of the allowance.");
    if (expired(allowance, now())) return fail(c, 410, "This allowance has already ended.");
    if (Date.parse(allowance.expires) > now() + (MAX_ALLOWANCE_DAYS + 1) * 86_400_000) return fail(c, 400, `An allowance lasts at most ${MAX_ALLOWANCE_DAYS} days; then the key is asked again.`);
    const kept = store.addAllowance({ id: allowance.id, key, agent: allowance.agent, text, signature, each: allowance.each, total: allowance.total, per: allowance.per, currency: allowance.currency, expires: allowance.expires });
    if (kept.text !== text) return fail(c, 409, "Another allowance already has that id.");
    return c.json({ allowance: allowanceView(kept) }, 201);
  });

  app.get("/allowances/:id", (c) => {
    const allowance = store.allowance(c.req.param("id"));
    return allowance ? c.json({ allowance: allowanceView(allowance) }) : fail(c, 404, "There's no such allowance.");
  });

  /** Stops an allowance at once: signed ("stop" and its id) by the key that gave it, or by the key it names. */
  app.post("/allowances/:id/stop", async (c) => {
    const allowance = store.allowance(c.req.param("id"));
    if (!allowance) return fail(c, 404, "There's no such allowance.");
    const signature = String((await body(c)).signature ?? "");
    const said = `stop ${allowance.id}`;
    if (!signedBy(said, signature, allowance.key) && !signedBy(said, signature, allowance.agent)) return fail(c, 401, "Stopping an allowance takes a signature from the key that gave it, or from the key it names.");
    store.stopAllowance(allowance.id);
    return c.json({ allowance: allowanceView(store.allowance(allowance.id)!) });
  });

  /**
   * Pays for a cart with a key's signature. Charged only when: the text is a payment to this shop, written the
   * one way; the key is linked to a PayPal here; the signature is that key's, of exactly that text; it
   * hasn't expired; and its lines, total and currency are the cart's own. Each payment is paid for once: sending
   * it again gives back the same order.
   */
  app.post("/checkout", async (c) => {
    const { text, signature, key: given } = await body(c);
    if (typeof text !== "string" || typeof signature !== "string" || typeof given !== "string") return fail(c, 400, "Send the signed payment as { text, signature, key }.");
    let key: string;
    try {
      key = keyText(given);
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : String(error));
    }
    let payment;
    try {
      payment = parseSignable(text);
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : String(error));
    }
    if (payment.kind !== "buy") return fail(c, 400, "That's not a payment.");
    if (payment.shop.id !== shop.id || payment.shop.name !== shop.name) return fail(c, 400, `That payment is to ${payment.shop.name} (${payment.shop.id}), not this shop.`);
    // Under an allowance: signed by the PureStrings key it names, and charged to the PayPal of the key that signed it.
    const allowance = payment.allow ? store.allowance(payment.allow) : null;
    if (payment.allow && !allowance) return fail(c, 403, "There's no such allowance here, so nothing was charged.");
    if (allowance && key !== allowance.agent) return fail(c, 401, "Only the key the allowance names can pay under it, so nothing was charged.");
    const customer = store.customer(allowance ? allowance.key : key);
    if (!customer) return fail(c, 401, `This key isn't linked to a PayPal at ${shop.name}. Link it first.`);
    if (!signedBy(text, signature, key)) return fail(c, 401, allowance ? "That isn't the allowance's key's signature of this payment, so nothing was charged." : "That isn't this key's signature of this payment, so nothing was charged.");

    const earlier = store.orderForPayment(payment.id);
    if (earlier) {
      if (earlier.fingerprint !== customer.fingerprint) return fail(c, 409, "This payment was already used by another key.");
      // Still with PayPal, or PayPal couldn't be reached last time: ask again (PayPal does a request it's seen once).
      if (earlier.status === "charging" && earlier.error && paypal) return charge(c, earlier, customer.vaultId);
      return c.json({ order: orderView(earlier) }, earlier.status === "charging" ? 202 : 200);
    }
    if (expired(payment, now())) return fail(c, 410, "This payment's signature expired before it reached the shop; nothing was charged.");
    const cart = store.cart(payment.cart);
    if (!cart) return fail(c, 409, "There's no such cart here.");
    if (Date.parse(payment.expires) > Date.parse(cart.expires)) return fail(c, 409, "The payment outlives the cart's prices; price the cart again.");
    const same =
      cart.total === payment.total &&
      cart.currency === payment.currency &&
      cart.items.length === payment.items.length &&
      cart.items.every((line, index) => line.name === payment.items[index]!.name && line.qty === payment.items[index]!.qty && line.price === payment.items[index]!.price);
    if (!same) return fail(c, 409, "The signed payment isn't this cart as the shop priced it, so nothing was charged.");
    // Checked and kept together, with nothing in between, so two payments at once can't both slip under the limit.
    const over = allowance ? overAllowance(allowance, payment) : null;
    if (over) return fail(c, 403, `${over} Nothing was charged: your key can sign it instead.`);
    if (!paypal) return noPayPal(c);
    const order = store.startOrder({ paymentId: payment.id, cartId: cart.id, fingerprint: customer.fingerprint, text, signature, total: payment.total, currency: payment.currency, ...(allowance ? { allowance: allowance.id } : {}) });
    // Another checkout of this payment got there first.
    if (!order) return c.json({ order: orderView(store.orderForPayment(payment.id)!) }, 202);
    return charge(c, order, customer.vaultId);
  });

  /** Charges the saved PayPal for an order's cart, and says how it went. */
  const charge = async (c: Context, order: Order, vaultId: string) => {
    const cart = store.cart(order.cartId)!;
    try {
      const result = await paypal!.charge({
        vaultId,
        currency: cart.currency,
        invoiceId: order.paymentId,
        customId: cart.id,
        description: order.allowance ? `${shop.name}, under allowance ${order.allowance} from key ${order.fingerprint}` : `${shop.name}, signed by key ${order.fingerprint}`,
        items: cart.items.map((line) => ({ name: line.name, sku: line.sku, quantity: line.qty, unitAmount: line.price })),
      });
      const done = store.finishOrder(order.id, { status: result.status === "PENDING" ? "pending" : "paid", paypalOrderId: result.orderId, captureId: result.captureId, error: null });
      return c.json({ order: orderView(done) }, 201);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      // PayPal answered no: the order failed. PayPal couldn't be reached: it may yet have charged, so the order
      // stays with PayPal, and sending the payment again asks PayPal again, as the same request.
      if (error instanceof PayPalError || !/couldn't be reached/.test(why)) {
        const failed = store.finishOrder(order.id, { status: "failed", error: why });
        return c.json({ error: why, order: orderView(failed) }, 402);
      }
      store.finishOrder(order.id, { status: "charging", error: why });
      return fail(c, 502, `${why} Send the same signed payment again: it's never charged twice.`);
    }
  };

  app.get("/orders/:id", (c) => {
    const order = store.order(c.req.param("id"));
    return order ? c.json({ order: orderView(order) }) : fail(c, 404, "There's no such order.");
  });

  /** The shop's own: every order, with the signed text each was paid for. */
  app.get("/orders", (c) => {
    if (!admin(c)) return fail(c, 401, "This page is the shop's: send its admin token (SHOP_ADMIN_TOKEN).");
    return c.json({ orders: store.orders().map((order) => ({ ...orderView(order), text: order.text, signature: order.signature })) });
  });

  app.post("/orders/:id/refund", async (c) => {
    if (!admin(c)) return fail(c, 401, "Refunds are the shop's: send its admin token (SHOP_ADMIN_TOKEN).");
    const order = store.order(c.req.param("id"));
    if (!order) return fail(c, 404, "There's no such order.");
    if (order.status !== "paid" || !order.captureId) return fail(c, 409, `Only a paid order can be refunded; this one is ${order.status}.`);
    if (!paypal) return noPayPal(c);
    const { amount, note } = await body(c);
    const partial = typeof amount === "string" ? cents(amount) : null;
    if (amount !== undefined && (partial === null || partial === 0 || partial > cents(order.total)!)) return fail(c, 400, `Refund an amount up to ${order.total}, written like 8.50.`);
    try {
      const refund = await paypal.refund(order.captureId, {
        requestId: `refund-${order.id}-${amount ?? "all"}`,
        ...(partial !== null ? { amount: { currency_code: order.currency, value: decimal(partial) } } : {}),
        ...(typeof note === "string" ? { note } : {}),
      });
      const done = partial === null || partial === cents(order.total) ? store.finishOrder(order.id, { status: "refunded" }) : order;
      return c.json({ refund, order: orderView(done) });
    } catch (error) {
      return fail(c, 502, error instanceof Error ? error.message : String(error));
    }
  });

  /** PayPal's word on a payment after the fact: settled, denied, refunded, reversed. Checked with PayPal first. */
  app.post("/paypal/webhook", async (c) => {
    if (!paypal || !options.webhookId) return fail(c, 503, "This shop isn't taking PayPal's webhooks: set PAYPAL_WEBHOOK_ID to the webhook's id from the Developer Dashboard.");
    const event = (await body(c)) as { event_type?: unknown; resource?: { id?: unknown; invoice_id?: unknown; status?: unknown } };
    let genuine = false;
    try {
      genuine = await paypal.verifyWebhook((name) => c.req.header(name), event, options.webhookId);
    } catch (error) {
      return fail(c, 502, error instanceof Error ? error.message : String(error));
    }
    if (!genuine) return fail(c, 401, "PayPal says that webhook isn't its own.");
    const type = typeof event.event_type === "string" ? event.event_type : "";
    const statuses: Readonly<Record<string, Order["status"]>> = {
      "PAYMENT.CAPTURE.COMPLETED": "paid",
      "PAYMENT.CAPTURE.PENDING": "pending",
      "PAYMENT.CAPTURE.DENIED": "failed",
      "PAYMENT.CAPTURE.DECLINED": "failed",
      "PAYMENT.CAPTURE.REFUNDED": "refunded",
      "PAYMENT.CAPTURE.REVERSED": "reversed",
    };
    const status = statuses[type];
    if (!status) return c.json({ ok: true, ignored: type });
    const resource = event.resource ?? {};
    const order =
      (typeof resource.invoice_id === "string" ? store.orderForPayment(resource.invoice_id) : null) ??
      (typeof resource.id === "string" ? store.orderForCapture(resource.id) : null);
    if (!order) return c.json({ ok: true, ignored: "no order of this shop's" });
    const changed = store.finishOrder(order.id, { status, ...(type.startsWith("PAYMENT.CAPTURE.") && typeof resource.id === "string" && status !== "refunded" ? { captureId: resource.id } : {}), error: order.error });
    return c.json({ ok: true, order: orderView(changed) });
  });

}
