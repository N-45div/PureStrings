import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { type Payment, PayPal, signableText } from "@purestrings/core";
import { parseCatalog, readCatalog, search } from "../src/catalog.ts";
import { demoShop, shopApp } from "../src/shop.ts";
import { ShopStore } from "../src/store.ts";

/**
 * Bean & Leaf, the demo shop. Every refusal is checked without PayPal: a key is linked straight in the shop's own
 * database. Charging, and saving a payer's PayPal, run against PayPal's sandbox with PAYPAL_CLIENT_ID,
 * PAYPAL_CLIENT_SECRET and PAYPAL_SANDBOX_VAULT_ID (a payer's PayPal saved with the app), and are skipped without.
 */
const CATALOG = readCatalog(new URL("../catalog.json", import.meta.url));
const SHOP = { id: "shop.test", name: "Bean & Leaf" };
const START = Date.parse("2026-10-29T10:00:00Z");
const vaultId = process.env.PAYPAL_SANDBOX_VAULT_ID?.trim();
const sandbox = PayPal.fromEnv(process.env);
const noVault = !(sandbox && vaultId) && "set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_SANDBOX_VAULT_ID to charge PayPal's sandbox";

/** A key as the key makes one: its raw P-256 point, and r‖s signatures. */
function key() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key: raw, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

