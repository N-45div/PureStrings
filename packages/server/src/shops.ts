import { amountText, type CartLine, type Change, MAX_ITEMS, parseSignable, type Payee, type Purse, type ShopProduct, type SignRequest, signableLine, type Store } from "@purestrings/core";

/**
 * The shops your assistants may buy at, and the words they get back. Only shops you've added: a tool call, a web
 * page an assistant read, or a message can't send PureStrings to buy somewhere new.
 */

const SHOPS = "shops";

/** The shops you have, by address: the demo shop PureStrings opens, then each one you added. */
export function knownShops(store: Store, demo?: string): string[] {
  let added: unknown = [];
  try {
    added = JSON.parse(store.setting(SHOPS) ?? "[]");
  } catch {
    // None, then.
  }
  const urls = [...(demo ? [demo] : []), ...(Array.isArray(added) ? added.filter((url): url is string => typeof url === "string") : [])];
  const seen = new Set<string>();
  return urls.filter((url) => {
    const key = url.replace(/\/+$/, "");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Keeps the shops you added (the demo shop is always there): each an http(s) address. */
export function saveShops(store: Store, urls: readonly unknown[]): string[] {
  const kept: string[] = [];
  for (const url of urls) {
    if (typeof url !== "string" || !URL.canParse(url.trim()) || !/^https?:$/.test(new URL(url.trim()).protocol)) throw new Error(`"${String(url).slice(0, 100)}" isn't a shop's address (http or https).`);
    kept.push(url.trim().replace(/\/+$/, ""));
  }
  store.saveSetting(SHOPS, JSON.stringify([...new Set(kept)].slice(0, 20)));
  return kept;
}

/** Cart lines from what was sent: [{ sku, qty }], at most MAX_ITEMS of them, each sku once, 1 to 99 of each. */
export function linesFrom(value: unknown): CartLine[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Give the items as a list, like [{ "sku": "beans-house", "qty": 2 }].');
  const lines = new Map<string, number>();
  for (const item of value) {
    const { sku, qty } = (item ?? {}) as { sku?: unknown; qty?: unknown };
    if (typeof sku !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(sku)) throw new Error("Each item needs the sku the shop listed it with.");
    const count = qty === undefined ? 1 : qty;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 99) throw new Error(`"${sku}" needs a whole quantity from 1 to 99.`);
    lines.set(sku, (lines.get(sku) ?? 0) + count);
  }
  if (lines.size > MAX_ITEMS) throw new Error(`A cart has at most ${MAX_ITEMS} different things in it.`);
  return [...lines].map(([sku, qty]) => ({ sku, qty }));
}

/** The shop asked for (its address), out of the ones you have; the only one, when none is named. */
export function pickShop(shops: readonly string[], given: unknown): string {
  if (shops.length === 0) throw new Error("PureStrings knows no shops yet: open the demo shop (set PayPal's keys, or PURESTRINGS_SHOP=on), or add a shop.");
  if (typeof given !== "string" || !given.trim()) {
    if (shops.length === 1) return shops[0]!;
    throw new Error(`Say which shop, by its address: ${shops.join(", ")}.`);
  }
  const wanted = given.trim().replace(/\/+$/, "");
  const found = shops.find((url) => url.replace(/\/+$/, "") === wanted);
  if (!found) throw new Error(`PureStrings only buys at shops its owner added, and "${given.trim().slice(0, 100)}" isn't one. The shops: ${shops.join(", ")}.`);
  return found;
}

/**
 * The shop asked for by its address, or by its name ("Bean & Leaf"), which is what assistants often send. A name only
 * matches one of the shops you have, as each one names itself; anything else is refused as pickShop refuses it.
 */
export async function findShop(purse: Purse, shops: readonly string[], given: unknown): Promise<string> {
  try {
    return pickShop(shops, given);
  } catch (refused) {
    const name = typeof given === "string" ? given.trim().toLowerCase() : "";
    if (!name) throw refused;
    const named = await Promise.all(shops.map(async (url) => ((await purse.shop(url).about().catch(() => null))?.shop.name.trim().toLowerCase() === name ? url : null)));
    const found = named.filter((url): url is string => url !== null);
    if (found.length !== 1) throw refused;
    return found[0]!;
  }
}

export interface Found {
  readonly url: string;
  readonly shop: Payee;
  readonly products: readonly ShopProduct[];
}

/** What a shop (or each shop you have, up to three, when none is named) sells that fits what's asked. */
export async function searchShops(purse: Purse, shops: readonly string[], query: string, given?: unknown): Promise<Found[]> {
  const urls = typeof given === "string" && given.trim() ? [await findShop(purse, shops, given)] : shops.slice(0, 3);
  if (!urls.length) pickShop(shops, given);
  return Promise.all(urls.map(async (url) => ({ url, ...(await purse.shop(url).search(query.slice(0, 500), 8)) })));
}

/** What a search found, for an assistant to read: each shop by name and address, then each product's sku, name and price. */
export function foundText(found: readonly Found[]): string {
  return found
    .map(({ url, shop, products }) => {
      const lines = products.map((product) => `- ${product.sku}: ${product.name}, ${amountText(product.price, product.currency)}`);
      return `${shop.name} (${url}):\n${lines.join("\n") || "- nothing that fits"}`;
    })
    .join("\n\n");
}

/** A payment in one line: who asked, how much, to which shop, for what. */
export function paymentLine(request: SignRequest): string {
  try {
    return signableLine(parseSignable(request.text));
  } catch {
    return `A ${request.kind === "buy" ? "payment" : request.kind === "link" ? "link" : "allowance"} PureStrings can't read`;
  }
}

/** Waits (up to `waitMs`) until a payment is answered: paid, declined, expired or failed; then, or at the end, how it stands. */
export function settled(store: Store, id: string, waitMs: number): Promise<SignRequest> {
  return new Promise((resolve) => {
    const open = (request: SignRequest | null) => request !== null && (request.status === "waiting" || request.status === "signed");
    const done = () => {
      clearTimeout(timer);
      store.events.off("change", onChange);
      resolve(store.signRequest(id)!);
    };
    const onChange = (change: Change) => {
      if (change.kind === "sign" && !open(store.signRequest(id))) done();
    };
    const timer = setTimeout(done, waitMs);
    store.events.on("change", onChange);
    if (!open(store.signRequest(id))) done();
  });
}
