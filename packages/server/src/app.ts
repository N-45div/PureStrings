import { activeAllowances, allowanceUse, keyText, parseSignable, type Purse, type SignRequest, type Store } from "@purestrings/core";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { bearerOf, same } from "./auth.ts";
import type { Auditor } from "./auditor.ts";
import { mcpRoutes } from "./mcp.ts";
import type { Model } from "./model.ts";
import { foundText, knownShops, linesFrom, paymentLine, pickShop, saveShops, searchShops } from "./shops.ts";
import { type Limits, limitsFrom, limitsFromWords } from "./words.ts";

/**
 * PureStrings' API, for its web app: the assistants you let shop and their tokens; your keys (buttons, and the key
 * in your browser); what's waiting for a signature and what was paid; linking a key at a shop; allowances; and the
 * auditor. Everything under /api takes your PureStrings token, when one is set. /mcp is for assistants.
 */

export interface AppOptions {
  readonly store: Store;
  readonly purse: Purse;
  readonly version: string;
  /** Where PureStrings is reached from outside. */
  readonly publicUrl: string;
  /** Your PureStrings token; without one, the API is open (on your own machine only). */
  readonly token?: string;
  /** The demo shop's address, when PureStrings opens one. */
  readonly shop?: string;
  /** "sandbox" or "live" when PayPal is set up for the demo shop. */
  readonly paypal?: "sandbox" | "live" | null;
  readonly model?: Model | null;
  readonly auditor?: Auditor | null;
  /** The USB port PureStrings itself links a button on now, if it does. */
  readonly usb?: () => string | null;
  /** How long shop_buy waits for your key; tests shorten it. */
  readonly mcpWaitMs?: number;
}

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
const bad = (c: Context, message: string, status: 400 | 401 | 404 | 409 | 501 | 502 = 400) => c.json({ error: message }, status);

