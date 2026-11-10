import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import { PayPal, Purse, shopClient, Store } from "@purestrings/core";
import { demoShop } from "@purestrings/shop";
import { createApp } from "./app.ts";
import { Auditor, disputeWriter } from "./auditor.ts";
import { KeyHub, keyRoutes } from "./keys.ts";
import { modelFromEnv } from "./model.ts";
import { usbButtons } from "./usb.ts";
import { voiceFromEnv } from "./voice.ts";
import { webApp } from "./static.ts";

/**
 * Starts PureStrings. Settings, from the environment:
 *   PURESTRINGS_HOST    the address to listen on (default 127.0.0.1, this machine only)
 *   PORT                default 7700
 *   PURESTRINGS_TOKEN   your token for the web app and API; required unless listening on this machine only
 *   PURESTRINGS_PUBLIC_URL  how you, your keys and your assistants reach it (on Render, its own address)
 *   PURESTRINGS_DB      where to keep everything (default data/purestrings.db; the demo shop's beside it)
 *   PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET (and PAYPAL_ENVIRONMENT=live to leave the sandbox): the demo shop
 *                       takes PayPal, and the auditor reads PayPal's record. PAYPAL_WEBHOOK_ID checks its events.
 *   PURESTRINGS_SHOP    on, or off: the demo shop without PayPal, or none at all
 *   NEBIUS_API_KEY      Nemotron on Token Factory writes allowances from your words and drafts disputes
 *                       (or MODEL_URL and MODEL for any OpenAI-style chat API)
 *   AUDIT_MINUTES       how often the auditor checks PayPal's record (default 10)
 *   OPENAI_API_KEY      the button speaks what it's asked to sign, and how it went (VOICE=off for quiet)
 *   PURESTRINGS_USB     on (default), or off: PureStrings runs a button plugged into this machine itself
 */

const env = (name: string) => process.env[name]?.trim() || undefined;
const host = env("PURESTRINGS_HOST") ?? "127.0.0.1";
const port = Number(env("PORT") ?? 7700);
const token = env("PURESTRINGS_TOKEN");
const loopback = host === "127.0.0.1" || host === "::1" || host === "localhost";
const auditMinutes = Number(env("AUDIT_MINUTES") ?? 10);

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`PORT must be a port number, not "${env("PORT")}".`);
if (!loopback && !token) {
  console.error(`PureStrings won't listen on ${host} without a token: anyone who reaches it could spend your money.\nSet PURESTRINGS_TOKEN to a long random string (e.g. openssl rand -hex 32), or listen on 127.0.0.1.`);
  process.exit(1);
}
if (token && token.length < 16) {
  console.error("PURESTRINGS_TOKEN is too short; use at least 16 characters (e.g. openssl rand -hex 32).");
  process.exit(1);
}
if (!(auditMinutes >= 1)) throw new Error(`AUDIT_MINUTES must be a number of minutes, not "${env("AUDIT_MINUTES")}".`);

const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
const publicUrl = (env("PURESTRINGS_PUBLIC_URL") ?? env("RENDER_EXTERNAL_URL") ?? `http://${loopback || host === "0.0.0.0" || host === "::" ? "localhost" : host}:${port}`).replace(/\/$/, "");
const db = env("PURESTRINGS_DB") ?? "data/purestrings.db";
mkdirSync(dirname(db), { recursive: true });
const store = new Store(db);

// Bean & Leaf, the demo shop, with its own database: PureStrings reaches it in this process, as it would any shop.
const shop = demoShop(process.env, { publicUrl: `${publicUrl}/shop`, db: join(dirname(db), "shop.db") });
const shopUrl = shop ? `${publicUrl}/shop` : undefined;
const local = shop && shopUrl ? (((url: string | URL | Request, init?: RequestInit) => shop.app.request(String(url).slice(shopUrl.length) || "/", init)) as typeof fetch) : null;
const purse = new Purse(store, { shops: (url) => shopClient(url, local && url.replace(/\/+$/, "") === shopUrl ? local : globalThis.fetch) });

