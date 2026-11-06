import {
  amountText,
  cents,
  decimal,
  expired,
  fingerprint,
  keyText,
  type LinkRequest,
  MAX_ALLOWANCE_DAYS,
  MAX_ITEMS,
  parseSignable,
  type Payee,
  type Payment,
  PERIODS,
  PayPal,
  PayPalError,
  signableId,
  signableText,
  signableTime,
  signedBy,
} from "@purestrings/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type Catalog, readCatalog, search } from "./catalog.ts";
import { body, fail, same } from "./http.ts";
import { paymentRoutes } from "./payments.ts";
import { type Cart, type Link, ShopStore } from "./store.ts";

export { type Catalog, parseCatalog, type Product, readCatalog, search } from "./catalog.ts";
export { ShopStore } from "./store.ts";

/**
 * Bean & Leaf: a demo shop that sells to agents, through PayPal's sandbox. An agent can look through the
 * catalog and have a cart priced, but the shop charges your PayPal only for a cart your key signed:
 *
 * 1. Link once. Your key signs the shop's link text, you approve saving your PayPal with the shop on
 *    PayPal's own page (Vault), and the shop keeps that saved PayPal against your key's public key.
 * 2. Buy. The agent has a cart priced, PureStrings writes the payment for your key to show and sign (the shop,
 *    each line, the total, an expiry), and sends the signed text here. The shop checks the signature against the
 *    key linked to your PayPal and the text against its own cart, line by line, and only then charges your
 *    saved PayPal, once per payment.
 *
 * It runs on its own (`npm start -w @purestrings/shop`), or inside PureStrings' server at /shop, for one-service
 * demos; either way PureStrings reaches it over HTTP only, as it would any shop. The shop keeps each order with the
 * text and signature it was paid for: proof, in a dispute, of what the payer's key agreed to.
 */

export interface ShopOptions {
  readonly catalog: Catalog;
  readonly store: ShopStore;
  /** The shop's PayPal app (sandbox); without it the shop shows its catalog and prices carts, but can't link or charge. */
  readonly paypal: PayPal | null;
  /** Where the shop is reached from outside: PayPal sends payers back under it. */
  readonly publicUrl: string;
  /** The shop's id in what keys sign: its address's host unless given. */
  readonly id?: string;
  /** For the shop's own pages (all orders, refunds), as a Bearer token; without it they're closed. */
  readonly adminToken?: string;
  /** The id of the webhook added for the shop in PayPal's Developer Dashboard, to check PayPal's events with. */
  readonly webhookId?: string;
  readonly now?: () => number;
  /** How long a priced cart's prices hold (default 30 minutes). */
  readonly cartMinutes?: number;
}

/** The most one cart may come to, in cents: a demo shop has no business taking more. */
const MAX_CART_CENTS = 1_000_000;
const LINK_MINUTES = 10;

const cartView = (cart: Cart, shop: Payee) => ({ id: cart.id, shop, items: cart.items, total: cart.total, currency: cart.currency, expires: cart.expires });
const linkView = (link: Link, email: string | null) => ({ id: link.id, status: link.status, expires: link.expires, error: link.error, paypal: email });

