import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { agentKey, parseSignable, PayPal, Purse, shopClient, Store } from "@purestrings/core";
import { readCatalog, ShopStore, shopApp } from "@purestrings/shop";

/**
 * The purse paying Bean & Leaf, the demo shop, answering in this process. What's refused is checked without
 * PayPal: the key is linked straight in the shop's own database. Saving a payer's PayPal and charging it run
 * against PayPal's sandbox with PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_SANDBOX_VAULT_ID (a payer's
 * PayPal saved with the app), and are skipped without.
 */
const SHOP_URL = "http://localhost:7700/shop";
const ADMIN = "shop-admin-token-123";
const CATALOG = readCatalog(new URL("../../shop/catalog.json", import.meta.url));
const vaultId = process.env.PAYPAL_SANDBOX_VAULT_ID?.trim();
const sandbox = PayPal.fromEnv(process.env);
const noPayPal = !sandbox && "set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET for PayPal's sandbox";
const noVault = !(sandbox && vaultId) && "set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_SANDBOX_VAULT_ID to charge PayPal's sandbox";

/** A key as the button or the browser makes one: its raw P-256 point, and r‖s signatures. */
function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

function setUp(paypal: PayPal | null = null) {
  let clock = Date.now();
  const shopStore = new ShopStore();
  const app = shopApp({ catalog: CATALOG, store: shopStore, paypal, publicUrl: SHOP_URL, adminToken: ADMIN, now: () => clock });
  const reach = ((url: string | URL | Request, init?: RequestInit) => app.request(String(url).slice(SHOP_URL.length) || "/", init)) as typeof fetch;
  const store = new Store();
  const purse = new Purse(store, { shops: (url) => shopClient(url, reach), now: () => clock });
  const mine = keyPair();
  store.addSigner({ key: mine.key, name: "Desk key" });
  /** Your key, linked to a payer's saved PayPal at the shop (the sandbox payer's, when there's one to charge). */
  const linked = () => shopStore.saveCustomer(mine.key, vaultId ?? "VAULT-NOT-CHARGED", "buyer@example.com");
  const shopSays = async (path: string, method = "GET") => (await (await app.request(path, { method, headers: { authorization: `Bearer ${ADMIN}` } })).json()) as Record<string, any>;
  return { store, purse, mine, linked, shopSays, tick: (ms: number) => (clock += ms) };
}

