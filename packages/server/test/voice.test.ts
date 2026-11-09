import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VOICE_RATE, voiceFromEnv } from "../src/voice.ts";

const voice = voiceFromEnv(process.env);

describe("the button's voice", () => {
  it("is off without an OpenAI key, or with VOICE=off", () => {
    assert.equal(voiceFromEnv({}), null);
    assert.equal(voiceFromEnv({ OPENAI_API_KEY: "sk-test", VOICE: "off" }), null);
    assert.equal(voiceFromEnv({ MODEL_URL: "https://api.studio.nebius.com/v1/", MODEL_KEY: "nb-test" }), null);
  });

  it("streams OpenAI's speech as whole 16-bit samples at 24 kHz", { skip: voice ? false : "no OPENAI_API_KEY (or MODEL_KEY for OpenAI's MODEL_URL)" }, async () => {
    let bytes = 0;
    let pieces = 0;
    for await (const pcm of voice!.speak("Paid 12 dollars to Bean and Leaf with PayPal.")) {
      assert.equal(pcm.length % 2, 0);
      bytes += pcm.length;
      pieces++;
    }
    const seconds = bytes / 2 / VOICE_RATE;
    assert.ok(seconds > 1 && seconds < 10, `${seconds.toFixed(2)} s of speech`);
    assert.ok(pieces >= 1);
  });
});