/** A web address of yours to send the payer back to, or null when it isn't one. */
function returnTo(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2_000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** The address with these added to its query. */
function withQuery(address: string, query: Record<string, string>): string {
  const url = new URL(address);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url.toString();
}

/** Whether two secrets match, in the same time whatever they hold. */
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
/** A small page for the payer, when PayPal sends them back and there's nowhere of theirs to go on to. */
const page = (title: string, words: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1c1c1c;background:#faf7f2}h1{font-size:1.4rem}</style></head><body><h1>${escape(title)}</h1><p>${escape(words)}</p></body></html>`;

export function shopApp(options: ShopOptions): Hono {
  const { catalog, store } = options;
  const now = options.now ?? Date.now;
  const publicUrl = options.publicUrl.replace(/\/$/, "");
  const shop: Payee = { id: options.id ?? new URL(publicUrl).host, name: catalog.name };
  const cartMs = (options.cartMinutes ?? 30) * 60_000;
  const paypal = options.paypal;
  const noPayPal = (c: Context) => fail(c, 503, `${shop.name} can't take PayPal yet: its PayPal app isn't set up (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET).`);
  const admin = (c: Context) => Boolean(options.adminToken) && same(c.req.header("authorization") ?? "", `Bearer ${options.adminToken}`);

  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => fail(c, 400, "That's too big for this shop.") }));

  /** What the shop is: its id and name as keys see them, what it sells in, and whether PayPal is set up. */
  app.get("/", (c) =>
    c.json({
      shop,
      about: catalog.about,
      currency: catalog.currency,
      paypal: paypal ? (paypal.sandbox ? "sandbox" : "live") : null,
      products: catalog.products.length,
    }),
  );

  app.get("/catalog", (c) => {
    const ask = c.req.query("q") ?? "";
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 8) || 8, 1), 50);
    const products = search(catalog, ask, limit).map((product) => ({ sku: product.sku, name: product.name, price: product.price, currency: catalog.currency, tags: product.tags }));
    return c.json({ shop, products });
  });

  /** Prices a cart from the catalog: the agent says what and how many, the shop says what it costs. */
  app.post("/carts", async (c) => {
    const { items } = await body(c);
    if (!Array.isArray(items) || items.length === 0) return fail(c, 400, 'Send the cart as { "items": [{ "sku": "beans-house", "qty": 2 }] }.');
    const lines = new Map<string, number>();
    for (const raw of items) {
      const item = (raw ?? {}) as { sku?: unknown; qty?: unknown };
      const product = catalog.products.find((one) => one.sku === item.sku);
      if (!product) return fail(c, 400, `${shop.name} has nothing with the sku ${JSON.stringify(item.sku)}; GET /catalog lists what it sells.`);
      const qty = item.qty ?? 1;
      if (typeof qty !== "number" || !Number.isInteger(qty) || qty < 1 || qty > 99) return fail(c, 400, `Say how many of "${product.name}" as a whole number from 1 to 99.`);
      lines.set(product.sku, (lines.get(product.sku) ?? 0) + qty);
    }
    if (lines.size > MAX_ITEMS) return fail(c, 400, `A cart has at most ${MAX_ITEMS} different things in it.`);
    let total = 0;
    const priced: Cart["items"][number][] = [];
    for (const [sku, qty] of lines) {
      if (qty > 99) return fail(c, 400, "At most 99 of one thing.");
      const product = catalog.products.find((one) => one.sku === sku)!;
      total += cents(product.price)! * qty;
      priced.push({ sku, name: product.name, qty, price: product.price });
    }
    if (total > MAX_CART_CENTS) return fail(c, 400, `${shop.name} takes carts of up to ${amountText(decimal(MAX_CART_CENTS), catalog.currency)}.`);
    const cart = store.addCart({ items: priced, total: decimal(total), currency: catalog.currency, expires: signableTime(now() + cartMs) });
    return c.json({ cart: cartView(cart, shop) }, 201);
  });

  app.get("/carts/:id", (c) => {
    const cart = store.cart(c.req.param("id"));
    return cart ? c.json({ cart: cartView(cart, shop) }) : fail(c, 404, "There's no such cart.");
  });

  /** Starts linking a key: the text it signs to say "this key pays for my carts here". */
  app.post("/links", async (c) => {
    let key: string;
    try {
      key = keyText(String((await body(c)).key ?? ""));
    } catch (error) {
      return fail(c, 400, error instanceof Error ? error.message : String(error));
    }
    const request: LinkRequest = { v: 1, kind: "link", id: signableId("link"), shop, expires: signableTime(now() + LINK_MINUTES * 60_000) };
    const link = store.addLink(key, signableText(request), request.id, request.expires);
    return c.json({ link: { id: link.id, text: link.text, expires: link.expires } }, 201);
  });

  /** The key signed the link: PayPal's page for saving the payer's PayPal with the shop, to open next. */
  app.post("/links/:id/signed", async (c) => {
    const link = store.link(c.req.param("id"));
    if (!link) return fail(c, 404, "There's no such link.");
    if (link.status !== "unsigned") return fail(c, 409, `This link is already ${link.status}.`);
    if (Date.parse(link.expires) <= now()) return fail(c, 410, "This link expired before it was signed; start again.");
    const { signature, returnUrl } = await body(c);
    if (!signedBy(link.text, String(signature ?? ""), link.key)) return fail(c, 401, "That isn't this key's signature of the link.");
    if (returnUrl !== undefined && !returnTo(returnUrl)) return fail(c, 400, "returnUrl should be an http(s) address.");
    if (!paypal) return noPayPal(c);
    const back = `${publicUrl}/links/${link.id}/back`;
    try {
      const started = await paypal.startSaving({
        returnUrl: back,
        cancelUrl: withQuery(back, { cancelled: "1" }),
        brand: shop.name,
        description: `${shop.name} charges this PayPal only for carts your key signs`,
        requestId: link.id,
      });
      if (!store.moveLink(link.id, "unsigned", { status: "approving", setupTokenId: started.setupTokenId, ...(returnTo(returnUrl) ? { returnUrl: returnTo(returnUrl)! } : {}) })) return fail(c, 409, "This link was signed twice at once.");
      return c.json({ link: linkView(store.link(link.id)!, null), approveUrl: started.approveUrl });
    } catch (error) {
      return fail(c, 502, error instanceof Error ? error.message : String(error));
    }
  });

  /** Where PayPal sends the payer back: their PayPal is saved, and linked to the key that signed. */
  app.get("/links/:id/back", async (c) => {
    const link = store.link(c.req.param("id"));
    const done = (title: string, words: string, query: Record<string, string>, status: 200 | 400 | 409 | 502 = 200) => {
      const target = link?.returnUrl;
      if (target) return c.redirect(withQuery(target, { ...query, shop: shop.id }), 303);
      return c.html(page(title, words), status);
    };
    if (!link) return c.html(page("Link not found", "This link isn't one this shop made."), 404);
    if (link.status === "linked") return done("Already linked", `Your PayPal is linked to your key at ${shop.name}.`, { paypal: "linked" });
    if (link.status !== "approving" || !link.setupTokenId) return done("Can't link this", `This link is ${link.status}; start again from PureStrings.`, { paypal: link.status }, 409);
    if (c.req.query("cancelled")) {
      store.moveLink(link.id, "approving", { status: "cancelled" });
      return done("Not linked", "You didn't save your PayPal with the shop, so nothing was linked.", { paypal: "cancelled" });
    }
    const token = c.req.query("approval_token_id");
    if (token && token !== link.setupTokenId) return done("Can't link this", "PayPal sent back a different approval than this link's.", { paypal: "failed" }, 400);
    if (!paypal) return c.html(page("Can't link this", `${shop.name}'s PayPal isn't set up.`), 503);
    try {
      const saved = await paypal.savePayPal(link.setupTokenId, `save-${link.id}`);
      store.saveCustomer(link.key, saved.vaultId, saved.email);
      store.moveLink(link.id, "approving", { status: "linked" });
      return done("PayPal linked", `${shop.name} will charge ${saved.email ?? "your PayPal"} only for carts your key signs. You can close this page.`, { paypal: "linked" });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      store.moveLink(link.id, "approving", { status: "failed", error: why });
      return done("Couldn't link PayPal", why, { paypal: "failed" }, 502);
    }
  });

  app.get("/links/:id", (c) => {
    const link = store.link(c.req.param("id"));
    if (!link) return fail(c, 404, "There's no such link.");
    return c.json({ link: linkView(link, link.status === "linked" ? (store.customer(link.key)?.email ?? null) : null) });
  });

  /** Whether a key is linked here, by its key: so PureStrings can say so before it asks the key to sign. */
  app.post("/boards", async (c) => {
    const { key } = await body(c);
    let customer = null;
    try {
      customer = store.customer(keyText(String(key ?? "")));
    } catch {
      // Not a key: not linked.
    }
    return c.json({ linked: Boolean(customer), paypal: customer?.email ?? null, since: customer?.linkedAt ?? null });
  });

  paymentRoutes(app, { catalog, store, paypal, shop, now, noPayPal, admin, ...(options.webhookId ? { webhookId: options.webhookId } : {}) });

  return app;
}

