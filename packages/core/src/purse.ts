import { agentKey, allowanceFor } from "./allowances.ts";
import { type Allowance, expired, keyText, MAX_ALLOWANCE_DAYS, parseSignable, type Payment, type Period, signableId, signableText, signableTime, signedBy } from "./countersign.ts";
import { cents, decimal } from "./paypal.ts";
import { type CartLine, type ShopClient, shopClient, ShopError, type ShopOrder } from "./shop.ts";
import type { Signer, SignRequest, Store } from "./store.ts";

/**
 * The purse: what PureStrings does with money. An assistant asks to buy; the shop prices the cart; a cart that fits
 * one of your allowances is paid at once, with PureStrings' own key, and any other waits for your key's signature
 * of exactly that cart. Your key also links itself to your PayPal at a shop, and signs the allowances. Nothing here
 * pays without a signature: your key's, or PureStrings' under an allowance your key signed, and the shop checks both.
 */

/** How long a payment waits for your key's signature before it has to be asked for again. */
export const PAY_MINUTES = 10;

/** What PureStrings keeps with a link or an allowance: the key it's for, where PayPal sends you back, PayPal's page, the PayPal saved. */
export interface LinkResult {
  readonly key: string;
  readonly returnUrl?: string;
  readonly approveUrl?: string;
  readonly paypal?: string | null;
}

function linkResult(request: SignRequest): LinkResult {
  const result = (request.result ?? {}) as Partial<LinkResult>;
  return { key: String(result.key ?? ""), ...(typeof result.returnUrl === "string" ? { returnUrl: result.returnUrl } : {}), ...(typeof result.approveUrl === "string" ? { approveUrl: result.approveUrl } : {}), ...(result.paypal !== undefined ? { paypal: result.paypal } : {}) };
}

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface PurseOptions {
  /** How a shop is reached by its address; tests answer it in the same process. */
  readonly shops?: (url: string) => ShopClient;
  readonly now?: () => number;
}

export class Purse {
  private readonly store: Store;
  private readonly shops: (url: string) => ShopClient;
  private readonly now: () => number;

  constructor(store: Store, options: PurseOptions = {}) {
    this.store = store;
    this.shops = options.shops ?? ((url) => shopClient(url));
    this.now = options.now ?? Date.now;
  }

  /** The shop at an address. */
  shop(url: string): ShopClient {
    return this.shops(url);
  }

  // Buying -----------------------------------------------------------------------------------------------

  /**
   * An assistant asks to buy these lines at a shop. The shop prices them, and the payment is written, naming who
   * asked. One that fits an allowance of yours is paid now; the shop holds it to the allowance, and when it says no,
   * or nothing fits, the payment waits for your key. Throws when the shop won't price it.
   */
  async buy(input: { readonly shop: string; readonly items: readonly CartLine[]; readonly agent?: string | null }): Promise<SignRequest> {
    const shop = this.shops(input.shop);
    const cart = await shop.price(input.items);
    const until = Math.min(Date.parse(cart.expires), this.now() + PAY_MINUTES * 60_000);
    if (!(until > this.now() + 60_000)) throw new Error(`${cart.shop.name}'s prices for that cart don't hold long enough to be signed; try again.`);
    const agent = input.agent?.trim().slice(0, 40) || null;
    const payment: Payment = {
      v: 1,
      kind: "buy",
      id: signableId("pay"),
      ...(agent ? { by: agent } : {}),
      shop: cart.shop,
      cart: cart.id,
      items: cart.items.map((line) => ({ name: line.name, qty: line.qty, price: line.price })),
      total: cart.total,
      currency: cart.currency,
      expires: signableTime(until),
    };
    const text = signableText(payment);
    try {
      parseSignable(text);
    } catch (error) {
      throw new Error(`${cart.shop.name}'s cart can't be signed: ${failure(error)}`);
    }
    const fits = allowanceFor(this.store, shop.url, payment.total, payment.currency, this.now());
    if (fits) {
      const under: Payment = { ...payment, id: signableId("pay"), allow: fits.allowance.id };
      const underText = signableText(under);
      const own = agentKey(this.store);
      this.store.addSignRequest({ id: under.id, kind: "buy", text: underText, shop: shop.url, expires: under.expires, agent });
      this.store.markSigned(under.id, own.sign(underText), own.key);
      try {
        return await this.checkout(this.store.signRequest(under.id)!);
      } catch (error) {
        // Stopped at the shop, or over its limits there: your key is asked instead.
        if (!(error instanceof ShopError) || error.status !== 403) throw error;
      }
    }
    return this.store.addSignRequest({ id: payment.id, kind: "buy", text, shop: shop.url, expires: payment.expires, agent });
  }

