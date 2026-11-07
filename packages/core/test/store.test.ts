import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { fingerprint } from "../src/countersign.ts";
import { type Change, Store } from "../src/store.ts";

/** A key's raw public key, as it says it. */
function aKey(): string {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  return Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
}

describe("what PureStrings keeps", () => {
  it("knows each assistant by its own token, shown once and kept only as a hash", () => {
    const store = new Store();
    const { agent, token } = store.addAgent("OpenClaw");
    assert.equal(agent.name, "OpenClaw");
    assert.equal(store.agentByToken(token)?.id, agent.id);
    assert.ok(store.agentByToken(token)?.lastSeenAt !== undefined);
    assert.equal(store.agentByToken(`${token}x`), null);
    assert.ok(!JSON.stringify(store.db.prepare("SELECT * FROM agents").all()).includes(token), "the token itself isn't kept");
    assert.equal(store.removeAgent(agent.id), true);
    assert.equal(store.agentByToken(token), null);
  });

  it("pins each key once, a key's to the key, and forgets it with the key", () => {
    const store = new Store();
    const changes: Change[] = [];
    store.events.on("change", (change: Change) => changes.push(change));
    const { device, token } = store.addDevice("Desk key");
    assert.equal(store.deviceByToken(token)?.id, device.id);
    const key = aKey();
    const signer = store.addSigner({ key, name: "Desk key", deviceId: device.id });
    assert.equal(signer.fingerprint, fingerprint(key));
    assert.equal(store.signerForDevice(device.id)?.key, key);
    assert.throws(() => store.addSigner({ key, name: "Again" }), /already added/);
    assert.throws(() => store.addSigner({ key: aKey(), name: "Swapped", deviceId: device.id }), /already added/);
    store.addSigner({ key: aKey(), name: "In my browser" });
    assert.equal(store.removeDevice(device.id), true);
    assert.equal(store.signer(key), null, "a button's key goes with it");
    assert.equal(store.signers().length, 1);
    assert.ok(changes.every((change) => change.kind === "keys"));
  });

  it("keeps what a key was asked to sign, which assistant asked, and signs it once", () => {
    const store = new Store();
    const key = aKey();
    store.addSigner({ key, name: "Desk key" });
    const request = store.addSignRequest({ id: "pay_000000000001", kind: "buy", text: "{}", shop: "http://shop.test", expires: "2026-11-07T10:10:00Z", agent: "Hermes" });
    assert.deepEqual([request.status, request.agent], ["waiting", "Hermes"]);
    assert.equal(store.markSigned(request.id, "sig", key), true);
    assert.equal(store.markSigned(request.id, "again", key), false);
    assert.ok(store.signer(key)?.lastSignedAt);
    assert.equal(store.moveSignRequest(request.id, "signed", { status: "paid", result: { order: "order_1" } }), true);
    assert.deepEqual(store.signRequest(request.id)?.result, { order: "order_1" });
    assert.deepEqual(store.signRequests(10, "link"), []);
    assert.equal(store.settingOr("made-once", () => "first"), "first");
    assert.equal(store.settingOr("made-once", () => "second"), "first");
  });
});
