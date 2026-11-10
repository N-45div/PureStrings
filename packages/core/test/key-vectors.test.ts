import assert from "node:assert/strict";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fingerprint, keyText, parseSignable, signableLine, signableText, signedBy } from "../src/countersign.ts";
import { spokenText } from "../src/spoken.ts";

/**
 * The test vectors in docs/key-protocol/vectors.json, which anyone building a key checks theirs against: PureStrings
 * must take every valid one, refuse every text a key must refuse, and refuse every signature that's been moved.
 */
interface Vectors {
  readonly key: { readonly private: string; readonly public: string; readonly fingerprint: string };
  readonly valid: readonly { readonly name: string; readonly text: string; readonly signature: string; readonly line: string; readonly spoken: string; readonly spokenNewShop: string }[];
  readonly refuse: readonly { readonly name: string; readonly text: string }[];
  readonly tampered: readonly { readonly name: string; readonly text: string; readonly signature: string }[];
}

const vectors = JSON.parse(readFileSync(new URL("../../../docs/key-protocol/vectors.json", import.meta.url), "utf8")) as Vectors;
const { key } = vectors;

describe("the key test vectors", () => {
  it("have a key written the one way, with its fingerprint", () => {
    assert.equal(keyText(key.public), key.public);
    assert.equal(fingerprint(key.public), key.fingerprint);
  });

  for (const vector of vectors.valid) {
    it(`take ${vector.name}`, () => {
      const signable = parseSignable(vector.text);
      assert.equal(signableText(signable), vector.text, "the text is written the one way");
      assert.ok(signedBy(vector.text, vector.signature, key.public), "the signature is the key's");
      assert.equal(signableLine(signable), vector.line);
      assert.equal(spokenText(signable, false), vector.spoken);
      assert.equal(spokenText(signable, true), vector.spokenNewShop);
    });
  }

  it("sign the way PureStrings checks, with the test key's private half", () => {
    const [x, y] = [Buffer.from(key.public, "base64url").subarray(1, 33), Buffer.from(key.public, "base64url").subarray(33)];
    const privateKey = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: key.private, x: x.toString("base64url"), y: y.toString("base64url") }, format: "jwk" });
    for (const vector of vectors.valid) {
      const signature = sign("sha256", Buffer.from(vector.text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
      assert.ok(signedBy(vector.text, signature, key.public), vector.name);
    }
  });

  for (const vector of vectors.refuse) {
    it(`refuse ${vector.name}`, () => {
      assert.throws(() => parseSignable(vector.text));
    });
  }

  for (const vector of vectors.tampered) {
    it(`refuse a signature on ${vector.name}`, () => {
      assert.equal(signedBy(vector.text, vector.signature, key.public), false);
    });
  }
});