  /**
   * Your key's signature of something waiting for it, taken at once; the shop is asked in the background. Throws
   * straight away when it isn't taken (another key's, not of exactly this text, too late).
   */
  sign(id: string, signature: string, key: string): void {
    const kind = this.store.signRequest(id)?.kind;
    if (kind === "link" || kind === "allow") this.linkable(id, signature, key, kind);
    else this.payable(id, signature, key);
    const done = kind === "link" ? this.signLink(id, signature, key) : kind === "allow" ? this.signAllowance(id, signature, key) : this.signPayment(id, signature, key);
    void done.catch((error: unknown) => console.error(`[purestrings] signature for ${id}:`, failure(error)));
  }

  /** Your key's signature of a payment: checked, then sent to the shop, which charges your PayPal for exactly it. */
  async signPayment(id: string, signature: string, key: string): Promise<SignRequest> {
    const { request, signer } = this.payable(id, signature, key);
    if (!this.store.markSigned(request.id, signature, signer.key)) throw new Error("That payment was already signed or answered.");
    return this.checkout(this.store.signRequest(request.id)!);
  }

  /** No, from your key or from you: the payment, link or allowance waiting is declined. */
  decline(id: string): SignRequest {
    const request = this.store.signRequest(id);
    if (!request) throw new Error(`There's nothing by the id ${id}.`);
    if (!this.store.moveSignRequest(id, "waiting", { status: "declined" })) throw new Error(`That was already ${request.status}.`);
    return this.store.signRequest(id)!;
  }

  /** Sends a signed payment to the shop again, when the shop couldn't be reached: it's never charged twice. */
  async retry(id: string): Promise<SignRequest> {
    const request = this.store.signRequest(id);
    if (!request || request.kind !== "buy" || request.status !== "signed") throw new Error("Only a signed payment the shop hasn't answered can be sent again.");
    return this.checkout(request);
  }

  /** Sends the shop a payment that's signed, and keeps what it answers: paid, or failed with why. */
  private async checkout(request: SignRequest): Promise<SignRequest> {
    let order: ShopOrder;
    try {
      order = await this.shops(request.shop).checkout({ text: request.text, signature: request.signature!, key: request.key! });
    } catch (error) {
      // The shop said no: asked again only with a new signature. It couldn't be reached: retry sends the same one.
      if (error instanceof ShopError) this.store.moveSignRequest(request.id, "signed", { status: "failed", error: error.message });
      throw error;
    }
    if (order.status === "charging") throw new Error("The shop is still waiting to hear from PayPal. Try again in a moment: the same payment is never charged twice.");
    if (order.status !== "paid" && order.status !== "pending") {
      this.store.moveSignRequest(request.id, "signed", { status: "failed", error: order.error ?? order.status });
      throw new Error(`PayPal didn't take the payment${order.error ? `: ${order.error}` : ` (the order is ${order.status})`}.`);
    }
    this.store.moveSignRequest(request.id, "signed", { status: "paid", result: order });
    return this.store.signRequest(request.id)!;
  }

  /** The waiting payment a signature is for, once it's checked: one of your keys', of exactly its text, in time. */
  private payable(id: string, signature: string, key: string): { request: SignRequest; signer: Signer } {
    const request = this.store.signRequest(id);
    if (!request || request.kind !== "buy") throw new Error(`There's no payment ${id} waiting to be signed.`);
    if (request.status !== "waiting") throw new Error(`That payment was already ${request.status}.`);
    const signer = this.signedBy(request, signature, key);
    if (expired(parseSignable(request.text), this.now())) {
      this.store.moveSignRequest(id, "waiting", { status: "expired" });
      throw new Error(`That payment expired before it was signed (it waits ${PAY_MINUTES} minutes); ask for it again.`);
    }
    return { request, signer };
  }

