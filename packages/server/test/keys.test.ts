import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { PayPal, Purse, shopClient, Store } from "@purestrings/core";
import { readCatalog, ShopStore, shopApp } from "@purestrings/shop";
import { KeyHub, type ToKey } from "../src/keys.ts";

/**
 * A key connected to PureStrings, saying what the button's firmware says, at Bean & Leaf answering in this process.
 * The charge runs against PayPal's sandbox with PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_SANDBOX_VAULT_ID.
 */
const SHOP_URL = "http://localhost:7700/shop";
const vaultId = process.env.PAYPAL_SANDBOX_VAULT_ID?.trim();
const sandbox = vaultId ? PayPal.fromEnv(process.env) : null;

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

function setUp(paypal: PayPal | null = null) {
  const shopStore = new ShopStore();
  const shop = shopApp({ catalog: readCatalog(new URL("../../shop/catalog.json", import.meta.url)), store: shopStore, paypal, publicUrl: SHOP_URL });
  const reach = ((url: string | URL | Request, init?: RequestInit) => shop.request(String(url).slice(SHOP_URL.length) || "/", init)) as typeof fetch;
  const store = new Store();
  const purse = new Purse(store, { shops: (url) => shopClient(url, reach) });
  const hub = new KeyHub(store, purse);
  /** A key connecting: what it's sent, and what it says back. */
  const connect = (deviceId: string | null = null) => {
    const heard: ToKey[] = [];
    const session = hub.connect((message) => heard.push(message), { name: "Desk button", version: "test", deviceId });
    const said = (message: object) => session.receive(JSON.stringify(message));
    const last = <T extends ToKey["type"]>(type: T) => heard.findLast((message) => message.type === type) as Extract<ToKey, { type: T }> | undefined;
    return { heard, said, last, close: session.close };
  };
  const until = async (check: () => unknown) => {
    for (let tries = 0; tries < 300 && !check(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(check(), "it happened");
  };
  return { store, purse, shopStore, connect, until };
}

describe("a key connected to PureStrings", () => {
  it("shows what's waiting for its signature, with the assistant that asked, and nothing when nothing is", async () => {
    const { purse, connect } = setUp();
    const key = connect();
    assert.equal(key.heard[0]?.type, "hello");
    assert.deepEqual(key.last("idle"), { type: "idle", spentTodayUsd: 0, nextRun: null, flows: [] });
    const asked = await purse.buy({ shop: SHOP_URL, items: [{ sku: "beans-house", qty: 2 }], agent: "OpenClaw" });
    const shown = key.last("sign");
    assert.deepEqual([shown?.id, shown?.flow, shown?.text, shown?.more], [asked.id, "OpenClaw asks", asked.text, 0]);
    assert.match(shown?.line ?? "", /^OpenClaw asks to pay \$24\.00 to Bean & Leaf/);
    key.close();
  });

  it("pins a browser's key by itself, and a button's to the button, so a swapped one signs nothing", () => {
    const { store, connect } = setUp();
    const browser = connect();
    const mine = keyPair();
    browser.said({ type: "hello", key: mine.key });
    assert.equal(browser.last("signer")?.ok, true);
    assert.equal(store.signer(mine.key)?.name, "Key in a browser");

    const { device } = store.addDevice("Desk button");
    const button = keyPair();
    connect(device.id).said({ type: "hello", key: button.key });
    assert.equal(store.signerForDevice(device.id)?.key, button.key);
    const swapped = connect(device.id);
    swapped.said({ type: "hello", key: keyPair().key });
    assert.equal(swapped.last("signer")?.ok, false);
    assert.match(swapped.last("signer")?.problem ?? "", /key changed since it was added/);
    swapped.said({ type: "sign", id: "pay_000000000001", signature: "x" });
    assert.match(swapped.last("error")?.message ?? "", /changed since it was added/);
  });

  it("signs, or says no, and is told how it went", async () => {
    const { store, purse, shopStore, connect, until } = setUp();
    const mine = keyPair();
    const key = connect();
    key.said({ type: "hello", key: mine.key });
    shopStore.saveCustomer(mine.key, "VAULT-NOT-CHARGED", "buyer@example.com");

    const first = await purse.buy({ shop: SHOP_URL, items: [{ sku: "mug", qty: 1 }], agent: "Hermes" });
    key.said({ type: "sign", id: first.id, signature: keyPair().sign(first.text) });
    assert.match(key.last("error")?.message ?? "", /isn't your key's signature/);
    key.said({ type: "decline", id: first.id });
    assert.deepEqual(key.last("answered"), { type: "answered", id: first.id, yes: false });
    assert.equal(store.signRequest(first.id)?.status, "declined");
    assert.deepEqual(key.heard.slice(-2).map((message) => message.type), ["idle", "answered"], "nothing left to sign");

    const second = await purse.buy({ shop: SHOP_URL, items: [{ sku: "mug", qty: 1 }], agent: "Hermes" });
    key.said({ type: "sign", id: second.id, signature: mine.sign(second.text) });
    assert.deepEqual(key.last("signed"), { type: "signed", id: second.id });
    await until(() => key.last("payment"));
    assert.equal(key.last("payment")?.status, "failed");
    assert.match(key.last("payment")?.line ?? "", /didn't go through: .*PAYPAL_CLIENT_ID/);
    key.close();
  });

  it("is told it paid, and how much was paid today", { skip: !sandbox && "set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_SANDBOX_VAULT_ID to charge PayPal's sandbox" }, async () => {
    const { store, purse, shopStore, connect, until } = setUp(sandbox);
    const mine = keyPair();
    const key = connect();
    key.said({ type: "hello", key: mine.key });
    shopStore.saveCustomer(mine.key, vaultId!, "buyer@example.com");
    const asked = await purse.buy({ shop: SHOP_URL, items: [{ sku: "filters", qty: 1 }], agent: "OpenClaw" });
    key.said({ type: "sign", id: asked.id, signature: mine.sign(asked.text) });
    await until(() => key.last("payment"));
    assert.deepEqual(key.last("payment"), { type: "payment", id: asked.id, status: "paid", line: "Paid $8.50 to Bean & Leaf with PayPal." });
    await until(() => key.last("idle")?.spentTodayUsd === 8.5);
    const paid = store.signRequest(asked.id)!.result as { paypal: { captureId: string } };
    await sandbox!.refund(paid.paypal.captureId, { note: "PureStrings' key test" });
    key.close();
  });
});
