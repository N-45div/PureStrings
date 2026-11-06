import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { keyOf, makeKeyPair } from "../src/key.ts";
import { amount, readSignable } from "../src/signable.ts";
import { amountWords, spokenSignable } from "../src/spoken.ts";

/** What the key in a browser reads, says and signs: all from the exact text, here in the browser. */
const PAYMENT = JSON.stringify({ v: 1, kind: "buy", id: "pay_000000000001", by: "OpenClaw", shop: { id: "shop.test", name: "Bean & Leaf" }, cart: "cart_1", items: [{ name: "House blend beans, 1 lb", qty: 2, price: "12.00" }], total: "24.00", currency: "USD", expires: "2026-11-07T10:10:00Z" });

describe("the key in a browser", () => {
  it("reads only texts it can show in full", () => {
    const read = readSignable(PAYMENT);
    assert.equal(read?.kind, "buy");
    assert.equal(read?.kind === "buy" && read.by, "OpenClaw");
    assert.equal(readSignable("not json"), null);
    assert.equal(readSignable(JSON.stringify({ kind: "buy", shop: { id: "x", name: "X" }, expires: "z", items: [], total: "1.00", currency: "USD" })), null, "no lines to show");
    assert.equal(readSignable(PAYMENT.replace('"24.00"', '"24"')), null, "amounts are written one way");
    assert.equal(amount("24.00", "USD"), "$24.00");
  });

  it("says what you'd pay, who asked, and warns of a shop it hasn't signed for", () => {
    assert.equal(spokenSignable(PAYMENT, false), "OpenClaw asks to pay 24 dollars to Bean & Leaf, for 2 items: 2 House blend beans, 1 lb. Hold to pay, or tap to refuse.");
    assert.match(spokenSignable(PAYMENT, true), /Careful: Bean & Leaf is a shop this key hasn't signed for before\./);
    assert.match(spokenSignable("{}", false), /can't read what it's asked to sign/);
    assert.equal(amountWords("1.50", "USD"), "1 dollar and 50 cents");
  });

  it("signs with a key whose private half can't be read out", async () => {
    const pair = await makeKeyPair();
    assert.equal(pair.privateKey.extractable, false);
    const key = await keyOf(pair, true);
    assert.match(key.fingerprint, /^[0-9A-F]{4}( [0-9A-F]{4}){3}$/);
    const signature = Buffer.from(await key.sign(PAYMENT), "base64url");
    assert.equal(signature.length, 64, "r and s side by side");
    assert.ok(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pair.publicKey, signature, new TextEncoder().encode(PAYMENT)));
  });
});