  /** The key of yours whose signature of exactly this request's text it is; throws when it isn't one. */
  private signedBy(request: SignRequest, signature: string, key: string): Signer {
    let signer;
    try {
      signer = this.store.signer(keyText(key));
    } catch {
      signer = null;
    }
    if (!signer) throw new Error("That key isn't one of yours. Add it first.");
    const what = request.kind === "link" ? "link" : request.kind === "allow" ? "allowance" : "payment";
    if (!signedBy(request.text, signature, signer.key)) throw new Error(`That isn't your key's signature of this ${what}, so it wasn't taken.`);
    return signer;
  }

  // Linking a key to your PayPal at a shop ----------------------------------------------------------------

  /**
   * Starts linking one of your keys to your PayPal at a shop. The shop writes what the key signs to say "this key
   * pays for my carts here"; it waits for the key like a payment does. `returnUrl` is where PayPal sends you back
   * once your PayPal is saved with the shop.
   */
  async startLink(shopUrl: string, key: string, returnUrl?: string): Promise<SignRequest> {
    const signer = this.yours(key);
    const shop = this.shops(shopUrl);
    const link = await shop.startLink(signer.key);
    let signable;
    try {
      signable = parseSignable(link.text);
    } catch (error) {
      throw new Error(`The shop's link can't be signed: ${failure(error)}`);
    }
    if (signable.kind !== "link" || signable.id !== link.id) throw new Error("The shop's link isn't a link to sign: it says something else.");
    if (expired(signable, this.now() + 60_000)) throw new Error("The shop's link doesn't hold long enough to be signed; try again.");
    return this.store.addSignRequest({ id: link.id, kind: "link", text: link.text, shop: shop.url, expires: signable.expires, result: { key: signer.key, ...(returnUrl ? { returnUrl } : {}) } });
  }

  /**
   * Takes your key's signature of a link and gives it to the shop, which answers with PayPal's page for saving your
   * PayPal with it: open that next. Taken only from the key the link is for, of exactly its text, in time.
   */
  async signLink(id: string, signature: string, key: string): Promise<SignRequest> {
    const { request, signer, held } = this.linkable(id, signature, key, "link");
    if (!this.store.markSigned(id, signature, signer.key)) throw new Error("That link was already signed or answered.");
    try {
      const { approveUrl } = await this.shops(request.shop).signedLink(id, signature, held.returnUrl);
      if (!approveUrl) throw new Error("The shop didn't say where to save your PayPal with it.");
      this.store.moveSignRequest(id, "signed", { status: "signed", result: { ...held, approveUrl } });
    } catch (error) {
      this.store.moveSignRequest(id, "signed", { status: "failed", error: failure(error) });
      throw error;
    }
    return this.store.signRequest(id)!;
  }

  /** How a signed link is going at the shop: linked once PayPal has saved your PayPal there, failed if it didn't. */
  async checkLink(id: string): Promise<SignRequest> {
    const request = this.store.signRequest(id);
    if (!request || request.kind !== "link") throw new Error(`There's no link ${id}.`);
    if (request.status !== "signed") return request;
    const link = await this.shops(request.shop).link(id);
    if (link.status === "linked") this.store.moveSignRequest(id, "signed", { status: "linked", result: { ...linkResult(request), paypal: link.paypal } });
    else if (link.status === "cancelled") this.store.moveSignRequest(id, "signed", { status: "declined", error: "You didn't save your PayPal with the shop, so nothing was linked." });
    else if (link.status === "failed") this.store.moveSignRequest(id, "signed", { status: "failed", error: link.error ?? "PayPal didn't save your PayPal with the shop." });
    return this.store.signRequest(id)!;
  }