async function body(c: Context): Promise<Record<string, unknown>> {
  try {
    const given = (await c.req.json()) as unknown;
    return typeof given === "object" && given !== null && !Array.isArray(given) ? (given as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A sign request as the app shows it: its line, and what it is. */
export function signView(request: SignRequest) {
  let signed = null;
  try {
    signed = parseSignable(request.text);
  } catch {
    // Shown by its line alone.
  }
  return { ...request, line: paymentLine(request), signed };
}

export function createApp(options: AppOptions): Hono {
  const { store, purse } = options;
  const app = new Hono();
  const shops = () => knownShops(store, options.shop);

  app.use("/api/*", bodyLimit({ maxSize: 100_000, onError: (c) => bad(c, "That's too big.") }), async (c, next) => {
    // /api/info is open: it holds nothing private, and it's how the app learns to ask for the token.
    if (!options.token || c.req.path === "/api/info") return next();
    // EventSource can't send headers, so the event stream takes the token in the query.
    const queried = c.req.path === "/api/events" ? c.req.query("token") : undefined;
    if (same(bearerOf(c.req.header("authorization")), options.token) || same(queried, options.token)) return next();
    return bad(c, "Send your PureStrings token as Authorization: Bearer <token>.", 401);
  });

  app.get("/api/info", (c) =>
    c.json({ name: "PureStrings", version: options.version, publicUrl: options.publicUrl, token: Boolean(options.token), shop: options.shop ?? null, paypal: options.paypal ?? null, model: options.model?.name ?? null, auditor: Boolean(options.auditor), mcp: `${options.publicUrl}/mcp`, usb: options.usb?.() ?? null }),
  );

  app.get("/api/events", (c) =>
    streamSSE(c, async (stream) => {
      const send = (change: unknown) => void stream.writeSSE({ event: "change", data: JSON.stringify(change) });
      store.events.on("change", send);
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 25_000).unref();
      await new Promise<void>((resolve) => stream.onAbort(resolve));
      clearInterval(ping);
      store.events.off("change", send);
    }),
  );

  // The assistants you let shop: each gets its own token, shown once, and its name goes in what your key signs.
  app.get("/api/agents", (c) => c.json(store.agents()));
  app.post("/api/agents", async (c) => {
    const name = String((await body(c)).name ?? "")
      .trim()
      .replace(/\s+/g, " ");
    if (!/^[\p{L}\p{N}][\p{L}\p{N} .'_-]{0,39}$/u.test(name)) return bad(c, "Give the assistant a name of up to 40 letters, like OpenClaw.");
    if (name === "You" || store.agents().some((agent) => agent.name.toLowerCase() === name.toLowerCase())) return bad(c, `There's already an assistant called ${name}.`, 409);
    const { agent, token } = store.addAgent(name);
    const url = `${options.publicUrl}/mcp`;
    const config = { mcpServers: { purestrings: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } };
    return c.json({ agent, token, mcp: { url, config, claudeCode: `claude mcp add --transport http purestrings ${url} --header "Authorization: Bearer ${token}"` } }, 201);
  });
  app.delete("/api/agents/:id", (c) => (store.removeAgent(c.req.param("id")) ? c.body(null, 204) : bad(c, "There's no such assistant.", 404)));

  // Your keys: a button gets its own token for /keys/ws; a key in a browser is added by its public key.
  app.get("/api/devices", (c) => c.json(store.devices().map((device) => ({ ...device, signer: store.signerForDevice(device.id) }))));
  app.post("/api/devices", async (c) => {
    const name = String((await body(c)).name ?? "").trim() || "PureStrings button";
    const { device, token } = store.addDevice(name.slice(0, 40));
    return c.json({ device, token, ws: `${options.publicUrl.replace(/^http/, "ws")}/keys/ws` }, 201);
  });
  app.delete("/api/devices/:id", (c) => (store.removeDevice(c.req.param("id")) ? c.body(null, 204) : bad(c, "There's no such button.", 404)));
  app.get("/api/keys", (c) => c.json(store.signers()));
  app.post("/api/keys", async (c) => {
    const { key, name } = await body(c);
    try {
      const raw = keyText(String(key ?? ""));
      return c.json(store.signer(raw) ?? store.addSigner({ key: raw, name: String(name ?? "").trim().slice(0, 40) || "Key in a browser" }), 201);
    } catch (error) {
      return bad(c, failure(error));
    }
  });
  app.delete("/api/keys/:key", (c) => {
    const signer = store.signer(c.req.param("key"));
    if (!signer) return bad(c, "There's no such key.", 404);
    if (signer.deviceId) return bad(c, "That key is a button's: remove the button instead.", 409);
    store.removeSigner(signer.key);
    return c.body(null, 204);
  });

  // What's waiting for your key, and what came of it.
  app.get("/api/signs", (c) => {
    const kind = c.req.query("kind");
    return c.json(store.signRequests(100, kind === "buy" || kind === "link" || kind === "allow" ? kind : undefined).map(signView));
  });
  app.post("/api/signs/:id", async (c) => {
    const { signature, key } = await body(c);
    if (typeof signature !== "string" || typeof key !== "string") return bad(c, "Send the key's signature and its public key as { signature, key }.");
    try {
      purse.sign(c.req.param("id"), signature, key);
      return c.json(signView(store.signRequest(c.req.param("id"))!), 202);
    } catch (error) {
      return bad(c, failure(error), 409);
    }
  });
  app.post("/api/signs/:id/decline", (c) => {
    try {
      return c.json(signView(purse.decline(c.req.param("id"))));
    } catch (error) {
      return bad(c, failure(error), 409);
    }
  });
  app.post("/api/signs/:id/retry", async (c) => {
    try {
      return c.json(signView(await purse.retry(c.req.param("id"))));
    } catch (error) {
      return bad(c, failure(error), 502);
    }
  });

  // The shops: search them, and buy yourself (or a browser assistant on PureStrings' own page, through WebMCP).
  app.get("/api/shops", (c) => c.json(shops()));
  app.put("/api/shops", async (c) => {
    const { shops: given } = await body(c);
    try {
      saveShops(store, Array.isArray(given) ? given : []);
      return c.json(shops());
    } catch (error) {
      return bad(c, failure(error));
    }
  });
  app.get("/api/shops/search", async (c) => {
    try {
      const found = await searchShops(purse, shops(), (c.req.query("q") ?? "").trim(), c.req.query("shop"));
      return c.json({ found, text: foundText(found) });
    } catch (error) {
      return bad(c, failure(error), 502);
    }
  });
  app.post("/api/shops/buy", async (c) => {
    const given = await body(c);
    try {
      const agent = typeof given.agent === "string" ? given.agent.trim().slice(0, 40) || null : null;
      return c.json(signView(await purse.buy({ shop: pickShop(shops(), given.shop), items: linesFrom(given.items), agent })), 201);
    } catch (error) {
      return bad(c, failure(error));
    }
  });

  // Linking a key to your PayPal at a shop: the shop writes what the key signs, and PayPal sends you back here.
  app.post("/api/links", async (c) => {
    const { shop, key } = await body(c);
    try {
      return c.json(signView(await purse.startLink(pickShop(shops(), shop), String(key ?? ""), `${options.publicUrl}/#/keys`)), 201);
    } catch (error) {
      return bad(c, failure(error));
    }
  });
  app.post("/api/links/:id/check", async (c) => {
    try {
      return c.json(signView(await purse.checkLink(c.req.param("id"))));
    } catch (error) {
      return bad(c, failure(error), 502);
    }
  });

  // Allowances: given as limits, or said in a sentence and written by the model; either way your key signs them.
  const allowanceView = (request: SignRequest) => {
    const active = activeAllowances(store).find((one) => one.request.id === request.id);
    return { ...signView(request), use: active ? allowanceUse(active) : null };
  };
  app.get("/api/allowances", (c) => c.json(store.signRequests(50, "allow").map(allowanceView)));
  app.post("/api/allowances", async (c) => {
    const given = await body(c);
    const keys = store.signers();
    const key = typeof given.key === "string" ? given.key : keys.length === 1 ? keys[0]!.key : null;
    if (!key) return bad(c, keys.length ? "Say which key signs it." : "Add a key first: the key in your browser is one as soon as it connects.");
    let limits: Limits;
    try {
      if (typeof given.said === "string" && given.said.trim()) {
        if (!options.model) return bad(c, "Writing an allowance from your words needs a model: set NEBIUS_API_KEY, or MODEL_URL and MODEL. Or give the limits.", 501);
        limits = await limitsFromWords(options.model, given.said);
      } else {
        limits = limitsFrom(given);
      }
    } catch (error) {
      return bad(c, failure(error));
    }
    try {
      return c.json(allowanceView(await purse.startAllowance(pickShop(shops(), given.shop), key, limits)), 201);
    } catch (error) {
      return bad(c, failure(error), 409);
    }
  });
  app.post("/api/allowances/:id/stop", async (c) => {
    try {
      return c.json(allowanceView(await purse.stopAllowance(c.req.param("id"))));
    } catch (error) {
      return bad(c, failure(error), 502);
    }
  });

  // The auditor: PayPal's record of the shop's charges, checked against what your keys signed.
  const noAuditor = "The auditor reads PayPal's own record: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET.";
  app.get("/api/audit", (c) => (options.auditor ? c.json(options.auditor.view()) : bad(c, noAuditor, 501)));
  app.post("/api/audit", async (c) => (options.auditor ? c.json(await options.auditor.run()) : bad(c, noAuditor, 501)));

  app.route("/", mcpRoutes({ store, purse, version: options.version, publicUrl: options.publicUrl, ...(options.token ? { token: options.token } : {}), ...(options.shop ? { shop: options.shop } : {}), ...(options.mcpWaitMs ? { waitMs: options.mcpWaitMs } : {}) }));
  return app;
}
