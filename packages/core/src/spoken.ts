import type { Signable } from "./countersign.ts";

/**
 * What a key says before you sign, in words, from the exact text it signs: the same words the key in your browser
 * says (packages/web/src/spoken.ts). PureStrings has the PureStrings button say them through its speaker; the
 * button's screen, which reads the text itself, stays what you trust.
 */

const CURRENCIES: Readonly<Record<string, readonly [string, string]>> = {
  USD: ["dollar", "dollars"],
  EUR: ["euro", "euros"],
  GBP: ["pound", "pounds"],
  INR: ["rupee", "rupees"],
  AUD: ["Australian dollar", "Australian dollars"],
  CAD: ["Canadian dollar", "Canadian dollars"],
};

/** "24 dollars", "1 dollar and 50 cents"; "12.00 CHF" for a currency it has no words for. */
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

/** What a key says for this signable. `fresh`: a shop this key hasn't signed for before. */
export function spokenText(signable: Signable, fresh: boolean): string {
  const shop = signable.shop.name;
  const warning = fresh ? ` Careful: ${shop} is a shop this key hasn't signed for before.` : "";
  if (signable.kind === "link") return `Link your PayPal at ${shop} to this key.${warning} Hold to link, or tap to refuse.`;
  if (signable.kind === "allow") {
    return `An allowance for ${signable.for} at ${shop}: PureStrings may spend up to ${amountWords(signable.each, signable.currency)} a time, and ${amountWords(signable.total, signable.currency)} a ${signable.per}, until ${dayWords(signable.expires)}.${warning} Hold to agree, or tap to refuse.`;
  }
  const count = signable.items.reduce((sum, item) => sum + item.qty, 0);
  const said = signable.items.slice(0, 3).map((item) => `${item.qty} ${item.name}`);
  const rest = signable.items.length - said.length;
  const who = signable.by ? `${signable.by} asks to pay` : "Pay";
  return `${who} ${amountWords(signable.total, signable.currency)} to ${shop}, for ${count} ${count === 1 ? "item" : "items"}: ${said.join("; ")}${rest > 0 ? `; and ${rest} more` : ""}.${warning} Hold to pay, or tap to refuse.`;
}