function shop(options: { readonly paypal?: PayPal | null; readonly adminToken?: string; readonly clock?: number } = {}) {
  let clock = options.clock ?? START;
  const store = new ShopStore();
  const app = shopApp({ catalog: CATALOG, store, paypal: options.paypal ?? null, publicUrl: "http://shop.test/", now: () => clock, ...(options.adminToken ? { adminToken: options.adminToken } : {}) });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.request(path, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  /** A key linked to a payer's saved PayPal (the sandbox payer's, when there's one to charge). */
  const linked = () => {
    const signer = key();
    store.saveCustomer(signer.key, vaultId ?? "VAULT-NOT-CHARGED", "buyer@example.com");
    return signer;
  };
  /** A cart priced by the shop, and the payment PureStrings would write for it. */
  const cart = async (items: unknown = [{ sku: "beans-house", qty: 2 }, { sku: "filters", qty: 1 }], expires = "2026-10-29T10:15:00Z") => {
    const priced = await call("POST", "/carts", { items });
    const c = priced.body.cart;
    const payment: Payment = { v: 1, kind: "buy", id: `pay_${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`, shop: c.shop, cart: c.id, items: c.items.map((line: any) => ({ name: line.name, qty: line.qty, price: line.price })), total: c.total, currency: c.currency, expires };
    return { priced, payment, text: signableText(payment) };
  };
  return { store, call, linked, cart, tick: (ms: number) => (clock += ms) };
}

describe("the shop's catalog", () => {
  it("finds what fits the words asked for, best first", () => {
    assert.deepEqual(search(CATALOG, "coffee beans", 3).map((product) => product.sku), ["beans-house", "beans-ethiopia", "beans-decaf"]);
    assert.equal(search(CATALOG, "something to help me sleep")[0]?.sku, "tea-chamomile");
    assert.equal(search(CATALOG, "").length, 8);
    assert.deepEqual(search(CATALOG, "spaceship"), []);
  });

  it("is checked when it's read, and open to anyone with the shop's id as keys will see it", async () => {
    assert.throws(() => parseCatalog({ name: "X", currency: "USD", products: [{ sku: "a", name: "A", price: "1.234" }] }), /needs a price/);
    const { call } = shop();
    assert.deepEqual((await call("GET", "/")).body.shop, SHOP);
    assert.equal((await call("GET", "/catalog?q=chai")).body.products[0].sku, "tea-chai");
  });
});

describe("a cart", () => {
  it("is priced by the shop, from its own catalog", async () => {
    const { call } = shop();
    const priced = await call("POST", "/carts", { items: [{ sku: "beans-house", qty: 1 }, { sku: "filters" }, { sku: "beans-house", qty: 1 }] });
    assert.equal(priced.status, 201);
    assert.deepEqual(priced.body.cart.items, [
      { sku: "beans-house", name: "House blend beans, 1 lb", qty: 2, price: "12.00" },
      { sku: "filters", name: "Paper filters, 100", qty: 1, price: "8.50" },
    ]);
    assert.equal(priced.body.cart.total, "32.50");
    assert.equal(priced.body.cart.expires, "2026-10-29T10:30:00Z");
  });

  it("won't price what the shop doesn't sell, or silly amounts of it", async () => {
    const { call } = shop();
    assert.match((await call("POST", "/carts", { items: [{ sku: "unicorn", qty: 1 }] })).body.error, /nothing with the sku "unicorn"/);
    assert.match((await call("POST", "/carts", { items: [{ sku: "mug", qty: 0 }] })).body.error, /1 to 99/);
    assert.match((await call("POST", "/carts", {})).body.error, /Send the cart/);
  });
});

describe("linking a key to your PayPal", () => {
  it("takes only that key's signature of the link, and says plainly when PayPal isn't set up", async () => {
    const { call } = shop();
    const mine = key();
    const started = await call("POST", "/links", { key: mine.key });
    assert.equal(started.status, 201);
    assert.match((await call("POST", `/links/${started.body.link.id}/signed`, { signature: key().sign(started.body.link.text) })).body.error, /isn't this key's signature/);
    const signed = await call("POST", `/links/${started.body.link.id}/signed`, { signature: mine.sign(started.body.link.text) });
    assert.equal(signed.status, 503);
    assert.match(signed.body.error, /PAYPAL_CLIENT_ID/);
  });

  it("gives PayPal's own page to save your PayPal with the shop", { skip: !sandbox && "set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for PayPal's sandbox" }, async () => {
    const { call } = shop({ paypal: sandbox, clock: Date.now() });
    const mine = key();
    const started = await call("POST", "/links", { key: mine.key });
    const signed = await call("POST", `/links/${started.body.link.id}/signed`, { signature: mine.sign(started.body.link.text) });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    assert.match(signed.body.approveUrl, /^https:\/\/www\.sandbox\.paypal\.com\//);
  });
});

describe("checking out with a key's signature", () => {
  it("charges nothing when anything about the signature or the cart is off", async () => {
    const { call, linked, cart, tick } = shop();
    const signer = linked();
    const stranger = key();
    const { text, payment } = await cart();
    const signedBy = (what: string, by = signer) => ({ text: what, signature: by.sign(what), key: by.key });
    const refusals: [string, unknown, number, RegExp][] = [
      ["a key that isn't linked", signedBy(text, stranger), 401, /isn't linked/],
      ["another key's signature", { text, signature: stranger.sign(text), key: signer.key }, 401, /isn't this key's signature/],
      ["a different total", signedBy(signableText({ ...payment, items: [{ ...payment.items[0]!, price: "1.00" }, payment.items[1]!], total: "10.50" })), 409, /isn't this cart/],
      ["a gift card the shop never priced", signedBy(signableText({ ...payment, items: [...payment.items, { name: "Gift card, $200", qty: 1, price: "200.00" }], total: "232.50" })), 409, /isn't this cart/],
      ["another shop", signedBy(signableText({ ...payment, shop: { id: "bean-and-leaf.example", name: "Bean & Leaf" } })), 400, /not this shop/],
      ["a payment that outlives the cart's prices", signedBy(signableText({ ...payment, expires: "2026-10-29T11:00:00Z" })), 409, /outlives the cart/],
      ["a text written another way", signedBy(text.replace("{", "{ ")), 400, /one way/],
    ];
    for (const [what, sent, status, message] of refusals) {
      const answer = await call("POST", "/checkout", sent);
      assert.equal(answer.status, status, what);
      assert.match(answer.body.error, message, what);
    }
    // All of it right: on to PayPal (none here, so it stops there).
    assert.equal((await call("POST", "/checkout", signedBy(text))).status, 503);
    tick(16 * 60_000);
    assert.equal((await call("POST", "/checkout", signedBy(text))).status, 410);
  });

  it("charges the linked PayPal for exactly the cart the key signed, once, and refunds it", { skip: noVault }, async () => {
    const { call, linked, cart } = shop({ paypal: sandbox, adminToken: "shop-admin-token-123", clock: Date.now() });
    const signer = linked();
    const { text } = await cart([{ sku: "filters", qty: 1 }], new Date(Date.now() + 10 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"));
    const paid = await call("POST", "/checkout", { text, signature: signer.sign(text), key: signer.key });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    assert.equal(paid.body.order.status, "paid");
    const again = await call("POST", "/checkout", { text, signature: signer.sign(text), key: signer.key });
    assert.equal(again.body.order.id, paid.body.order.id, "the same signed payment is the same order, not a second charge");
    const refunded = await call("POST", `/orders/${paid.body.order.id}/refund`, {}, { authorization: "Bearer shop-admin-token-123" });
    assert.equal(refunded.body.order.status, "refunded", JSON.stringify(refunded.body));
  });
});

describe("the shop's own pages", () => {
  it("are closed without the shop's admin token", async () => {
    const { call } = shop({ adminToken: "shop-admin-token-123" });
    assert.equal((await call("GET", "/orders")).status, 401);
    assert.equal((await call("GET", "/orders", undefined, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await call("GET", "/orders", undefined, { authorization: "Bearer shop-admin-token-123" })).status, 200);
  });

  it("open inside PureStrings with a PayPal app set up, or when asked to, and stay shut otherwise", () => {
    const where = { publicUrl: "http://purestrings.test/shop", db: ":memory:" };
    assert.equal(demoShop({}, where), null);
    assert.equal(demoShop({ PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" }, where)?.paypal, "sandbox");
    assert.equal(demoShop({ PURESTRINGS_SHOP: "on" }, where)?.paypal, null);
    assert.equal(demoShop({ PURESTRINGS_SHOP: "off", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "secret" }, where), null);
  });
});