const model = modelFromEnv(process.env);
const paypal = PayPal.fromEnv(process.env);
const auditor = paypal ? new Auditor(store, paypal, { merchant: shop?.name ?? "the shop", ...(model ? { writer: disputeWriter(model) } : {}) }) : null;

const app = createApp({ store, purse, version, publicUrl, ...(token ? { token } : {}), ...(shopUrl ? { shop: shopUrl } : {}), paypal: shop?.paypal ?? null, model, auditor, usb: () => usb?.linked() ?? null });
if (shop) {
  app.get("/shop/", (c) => c.redirect("/shop", 308));
  app.route("/shop", shop.app);
}
const websockets = createNodeWebSocket({ app });
const voice = voiceFromEnv(process.env);
const hub = new KeyHub(store, purse, { voice });
keyRoutes(app, { store, hub, version, publicUrl, ...(token ? { token } : {}), upgradeWebSocket: websockets.upgradeWebSocket });
const web = env("PURESTRINGS_WEB") ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const built = existsSync(join(web, "index.html"));
app.use("*", webApp(web));
if (!built) app.get("/", (c) => c.text("PureStrings is running, but its web app isn't built yet: run npm run build, then restart.", 503));

// The auditor checks PayPal's record against what your keys signed: soon after starting, then every few minutes.
if (auditor) {
  const check = () => void auditor.run().catch((error: unknown) => console.error("[purestrings] audit:", error instanceof Error ? error.message : error));
  setTimeout(check, 15_000).unref();
  setInterval(check, auditMinutes * 60_000).unref();
}

const server = serve({ fetch: app.fetch, hostname: host, port }, () => {
  console.log(`PureStrings ${version} is on ${publicUrl}${token ? " (token required)" : ""}`);
  console.log(`  MCP for your assistants (OpenClaw, Hermes Agent, Claude Code, any MCP client): ${publicUrl}/mcp, with a token from Assistants`);
  console.log(`  Your keys: ${publicUrl.replace(/^http/, "ws")}/keys/ws (the button, with a token from Keys; the key in your browser, with yours)`);
  if (shop) console.log(`  Demo shop: ${shop.name} at ${shopUrl}, ${shop.paypal ? `on PayPal's ${shop.paypal}` : "without PayPal (set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET to link and charge)"}`);
  console.log(`  Auditor: ${auditor ? `reads PayPal's record every ${auditMinutes} minutes${model ? `; ${model.name} drafts disputes` : ""}` : "off (set PayPal's keys)"}`);
  console.log(`  Allowances from your words: ${model ? model.name : "off (set NEBIUS_API_KEY, or MODEL_URL and MODEL)"}`);
  console.log(`  The button's voice: ${voice ? voice.name : "off (set OPENAI_API_KEY, or MODEL_URL to OpenAI's with MODEL_KEY)"}`);
  console.log(`  A button on this machine's USB: ${usb ? "PureStrings links it itself when it's plugged in" : "left to the Key screen (PURESTRINGS_USB=off)"}`);
  if (!built) console.log(`  The web app isn't built (no ${join(web, "index.html")}): run npm run build.`);
});

// The button plugged into this machine: PureStrings finds it and links it, with no browser in between.
const usb = env("PURESTRINGS_USB") === "off" ? null : usbButtons({ store, hub, version });

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") console.error(`Port ${port} is already in use (another PureStrings?). Stop it, or set PORT to a free port.`);
  else console.error(error);
  store.close();
  process.exit(1);
});

function shutdown(): void {
  void usb?.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // Open event streams keep the server from closing; don't wait on them for long.
  setTimeout(() => process.exit(0), 3_000).unref();
}
websockets.injectWebSocket(server);
// A socket that errors while it's being upgraded mustn't take the server down.
server.on("upgrade", (_request, socket) => socket.on("error", () => undefined));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