  /** The waiting link or allowance a signature is for, once it's checked: the key it's for, of exactly its text, in time. */
  private linkable(id: string, signature: string, key: string, kind: "link" | "allow"): { request: SignRequest; signer: Signer; held: LinkResult } {
    const what = kind === "link" ? "link" : "allowance";
    const request = this.store.signRequest(id);
    if (!request || request.kind !== kind) throw new Error(`There's no ${what} ${id} waiting to be signed.`);
    if (request.status !== "waiting") throw new Error(`That ${what} was already ${request.status}.`);
    const signer = this.signedBy(request, signature, key);
    const held = linkResult(request);
    if (held.key !== signer.key) throw new Error(`That ${what} is for another of your keys, not ${signer.name}.`);
    if (expired(parseSignable(request.text), this.now())) {
      this.store.moveSignRequest(id, "waiting", { status: "expired" });
      throw new Error(`That ${what} expired before your key signed it; start again.`);
    }
    return { request, signer, held };
  }

  /** One of your keys, by its key; throws when it isn't one. */
  private yours(key: string): Signer {
    let signer;
    try {
      signer = this.store.signer(keyText(key));
    } catch {
      signer = null;
    }
    if (!signer) throw new Error("That key isn't one of yours. Add it first.");
    return signer;
  }

  // Allowances: your key says once that PureStrings may pay at a shop on its own, within limits -------------

  /**
   * Starts an allowance at a shop for one of your keys: the text it signs, with the limits and PureStrings' own key.
   * Once your key signs it, the shop is given it, and from then on carts there that fit it are paid without asking.
   */
  async startAllowance(shopUrl: string, key: string, limits: { readonly for: string; readonly each: string; readonly total: string; readonly per: Period; readonly days: number }): Promise<SignRequest> {
    const signer = this.yours(key);
    const each = cents(limits.each);
    const total = cents(limits.total);
    if (each === null || each === 0 || total === null || total === 0) throw new Error("Give the limits as amounts, like 20.00 a time and 50.00 in all.");
    if (!Number.isInteger(limits.days) || limits.days < 1 || limits.days > MAX_ALLOWANCE_DAYS) throw new Error(`An allowance lasts from 1 to ${MAX_ALLOWANCE_DAYS} days.`);
    const shop = this.shops(shopUrl);
    const about = await shop.about();
    const allowance: Allowance = {
      v: 1,
      kind: "allow",
      id: signableId("allow"),
      shop: about.shop,
      for: limits.for.trim().slice(0, 40),
      agent: agentKey(this.store).key,
      each: decimal(each),
      total: decimal(total),
      per: limits.per,
      currency: about.currency,
      expires: signableTime(this.now() + limits.days * 86_400_000),
    };
    const text = signableText(allowance);
    parseSignable(text);
    return this.store.addSignRequest({ id: allowance.id, kind: "allow", text, shop: shop.url, expires: allowance.expires, result: { key: signer.key } });
  }

  /** Takes your key's signature of an allowance and gives it to the shop; it's active once the shop takes it. */
  async signAllowance(id: string, signature: string, key: string): Promise<SignRequest> {
    const { request, signer, held } = this.linkable(id, signature, key, "allow");
    if (!this.store.markSigned(id, signature, signer.key)) throw new Error("That allowance was already signed or answered.");
    try {
      const taken = await this.shops(request.shop).allowance({ text: request.text, signature, key: signer.key });
      this.store.moveSignRequest(id, "signed", { status: "active", result: { ...held, shop: taken } });
    } catch (error) {
      this.store.moveSignRequest(id, "signed", { status: "failed", error: failure(error) });
      throw error;
    }
    return this.store.signRequest(id)!;
  }

  /**
   * Stops an allowance: PureStrings pays nothing more under it from now, and tells the shop, signed with its own key,
   * so the shop refuses it too. Stopped here even when the shop can't be reached; that's said, to try again.
   */
  async stopAllowance(id: string): Promise<SignRequest> {
    const request = this.store.signRequest(id);
    if (!request || request.kind !== "allow") throw new Error(`There's no allowance ${id}.`);
    if (request.status === "waiting") return this.decline(id);
    if (request.status !== "active" && request.status !== "stopped") throw new Error(`That allowance is ${request.status}, so there's nothing to stop.`);
    this.store.moveSignRequest(id, "active", { status: "stopped" });
    try {
      await this.shops(request.shop).stopAllowance(id, agentKey(this.store).sign(`stop ${id}`));
    } catch (error) {
      throw new Error(`PureStrings won't pay under it any more, but the shop didn't hear so: ${failure(error)} Stop it again to tell the shop.`);
    }
    return this.store.signRequest(id)!;
  }
}
