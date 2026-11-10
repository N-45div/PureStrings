import { readSignable } from "./signable.ts";

/**
 * What a key without a screen says before you sign: the facts read from the exact text it signs (never words
 * the server sends beside it), so what you hear is what you sign. The key in your browser says it with this browser's
 * voice; the PureStrings button says the same words from its own memory.
 */

const CURRENCIES: Readonly<Record<string, readonly [string, string]>> = {
  USD: ["dollar", "dollars"],
  EUR: ["euro", "euros"],
  GBP: ["pound", "pounds"],
  INR: ["rupee", "rupees"],
  AUD: ["Australian dollar", "Australian dollars"],
  CAD: ["Canadian dollar", "Canadian dollars"],
};

/** "24 dollars", "1 dollar and 50 cents", "8 dollars and 5 cents"; "12.00 CHF" for a currency it has no words for. */
export function amountWords(value: string, currency: string): string {
  const match = /^(\d+)\.(\d{2})$/.exec(value);
  const names = CURRENCIES[currency];
  if (!match || !names) return `${value} ${currency}`;
  const whole = Number(match[1]);
  const cents = Number(match[2]);
  const main = `${whole} ${whole === 1 ? names[0] : names[1]}`;
  if (cents === 0) return main;
  const minor = currency === "INR" ? (cents === 1 ? "paisa" : "paise") : currency === "GBP" ? (cents === 1 ? "penny" : "pence") : cents === 1 ? "cent" : "cents";
  return whole === 0 ? `${cents} ${minor}` : `${main} and ${cents} ${minor}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "December 4" from "2026-12-04T10:00:00Z". */
function dayWords(iso: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})/.exec(iso);
  return match ? `${MONTHS[Number(match[1]) - 1]} ${Number(match[2])}` : iso;
}

/** "two bags of" isn't known, so items are said as they're written: "2 House blend beans, 1 lb". */
function itemsWords(items: readonly { readonly name: string; readonly qty: number }[]): string {
  const said = items.slice(0, 3).map((item) => `${item.qty} ${item.name}`);
  const rest = items.length - said.length;
  return `${said.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}`;
}

/** What the key says for this text, or why it won't sign it. `fresh`: a shop it hasn't signed for before. */
export function spokenSignable(text: string, fresh: boolean): string {
  const signable = readSignable(text);
  if (!signable) return "This key can't read what it's asked to sign, so it won't sign it. Tap to refuse.";
  const shop = signable.shop.name;
  const warning = fresh ? ` Careful: ${shop} is a shop this key hasn't signed for before.` : "";
  if (signable.kind === "link") return `Link your PayPal at ${shop} to this key.${warning} Hold to link, or tap to refuse.`;
  if (signable.kind === "allow") {
    const only = signable.by ? `, for ${signable.by} only` : "";
    return `An allowance for ${signable.for} at ${shop}${only}: PureStrings may spend up to ${amountWords(signable.each, signable.currency)} a time, and ${amountWords(signable.total, signable.currency)} a ${signable.per}, until ${dayWords(signable.expires)}.${warning} Hold to agree, or tap to refuse.`;
  }
  const count = signable.items.reduce((sum, item) => sum + item.qty, 0);
  const who = signable.by ? `${signable.by} asks to pay` : "Pay";
  return `${who} ${amountWords(signable.total, signable.currency)} to ${shop}, for ${count} ${count === 1 ? "item" : "items"}: ${itemsWords(signable.items)}.${warning} Hold to pay, or tap to refuse.`;
}
