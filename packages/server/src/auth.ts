import { timingSafeEqual } from "node:crypto";

/** Compares secrets in constant time. */
export function same(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The token from an `Authorization: Bearer <token>` header. */
export const bearerOf = (header: string | undefined): string | undefined => header?.replace(/^Bearer\s+/i, "") || undefined;

const THIS_MACHINE = ["localhost", "127.0.0.1", "[::1]"];

/**
 * Why a request from a browser isn't PureStrings' to answer, or null when it is. A browser says which page sent it
 * (Origin): only PureStrings' own pages, or a page on this machine, may call it, so a site you happen to visit can't
 * use your PureStrings through your browser. Without a token PureStrings listens on this machine alone, and then the
 * name it was called by (Host) must be this machine's or its own, so a site whose name points here (DNS rebinding)
 * can't read it either.
 */
export function strangerWhy(publicUrl: string, hasToken: boolean, origin: string | undefined, host: string | undefined): string | null {
  const own = URL.canParse(publicUrl) ? new URL(publicUrl) : null;
  if (origin && origin !== own?.origin) {
    const from = URL.canParse(origin) ? new URL(origin).hostname : "";
    if (!THIS_MACHINE.includes(from)) return `PureStrings doesn't take calls from pages on ${origin}.`;
  }
  if (!hasToken && host) {
    const name = host.replace(/:\d+$/, "").toLowerCase();
    if (!THIS_MACHINE.includes(name) && name !== own?.hostname) return `PureStrings answers to its own address, not ${host}.`;
  }
  return null;
}
