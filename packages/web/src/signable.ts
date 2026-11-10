/**
 * What a text your key signs says, read here in the browser: the key shows (and says) the facts from the very
 * text it signs, never from words the server sends beside it. Anything it can't read, it won't sign.
 */

export interface Shop {
  readonly id: string;
  readonly name: string;
}

export type Readable =
  | { readonly kind: "buy"; readonly by: string | null; readonly allow: string | null; readonly shop: Shop; readonly items: readonly { readonly name: string; readonly qty: number; readonly price: string }[]; readonly total: string; readonly currency: string; readonly expires: string }
  | { readonly kind: "link"; readonly shop: Shop; readonly expires: string }
  | { readonly kind: "allow"; readonly shop: Shop; readonly for: string; readonly by: string | null; readonly each: string; readonly total: string; readonly per: string; readonly currency: string; readonly expires: string };

const text = (value: unknown, most = 200): value is string => typeof value === "string" && value.length > 0 && value.length <= most;
const money = (value: unknown): value is string => typeof value === "string" && /^\d{1,7}\.\d{2}$/.test(value);

/** What the text says; null for anything a key shouldn't sign. */
export function readSignable(signed: string): Readable | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(signed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const shop = value.shop as Record<string, unknown> | undefined;
  if (!value || typeof value !== "object" || !shop || !text(shop.id) || !text(shop.name, 80) || !text(value.expires, 40)) return null;
  const at = { shop: { id: shop.id, name: shop.name }, expires: value.expires };
  if (value.kind === "link") return { kind: "link", ...at };
  if (value.kind === "allow") {
    if (!text(value.for, 40) || !money(value.each) || !money(value.total) || !text(value.per, 10) || !text(value.currency, 3)) return null;
    return { kind: "allow", ...at, for: value.for, by: text(value.by, 40) ? value.by : null, each: value.each, total: value.total, per: value.per, currency: value.currency };
  }
  if (value.kind !== "buy" || !Array.isArray(value.items) || !money(value.total) || !text(value.currency, 3)) return null;
  const items = value.items.map((item: Record<string, unknown>) => ({ name: item?.name, qty: item?.qty, price: item?.price }));
  if (!items.length || !items.every((item) => text(item.name, 120) && Number.isInteger(item.qty) && money(item.price))) return null;
  return {
    kind: "buy",
    by: text(value.by, 40) ? value.by : null,
    allow: text(value.allow, 40) ? value.allow : null,
    ...at,
    items: items as { name: string; qty: number; price: string }[],
    total: value.total,
    currency: value.currency,
  };
}

/** "$24.00", "₹120.00", "12.00 CHF". */
export function amount(value: string, currency: string): string {
  const sign: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", INR: "₹" };
  return sign[currency] ? `${sign[currency]}${value}` : `${value} ${currency}`;
}
