import type { AddedAgent, Agent, AllowanceView, AuditView, Device, Found, Info, Signer, SignView } from "./types.ts";

/**
 * The one way the app talks to PureStrings. Paths are relative to the page, so it works wherever the server is.
 * When PureStrings has a token, it's kept in this browser and sent as a bearer; a link can carry it after the #.
 */

const TOKEN_KEY = "purestrings.token";

function stored(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

let token = stored();

export const readToken = (): string => token;

export function writeToken(next: string): void {
  token = next;
  try {
    if (next) localStorage.setItem(TOKEN_KEY, next);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage blocked (a private window): the token lasts until the page closes.
  }
}

// A link like https://your-purestrings/#token=... opens without asking; the token is then taken out of the address.
if (typeof window !== "undefined") {
  const match = /^#token=([^&]*)/.exec(window.location.hash);
  if (match) {
    try {
      writeToken(decodeURIComponent(match[1]!).trim());
    } catch {
      // A broken link: asked for instead.
    }
    window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/`);
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (response.status === 204) return undefined as T;
  const answer = (await response.json().catch(() => null)) as { error?: string } | null;
  if (!response.ok) throw new ApiError(answer?.error ?? `PureStrings answered HTTP ${response.status}.`, response.status);
  return answer as T;
}

/** The event stream's address: EventSource can't send headers, so the token goes in the query. */
export const eventsUrl = (): string => `api/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;

/** The key socket's address, for the key in this browser. */
export function keySocketUrl(): string {
  const url = new URL("keys/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (token) url.searchParams.set("token", token);
  return url.toString();
}

export const api = {
  info: () => call<Info>("GET", "api/info"),
  signs: (kind?: "buy" | "link" | "allow") => call<SignView[]>("GET", `api/signs${kind ? `?kind=${kind}` : ""}`),
  sign: (id: string, signature: string, key: string) => call<SignView>("POST", `api/signs/${encodeURIComponent(id)}`, { signature, key }),
  decline: (id: string) => call<SignView>("POST", `api/signs/${encodeURIComponent(id)}/decline`),
  retry: (id: string) => call<SignView>("POST", `api/signs/${encodeURIComponent(id)}/retry`),
  agents: () => call<Agent[]>("GET", "api/agents"),
  addAgent: (name: string) => call<AddedAgent>("POST", "api/agents", { name }),
  removeAgent: (id: string) => call<void>("DELETE", `api/agents/${encodeURIComponent(id)}`),
  devices: () => call<Device[]>("GET", "api/devices"),
  addDevice: (name: string) => call<{ device: Device; token: string; ws: string }>("POST", "api/devices", { name }),
  removeDevice: (id: string) => call<void>("DELETE", `api/devices/${encodeURIComponent(id)}`),
  keys: () => call<Signer[]>("GET", "api/keys"),
  removeKey: (key: string) => call<void>("DELETE", `api/keys/${encodeURIComponent(key)}`),
  shops: () => call<string[]>("GET", "api/shops"),
  search: (q: string, shop?: string) => call<{ found: Found[]; text: string }>("GET", `api/shops/search?q=${encodeURIComponent(q)}${shop ? `&shop=${encodeURIComponent(shop)}` : ""}`),
  buy: (items: readonly { sku: string; qty: number }[], options: { shop?: string; agent?: string } = {}) => call<SignView>("POST", "api/shops/buy", { items, ...options }),
  link: (key: string, shop?: string) => call<SignView>("POST", "api/links", { key, ...(shop ? { shop } : {}) }),
  checkLink: (id: string) => call<SignView>("POST", `api/links/${encodeURIComponent(id)}/check`),
  allowances: () => call<AllowanceView[]>("GET", "api/allowances"),
  allow: (given: ({ said: string } | { for: string; each: string; total: string; per: string; days: number }) & { by?: string }, key?: string) => call<AllowanceView>("POST", "api/allowances", { ...given, ...(key ? { key } : {}) }),
  stopAllowance: (id: string) => call<AllowanceView>("POST", `api/allowances/${encodeURIComponent(id)}/stop`),
  audit: () => call<AuditView>("GET", "api/audit"),
  runAudit: () => call<AuditView>("POST", "api/audit"),
};