describe("an assistant buying with the purse", () => {
  it("gets a cart the shop priced, waiting for your key, with the assistant's name in what's signed", async () => {
    const { purse } = setUp();
    const request = await purse.buy({ shop: SHOP_URL, items: [{ sku: "beans-house", qty: 2 }], agent: "OpenClaw" });
    assert.deepEqual([request.kind, request.status, request.agent], ["buy", "waiting", "OpenClaw"]);
    const payment = parseSignable(request.text);
    assert.equal(payment.kind, "buy");
    if (payment.kind !== "buy") return;
    assert.deepEqual([payment.by, payment.total, payment.shop.name, payment.items[0]?.qty], ["OpenClaw", "24.00", "Bean & Leaf", 2]);
    assert.ok(Date.parse(payment.expires) <= Date.now() + 10 * 60_000 + 1000, "it waits ten minutes at most");
    await assert.rejects(purse.buy({ shop: SHOP_URL, items: [{ sku: "unicorn", qty: 1 }] }), /unicorn/);
  });

  it("takes only your key's signature of exactly that payment, and only in time", async () => {
    const { purse, mine, tick, store } = setUp();
    const request = await purse.buy({ shop: SHOP_URL, items: [{ sku: "filters", qty: 1 }], agent: "Hermes" });
    const stranger = keyPair();
    await assert.rejects(purse.signPayment(request.id, stranger.sign(request.text), stranger.key), /isn't one of yours/);
    await assert.rejects(purse.signPayment(request.id, stranger.sign(request.text), mine.key), /isn't your key's signature/);
    await assert.rejects(purse.signPayment(request.id, mine.sign(`${request.text} `), mine.key), /isn't your key's signature/);
    tick(11 * 60_000);
    await assert.rejects(purse.signPayment(request.id, mine.sign(request.text), mine.key), /expired/);
    assert.equal(store.signRequest(request.id)?.status, "expired");
  });

  it("sends a signed payment to the shop, which says plainly when it can't take PayPal; a no is a no", async () => {
    const { purse, mine, linked, store } = setUp();
    linked();
    const request = await purse.buy({ shop: SHOP_URL, items: [{ sku: "mug", qty: 1 }] });
    await assert.rejects(purse.signPayment(request.id, mine.sign(request.text), mine.key), /PAYPAL_CLIENT_ID/);
    assert.equal(store.signRequest(request.id)?.status, "failed");
    const other = await purse.buy({ shop: SHOP_URL, items: [{ sku: "mug", qty: 1 }] });
    assert.equal(purse.decline(other.id).status, "declined");
    assert.throws(() => purse.decline(other.id), /already declined/);
    await assert.rejects(purse.signPayment(other.id, mine.sign(other.text), mine.key), /already declined/);
  });

  it("pays your linked PayPal for exactly the cart your key signed", { skip: noVault }, async () => {
    const { purse, mine, linked, shopSays } = setUp(sandbox);
    linked();
    const request = await purse.buy({ shop: SHOP_URL, items: [{ sku: "filters", qty: 1 }], agent: "OpenClaw" });
    const paid = await purse.signPayment(request.id, mine.sign(request.text), mine.key);
    assert.equal(paid.status, "paid", paid.error ?? "");
    const order = paid.result as { id: string; status: string };
    assert.equal(order.status, "paid");
    assert.equal((await shopSays(`/orders/${order.id}/refund`, "POST")).order?.status, "refunded");
  });
});

describe("an allowance your key signs", () => {
  it("names the purse's own key and your limits, and is active once the shop takes it", async () => {
    const { purse, mine, linked, store, shopSays } = setUp();
    linked();
    await assert.rejects(purse.startAllowance(SHOP_URL, mine.key, { for: "Coffee", each: "lots", total: "50", per: "week", days: 7 }), /as amounts/);
    await assert.rejects(purse.startAllowance(SHOP_URL, mine.key, { for: "Coffee", each: "20", total: "50", per: "week", days: 40 }), /1 to 31 days/);
    const started = await purse.startAllowance(SHOP_URL, mine.key, { for: "Coffee", each: "30", total: "50", per: "week", days: 7 });
    const allowance = parseSignable(started.text);
    assert.equal(allowance.kind, "allow");
    if (allowance.kind !== "allow") return;
    assert.deepEqual([allowance.agent, allowance.each, allowance.total, allowance.per], [agentKey(store).key, "30.00", "50.00", "week"]);
    const active = await purse.signAllowance(started.id, mine.sign(started.text), mine.key);
    assert.equal(active.status, "active", active.error ?? "");
    assert.equal((await shopSays(`/allowances/${started.id}`)).allowance?.status, "active");

    // Over the limit for one payment: your key is asked, as for any other.
    const over = await purse.buy({ shop: SHOP_URL, items: [{ sku: "beans-house", qty: 3 }], agent: "OpenClaw" });
    assert.equal(over.status, "waiting");

    // Stopped here and at the shop: nothing more is paid under it.
    assert.equal((await purse.stopAllowance(started.id)).status, "stopped");
    assert.equal((await shopSays(`/allowances/${started.id}`)).allowance?.status, "stopped");
    assert.equal((await purse.buy({ shop: SHOP_URL, items: [{ sku: "filters", qty: 1 }] })).status, "waiting");
  });

  it("pays carts that fit it at once, without asking your key", { skip: noVault }, async () => {
    const { purse, mine, linked, store, shopSays } = setUp(sandbox);
    linked();
    const started = await purse.startAllowance(SHOP_URL, mine.key, { for: "Coffee", each: "20", total: "50", per: "week", days: 7 });
    await purse.signAllowance(started.id, mine.sign(started.text), mine.key);
    const paid = await purse.buy({ shop: SHOP_URL, items: [{ sku: "filters", qty: 1 }], agent: "Hermes" });
    assert.equal(paid.status, "paid", paid.error ?? "");
    assert.equal(paid.key, agentKey(store).key, "signed by the purse's key, under the allowance");
    const payment = parseSignable(paid.text);
    assert.equal(payment.kind === "buy" && payment.allow, started.id);
    const order = paid.result as { id: string };
    assert.equal((await shopSays(`/orders/${order.id}/refund`, "POST")).order?.status, "refunded");
  });
});

describe("linking your key to your PayPal at a shop", () => {
  it("takes only the key it's for, and says plainly when the shop can't take PayPal", async () => {
    const { purse, mine, store } = setUp();
    const other = keyPair();
    store.addSigner({ key: other.key, name: "Phone" });
    const started = await purse.startLink(SHOP_URL, mine.key);
    assert.deepEqual([started.kind, started.status], ["link", "waiting"]);
    await assert.rejects(purse.signLink(started.id, other.sign(started.text), other.key), /for another of your keys/);
    await assert.rejects(purse.signLink(started.id, mine.sign(started.text), mine.key), /PAYPAL_CLIENT_ID/);
    assert.equal(store.signRequest(started.id)?.status, "failed");
    await assert.rejects(purse.startLink(SHOP_URL, keyPair().key), /isn't one of yours/);
  });

  it("gives PayPal's own page to save your PayPal with the shop", { skip: noPayPal }, async () => {
    const { purse, mine } = setUp(sandbox);
    const started = await purse.startLink(SHOP_URL, mine.key, "http://purestrings.test/keys");
    const signed = await purse.signLink(started.id, mine.sign(started.text), mine.key);
    assert.equal(signed.status, "signed", signed.error ?? "");
    assert.match(String((signed.result as { approveUrl?: string }).approveUrl), /^https:\/\/www\.sandbox\.paypal\.com\//);
    assert.equal((await purse.checkLink(started.id)).status, "signed", "not linked until you've said yes at PayPal");
  });
});
