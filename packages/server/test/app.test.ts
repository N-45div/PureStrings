import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";
import { Purse, shopClient, Store } from "@purestrings/core";
import { readCatalog, ShopStore, shopApp } from "@purestrings/shop";
import { createApp } from "../src/app.ts";
import { modelFromEnv } from "../src/model.ts";

/**
 * PureStrings' API as its web app uses it, at Bean & Leaf answering in this process, with no PayPal: what PayPal
 * itself does is proved in the purse's, the MCP tools' and the key's tests. Writing an allowance from words asks
 * Nemotron with NEBIUS_API_KEY.
 */
const SHOP_URL = "http://localhost:7700/shop";
const TOKEN = "owner-token-0123456789";
const auth = { authorization: `Bearer ${TOKEN}` };
const model = modelFromEnv(process.env);

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const key = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return { key, sign: (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

function setUp(withModel = false) {
  const shopStore = new ShopStore();
  const shop = shopApp({ catalog: readCatalog(new URL("../../shop/catalog.json", import.meta.url)), store: shopStore, paypal: null, publicUrl: SHOP_URL });
  const reach = ((url: string | URL | Request, init?: RequestInit) => shop.request(String(url).slice(SHOP_URL.length) || "/", init)) as typeof fetch;
  const store = new Store();
  const purse = new Purse(store, { shops: (url) => shopClient(url, reach) });
  const app = createApp({ store, purse, version: "test", publicUrl: "http://purestrings.test", token: TOKEN, shop: SHOP_URL, model: withModel ? model : null, mcpWaitMs: 100 });
  const call = async (method: string, path: string, given?: unknown, headers: Record<string, string> = auth) => {
    const response = await app.request(path, { method, headers: { "content-type": "application/json", ...headers }, ...(given === undefined ? {} : { body: JSON.stringify(given) }) });
    return { status: response.status, body: response.status === 204 ? null : ((await response.json()) as any) };
  };
  return { store, shopStore, app, call };
}

describe("PureStrings' API", () => {
  it("takes your token for everything but what it is", async () => {
    const { call } = setUp();
    const info = await call("GET", "/api/info", undefined, {});
    assert.deepEqual([info.status, info.body.token, info.body.shop, info.body.mcp], [200, true, SHOP_URL, "http://purestrings.test/mcp"]);
    assert.equal((await call("GET", "/api/agents", undefined, {})).status, 401);
    assert.equal((await call("GET", "/api/agents", undefined, { authorization: "Bearer wrong" })).status, 401);
    assert.equal((await call("GET", "/api/agents")).status, 200);
  });

  it("gives each assistant its own token for /mcp, shown once, and takes it back", async () => {
    const { call, store } = setUp();
    const added = await call("POST", "/api/agents", { name: "OpenClaw" });
    assert.equal(added.status, 201);
    assert.equal(added.body.mcp.config.mcpServers.purestrings.url, "http://purestrings.test/mcp");
    assert.match(added.body.mcp.claudeCode, /^claude mcp add --transport http purestrings http:\/\/purestrings\.test\/mcp --header "Authorization: Bearer /);
    assert.equal((await call("POST", "/api/agents", { name: "openclaw" })).status, 409);
    assert.equal((await call("POST", "/api/agents", { name: "You" })).status, 409);
    assert.equal((await call("POST", "/api/agents", { name: "<script>" })).status, 400);
    const mcp = (token: string) => call("POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { authorization: `Bearer ${token}` });
    assert.equal((await mcp(added.body.token)).status, 200);
    assert.ok(!JSON.stringify(await call("GET", "/api/agents")).includes(added.body.token), "the token isn't shown again");
    assert.equal((await call("DELETE", `/api/agents/${added.body.agent.id}`)).status, 204);
    assert.equal((await mcp(added.body.token)).status, 401);
    assert.equal(store.agents().length, 0);
  });

  it("adds a button with its own token, and a key in a browser by its public key", async () => {
    const { call } = setUp();
    const button = await call("POST", "/api/devices", { name: "Desk button" });
    assert.deepEqual([button.status, button.body.ws], [201, "ws://purestrings.test/keys/ws"]);
    const mine = keyPair();
    assert.equal((await call("POST", "/api/keys", { key: mine.key, name: "My laptop" })).body.name, "My laptop");
    assert.equal((await call("POST", "/api/keys", { key: "not-a-key" })).status, 400);
    assert.equal((await call("GET", "/api/keys")).body.length, 1);
    assert.equal((await call("DELETE", `/api/keys/${mine.key}`)).status, 204);
    assert.equal((await call("DELETE", `/api/devices/${button.body.device.id}`)).status, 204);
    assert.deepEqual((await call("GET", "/api/devices")).body, []);
  });

  it("keeps to the shops you have, and lets you add more", async () => {
    const { call } = setUp();
    assert.deepEqual((await call("GET", "/api/shops")).body, [SHOP_URL]);
    assert.deepEqual((await call("PUT", "/api/shops", { shops: ["https://corner.example/shop/"] })).body, [SHOP_URL, "https://corner.example/shop"]);
    assert.equal((await call("PUT", "/api/shops", { shops: ["javascript:alert(1)"] })).status, 400);
    assert.match((await call("GET", "/api/shops/search?q=decaf&shop=http://localhost:7700/shop")).body.text, /beans-decaf/);
  });

  it("puts a cart in front of your key, and takes only its signature or your no", async () => {
    const { call } = setUp();
    const mine = keyPair();
    await call("POST", "/api/keys", { key: mine.key });
    const asked = await call("POST", "/api/shops/buy", { items: [{ sku: "tea-chai", qty: 2 }], agent: "Browser assistant" });
    assert.equal(asked.status, 201);
    assert.match(asked.body.line, /^Browser assistant asks to pay \$\d+\.\d{2} to Bean & Leaf: 2× /);
    assert.equal(asked.body.signed.by, "Browser assistant");
    const waiting = (await call("GET", "/api/signs?kind=buy")).body;
    assert.deepEqual(waiting.map((one: { id: string }) => one.id), [asked.body.id]);
    const stranger = keyPair();
    assert.match((await call("POST", `/api/signs/${asked.body.id}`, { signature: stranger.sign(asked.body.text), key: stranger.key })).body.error, /isn't one of yours/);
    assert.equal((await call("POST", `/api/signs/${asked.body.id}/decline`)).body.status, "declined");
    assert.equal((await call("POST", `/api/signs/${asked.body.id}/decline`)).status, 409);
  });

  it("starts a link and an allowance for your key to sign", async () => {
    const { call } = setUp();
    const mine = keyPair();
    await call("POST", "/api/keys", { key: mine.key });
    const link = await call("POST", "/api/links", { key: mine.key });
    assert.deepEqual([link.status, link.body.kind, link.body.status], [201, "link", "waiting"]);
    const allowance = await call("POST", "/api/allowances", { for: "Tea", each: "10", total: "30", per: "week", days: 7 });
    assert.deepEqual([allowance.status, allowance.body.signed.each, allowance.body.signed.total], [201, "10.00", "30.00"]);
    assert.match(allowance.body.line, /^Let PureStrings spend up to \$10\.00 a time and \$30\.00 a week at Bean & Leaf, for Tea/);
    const said = await call("POST", "/api/allowances", { said: "tea, $10 a week" });
    assert.deepEqual([said.status, said.body.error], [501, "Writing an allowance from your words needs a model: set NEBIUS_API_KEY, or MODEL_URL and MODEL. Or give the limits."]);
    assert.equal((await call("GET", "/api/audit")).status, 501);
  });

  it("writes an allowance from what you say, with Nemotron", { skip: !model && "set NEBIUS_API_KEY to ask Nemotron on Token Factory" }, async () => {
    const { call } = setUp(true);
    await call("POST", "/api/keys", { key: keyPair().key });
    const said = await call("POST", "/api/allowances", { said: "Coffee beans, at most $20 each time and $60 a month" });
    assert.equal(said.status, 201, JSON.stringify(said.body));
    assert.deepEqual([said.body.signed.each, said.body.signed.total, said.body.signed.per], ["20.00", "60.00", "month"]);
  });
});
