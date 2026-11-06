import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelFromEnv, NEMOTRON } from "../src/model.ts";
import { limitsFrom, limitsFromWords } from "../src/words.ts";

/** Limits from words: checking what a model wrote needs no model; Nemotron itself is asked with NEBIUS_API_KEY set. */
const model = modelFromEnv(process.env);

describe("an allowance from what you say", () => {
  it("takes only limits that make sense from what the model wrote", () => {
    assert.deepEqual(limitsFrom({ for: "Coffee", each: "20", total: 50, per: "week", days: 7 }), { for: "Coffee", each: "20.00", total: "50.00", per: "week", days: 7 });
    assert.deepEqual(limitsFrom({ each: "$30.00", per: "month" }), { for: "Shopping", each: "30.00", total: "30.00", per: "month", days: 30 });
    assert.equal(limitsFrom({ for: "Tea", each: "80", total: "50", per: "day", days: 400 }).each, "50.00", "never more each time than in all");
    assert.equal(limitsFrom({ for: "Tea", each: "8", total: "50", per: "day", days: 400 }).days, 31);
    assert.throws(() => limitsFrom({ for: "Tea", each: "lots", per: "week" }), /needs amounts/);
    assert.throws(() => limitsFrom({ for: "Tea", each: "5", per: "year" }), /day, week or month/);
  });

  it("knows which model to ask", () => {
    assert.equal(modelFromEnv({}), null);
    assert.equal(modelFromEnv({ NEBIUS_API_KEY: "key" })?.name, NEMOTRON);
    assert.equal(modelFromEnv({ NEBIUS_API_KEY: "key", MODEL_URL: "http://localhost:11434/v1", MODEL: "llama3" })?.name, "llama3");
  });

  it("asks Nemotron for the limits in a sentence", { skip: !model && "set NEBIUS_API_KEY to ask Nemotron on Token Factory" }, async () => {
    const limits = await limitsFromWords(model!, "Let it buy coffee for me, at most $15 a time and $40 a week, for the next two weeks");
    assert.deepEqual([limits.each, limits.total, limits.per, limits.days], ["15.00", "40.00", "week", 14]);
    assert.match(limits.for, /coffee/i);
  });
});
