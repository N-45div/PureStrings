/**
 * A PureStrings key in a terminal: the whole key protocol (docs/key-protocol.md) in one file, to read when you build
 * a key for another device, and to run against your PureStrings.
 *
 *   node scripts/terminal-key.ts
 *
 * Settings: PURESTRINGS_URL (default http://localhost:7700); KEY_TOKEN, the token PureStrings gives a new key
 * (Key screen, "Add a button"), or PURESTRINGS_TOKEN, yours; KEY_FILE, where its key is kept (default
 * ~/.purestrings-terminal-key.json).
 *
 * It makes a P-256 key the first time and keeps it in that file. It connects to /keys/ws and shows each thing it's
 * asked to sign, read from the text it signs. Type the total to pay (or "link", or "allow"), or "no".
 *
 * A key in a file is only as safe as the computer it's on, and here the screen and the keyboard are that computer's
 * too. It's for trying the protocol, not for your money: the button shows and signs on its own chip.
 */
import { createPrivateKey, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { amountText, expired, fingerprint, parseSignable, type Signable } from "@purestrings/core";

const base = (process.env.PURESTRINGS_URL ?? "http://localhost:7700").replace(/\/$/, "");
const token = process.env.KEY_TOKEN ?? process.env.PURESTRINGS_TOKEN ?? "";
const file = process.env.KEY_FILE ?? join(homedir(), ".purestrings-terminal-key.json");
const say = (line = "") => console.log(line);

interface Kept {
  readonly d: string;
  readonly x: string;
  readonly y: string;
  /** The shops this key has signed for: one it hasn't gets a warning, so a lookalike stands out. */
  readonly shops: string[];
}

/** This key, made the first time and kept in KEY_FILE (readable by you alone, where the system allows it). */
function loadKey(): { kept: Kept; privateKey: KeyObject; raw: string } {
  let kept: Kept;
  if (existsSync(file)) {
    kept = JSON.parse(readFileSync(file, "utf8")) as Kept;
  } else {
    const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "jwk" }) as { d: string; x: string; y: string };
    kept = { d: jwk.d, x: jwk.x, y: jwk.y, shops: [] };
    writeFileSync(file, JSON.stringify(kept), { mode: 0o600 });
  }
  const privateKey = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: kept.d, x: kept.x, y: kept.y }, format: "jwk" });
  // The public key as every key says it: the uncompressed point (0x04, x, y), base64url.
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(kept.x, "base64url"), Buffer.from(kept.y, "base64url")]).toString("base64url");
  return { kept, privateKey, raw };
}

const { kept, privateKey, raw } = loadKey();