/**
 * Bean & Leaf inside PureStrings' server, for a one-service demo: open when a PayPal app is set up
 * (PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET), or with PURESTRINGS_SHOP=on to look around without one; PURESTRINGS_SHOP=off
 * keeps it shut. Null when it's shut.
 */
export function demoShop(env: NodeJS.ProcessEnv, where: { readonly publicUrl: string; readonly db: string; readonly fetcher?: typeof fetch }): { readonly app: Hono; readonly name: string; readonly paypal: "sandbox" | "live" | null } | null {
  const setting = env.PURESTRINGS_SHOP?.trim().toLowerCase();
  const paypal = PayPal.fromEnv(env, where.fetcher);
  if (setting === "off" || (!paypal && setting !== "on")) return null;
  const catalog = readCatalog(env.SHOP_CATALOG?.trim() || new URL("../catalog.json", import.meta.url));
  const app = shopApp({
    catalog,
    store: new ShopStore(where.db),
    paypal,
    publicUrl: where.publicUrl,
    ...(env.SHOP_ADMIN_TOKEN?.trim() ? { adminToken: env.SHOP_ADMIN_TOKEN.trim() } : {}),
    ...(env.PAYPAL_WEBHOOK_ID?.trim() ? { webhookId: env.PAYPAL_WEBHOOK_ID.trim() } : {}),
  });
  return { app, name: catalog.name, paypal: paypal ? (paypal.sandbox ? "sandbox" : "live") : null };
}
