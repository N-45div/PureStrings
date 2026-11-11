import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { PayPal, Purse, shopClient, Store } from "@purestrings/core";
import { readCatalog, ShopStore, shopApp } from "@purestrings/shop";
import { mcpRoutes } from "../src/mcp.ts";

/**
 * Assistants shopping through PureStrings over MCP, the way OpenClaw, Hermes Agent or Claude Code call it, at Bean &
 * Leaf answering in this process. Each has its own token; nothing is paid without your key. The charge itself runs
 * against PayPal's sandbox with PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_SANDBOX_VAULT_ID, skipped without.
 */
const SHOP_URL = "http://localhost:7700/shop";
const OWNER = "owner-token-0123456789";
const vaultId = process.env.PAYPAL_SANDBOX_VAULT_ID?.trim();
const sandbox = vaultId ? PayPal.fromEnv(process.env) : null;

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

function setUp(options: { readonly paypal?: PayPal | null; readonly waitMs?: number } = {}) {
  const shopStore = new ShopStore();
  const shop = shopApp({ catalog: readCatalog(new URL("../../shop/catalog.json", import.meta.url)), store: shopStore, paypal: options.paypal ?? null, publicUrl: SHOP_URL });
  const reach = ((url: string | URL | Request, init?: RequestInit) => shop.request(String(url).slice(SHOP_URL.length) || "/", init)) as typeof fetch;
  const store = new Store();
  const purse = new Purse(store, { shops: (url) => shopClient(url, reach) });
  const app = mcpRoutes({ store, purse, version: "test", publicUrl: "http://purestrings.test", token: OWNER, shop: SHOP_URL, waitMs: options.waitMs ?? 3_000 });
  const mine = keyPair();
  store.addSigner({ key: mine.key, name: "Desk key" });
  shopStore.saveCustomer(mine.key, vaultId ?? "VAULT-NOT-CHARGED", "buyer@example.com");
  const openclaw = store.addAgent("OpenClaw").token;
  const hermes = store.addAgent("Hermes").token;
  /** One MCP request, as a client sends it. */
  const rpc = async (method: string, params: object, token: string | null = openclaw, headers: Record<string, string> = {}) => {
    const response = await app.request("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-11-25", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  /** A tool's answer, as the assistant reads it. */
  const tool = async (name: string, args: object = {}, token: string = openclaw) => {
    const { body } = await rpc("tools/call", { name, arguments: args }, token);
    return { said: (body.result?.content ?? []).map((part: { text: string }) => part.text).join("\n") || body.error?.message || "", error: Boolean(body.result?.isError || body.error) };
  };
  /** The payment waiting for your key, once there is one. */
  const waiting = async () => {
    for (let tries = 0; tries < 100; tries += 1) {
      const first = store.waitingSignRequests()[0];
      if (first) return first;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Nothing came to the key.");
  };
  return { store, purse, mine, rpc, tool, waiting, openclaw, hermes };
}

describe("PureStrings over MCP", () => {
  it("answers only assistants with a token, and only pages from here", async () => {
    const { rpc } = setUp();
    assert.equal((await rpc("tools/list", {}, null)).status, 401);
    assert.equal((await rpc("tools/list", {}, "not-a-token")).status, 401);
    assert.equal((await rpc("tools/list", {}, undefined, { origin: "https://evil.example" })).status, 403);
    const opened = await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "openclaw", version: "1" } });
    assert.equal(opened.body.result.serverInfo.name, "purestrings");
    const listed = await rpc("tools/list", {});
    assert.deepEqual(listed.body.result.tools.map((tool: { name: string }) => tool.name), ["shop_search", "shop_buy", "payment_status", "list_payments", "list_allowances"]);
    // One shop: nothing to choose, so no shop field for an assistant to fill with a guess.
    assert.deepEqual(Object.keys(listed.body.result.tools[1].inputSchema.properties), ["items"]);
  });

  it("speaks the current revision too, where each request says its version", async () => {
    const { rpc } = setUp();
    const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } };
    const found = await rpc("server/discover", meta, undefined, { "mcp-protocol-version": "2026-07-28", "mcp-method": "server/discover" });
    assert.deepEqual(found.body.result.supportedVersions, ["2026-07-28", "2025-11-25", "2025-06-18"]);
    const called = await rpc("tools/call", { name: "list_allowances", arguments: {}, ...meta }, undefined, { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "list_allowances" });
    assert.match(called.body.result.content[0].text, /no allowances/);
  });

  it("searches the shops you added, and no others", async () => {
    const { tool } = setUp();
    const found = await tool("shop_search", { query: "chamomile tea" });
    assert.match(found.said, /Bean & Leaf \(http:\/\/localhost:7700\/shop\):\n- tea-chamomile: /);
    const elsewhere = await tool("shop_buy", { items: [{ sku: "mug" }], shop: "https://bean-and-leaf.example/shop" });
    assert.ok(elsewhere.error);
    assert.match(elsewhere.said, /only buys at shops its owner added/);
  });

  it("takes a shop you added by its name too, and no other name", async () => {
    const { tool, waiting, purse } = setUp();
    assert.match((await tool("shop_search", { query: "chai", shop: "bean & leaf" })).said, /Bean & Leaf \(http:\/\/localhost:7700\/shop\):\n- tea-chai: /);
    const asking = tool("shop_buy", { items: [{ sku: "tea-chai" }], shop: "Bean & Leaf" });
    const request = await waiting();
    assert.equal(request.shop, SHOP_URL);
    purse.decline(request.id);
    assert.match((await asking).said, /said no/);
    const other = await tool("shop_buy", { items: [{ sku: "mug" }], shop: "Beans & Leaves" });
    assert.ok(other.error);
    assert.match(other.said, /only buys at shops its owner added/);
  });

  it("puts a cart in front of your key with the assistant's name, and takes your no", async () => {
    const { tool, waiting, purse } = setUp();
    const asking = tool("shop_buy", { items: [{ sku: "beans-house", qty: 2 }] });
    const request = await waiting();
    assert.equal(request.agent, "OpenClaw");
    assert.match(request.text, /"by":"OpenClaw"/);
    purse.decline(request.id);
    assert.match((await asking).said, /^The owner said no on their key, so nothing was paid: OpenClaw asks to pay \$24\.00 to Bean & Leaf/);
  });

  it("says a payment is still waiting, and shows each assistant only its own", async () => {
    const { tool, store, hermes } = setUp({ waitMs: 200 });
    const asked = await tool("shop_buy", { items: [{ sku: "mug" }] });
    assert.match(asked.said, /^Waiting for the owner's key, with no answer yet: OpenClaw asks to pay/);
    const id = store.waitingSignRequests()[0]!.id;
    assert.match((await tool("payment_status", { id })).said, /Waiting for the owner's key: /);
    assert.match((await tool("payment_status", { id }, hermes)).said, /no payment/);
    assert.match((await tool("list_payments")).said, new RegExp(`- ${id} \\(waiting`));
    assert.match((await tool("list_payments", {}, hermes)).said, /haven't asked for any/);
    assert.match((await tool("list_payments", {}, OWNER)).said, new RegExp(id));
  });

  it("says plainly when the shop can't take the payment your key signed", async () => {
    const { tool, waiting, purse, mine } = setUp();
    const asking = tool("shop_buy", { items: [{ sku: "filters" }] });
    const request = await waiting();
    purse.sign(request.id, mine.sign(request.text), mine.key);
    const answer = await asking;
    assert.ok(answer.error);
    assert.match(answer.said, /didn't go through: .*PAYPAL_CLIENT_ID/);
  });

  it("is paid the moment your key signs", { skip: !sandbox && "set PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET and PAYPAL_SANDBOX_VAULT_ID to charge PayPal's sandbox" }, async () => {
    const { tool, waiting, purse, mine, store } = setUp({ paypal: sandbox, waitMs: 30_000 });
    const asking = tool("shop_buy", { items: [{ sku: "filters" }] });
    const request = await waiting();
    purse.sign(request.id, mine.sign(request.text), mine.key);
    const answer = await asking;
    assert.match(answer.said, /^Paid: OpenClaw asks to pay \$8\.50 to Bean & Leaf: 1× Paper filters, 100\. PayPal order \w+/);
    const paid = store.signRequest(request.id)!.result as { paypal: { captureId: string } };
    await sandbox!.refund(paid.paypal.captureId, { note: "PureStrings' MCP test" });
  });
});