/** ECDSA P-256 over SHA-256 of the text's UTF-8, as r and s side by side (64 bytes), base64url. */
const signText = (text: string) => sign("sha256", Buffer.from(text, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");

/** What it's waiting on: the one thing shown, and what to type to sign it. */
let waiting: { id: string; text: string; signable: Signable; answer: string } | null = null;
/** True from answering until the screen moves on, so that isn't reported as answered elsewhere. */
let answered = false;
let socket: WebSocket | null = null;
const send = (message: object) => socket?.send(JSON.stringify(message));

/** Shows what's asked, from the text alone: never from `line` or `flow`, which PureStrings writes beside it. */
function show(id: string, text: string, more: number): void {
  let signable: Signable;
  try {
    signable = parseSignable(text);
  } catch (error) {
    say(`\nPureStrings asked this key to sign something it can't read, so it says no: ${(error as Error).message}`);
    send({ type: "decline", id });
    return;
  }
  if (expired(signable)) return say("\nSomething to sign came in already expired; it's left alone.");
  const shop = `${signable.shop.name} (${signable.shop.id})`;
  const fresh = !kept.shops.includes(signable.shop.id);
  say("\n----------------------------------------------------------------");
  if (signable.kind === "buy") {
    say(`${signable.by ?? "Someone"} asks to pay ${amountText(signable.total, signable.currency)} to ${shop}`);
    for (const item of signable.items) say(`  ${item.qty} × ${item.name}  ${amountText(item.price, signable.currency)}`);
    say(`  Total ${amountText(signable.total, signable.currency)}, until ${signable.expires}`);
  } else if (signable.kind === "link") {
    say(`Link your PayPal at ${shop} to this key: from then on it charges you for carts this key signs.`);
  } else {
    say(`Let PureStrings${signable.by ? `, for ${signable.by} only,` : ""} spend at ${shop}, for ${signable.for}:`);
    say(`  up to ${amountText(signable.each, signable.currency)} a time and ${amountText(signable.total, signable.currency)} a ${signable.per}, until ${signable.expires}`);
  }
  if (fresh) say(`NEW: this key hasn't signed for ${signable.shop.id} before. Check it's the shop you mean.`);
  if (more) say(`(${more} more waiting after this)`);
  const answer = signable.kind === "buy" ? signable.total : signable.kind;
  waiting = { id, text, signable, answer };
  say(`Type ${answer} to sign it, or no.`);
}

function onMessage(data: string): void {
  const message = JSON.parse(data) as Record<string, unknown> & { type: string };
  switch (message.type) {
    case "hello":
      // PureStrings says hello; the key answers with its public key, which PureStrings pins the first time.
      return send({ type: "hello", key: raw });
    case "signer":
      return say(message.ok ? `PureStrings keeps this key: ${message.fingerprint}` : `PureStrings refused this key: ${String(message.problem ?? "see Keys")}`);
    case "sign":
      if (waiting?.id === message.id) return;
      return show(String(message.id), String(message.text), Number(message.more ?? 0));
    case "idle":
      if (answered) return void (answered = false); // the screen moved on because this key just answered
      if (waiting) say("\nThat was answered elsewhere, or ran out.");
      waiting = null;
      return say(`Nothing to sign. Paid today: $${Number(message.spentTodayUsd ?? 0).toFixed(2)}.`);
    case "signed":
      return say("Signed. The shop checks it and charges PayPal...");
    case "answered":
      return say("Refused. Nothing was paid.");
    case "payment":
      return say(String(message.line));
    case "error":
      return say(`PureStrings: ${String(message.message)}`);
  }
}

const input = createInterface({ input: process.stdin });
input.on("line", (typed) => {
  const now = waiting;
  if (!now) return;
  const answer = typed.trim();
  if (/^no?$/i.test(answer)) {
    waiting = null;
    answered = true;
    return send({ type: "decline", id: now.id });
  }
  if (answer !== now.answer) return say(`Type ${now.answer} to sign it, or no.`);
  if (expired(now.signable)) return say("It ran out before you signed it.");
  waiting = null;
  answered = true;
  if (!kept.shops.includes(now.signable.shop.id)) {
    kept.shops.push(now.signable.shop.id);
    writeFileSync(file, JSON.stringify(kept), { mode: 0o600 });
  }
  // It signs exactly the text it was sent: the one it read what it showed from.
  send({ type: "sign", id: now.id, signature: signText(now.text) });
});

function connect(): void {
  const url = `${base.replace(/^http/, "ws")}/keys/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const ws = new WebSocket(url);
  socket = ws;
  let ping: ReturnType<typeof setInterval> | undefined;
  ws.addEventListener("open", () => {
    say(`This key (${fingerprint(raw)}) is connected to ${base}.`);
    ping = setInterval(() => send({ type: "ping" }), 25_000);
  });
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") onMessage(event.data); // binary is PureStrings' voice, for a key with a speaker
  });
  ws.addEventListener("close", (event) => {
    clearInterval(ping);
    waiting = null;
    say(`Lost PureStrings (${event.code}${event.reason ? `: ${event.reason}` : ""}); trying again in 3 s.`);
    setTimeout(connect, 3_000);
  });
}

say(`A PureStrings key in this terminal. Its key is kept in ${file}.`);
connect();
