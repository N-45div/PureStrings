import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Payment } from "../src/countersign.ts";
import { amountWords, spokenText } from "../src/spoken.ts";

const payment: Payment = {
  v: 1,
  kind: "buy",
  id: "pay_0123456789abcdef01234567",
  by: "OpenClaw",
  shop: { id: "beanandleaf.example", name: "Bean & Leaf" },
  cart: "cart_91",
  items: [
    { name: "House blend beans, 1 lb", qty: 2, price: "12.00" },
    { name: "Paper filters", qty: 1, price: "8.50" },
  ],
  total: "32.50",
  currency: "USD",
  expires: "2026-10-29T10:15:00Z",
};

describe("what the button says", () => {
  it("says amounts as words, and leaves a currency it has no words for as it is", () => {
    assert.equal(amountWords("12.00", "USD"), "12 dollars");
    assert.equal(amountWords("1.50", "USD"), "1 dollar and 50 cents");
    assert.equal(amountWords("0.01", "GBP"), "1 penny");
    assert.equal(amountWords("12.00", "CHF"), "12.00 CHF");
  });

  it("says who asks, how much, to whom and for what, from the text the key signs", () => {
    assert.equal(spokenText(payment, false), "OpenClaw asks to pay 32 dollars and 50 cents to Bean & Leaf, for 3 items: 2 House blend beans, 1 lb; 1 Paper filters. Hold to pay, or tap to refuse.");
  });

  it("warns about a shop this key hasn't signed for before", () => {
    assert.match(spokenText(payment, true), /Careful: Bean & Leaf is a shop this key hasn't signed for before\./);
  });

  it("says a link as what it is", () => {
    assert.equal(spokenText({ v: 1, kind: "link", id: "lnk_1", shop: payment.shop, expires: payment.expires }, false), "Link your PayPal at Bean & Leaf to this key. Hold to link, or tap to refuse.");
  });
});
