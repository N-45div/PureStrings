import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { Finding } from "./audit.ts";
import { fingerprint } from "./countersign.ts";

/**
 * What PureStrings keeps, in one SQLite file: the assistants allowed to shop for you (each by its own token), your
 * keys (a board on your desk, or one in your browser), everything a key was asked to sign and what came of it, a
 * few settings of its own, and what the auditor found at PayPal.
 */

/** An assistant that shops for you: OpenClaw, Hermes, Claude... It asks; it never pays. */
export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
}

/** A board of yours that connects on its own (Wi-Fi or USB), by the token you gave it. */
export interface Device {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
}

/** A key that signs for you: a board, or one in a browser. Only its signature pays. */
export interface Signer {
  /** Its P-256 public key, raw and base64url, written the one way. */
  readonly key: string;
  readonly fingerprint: string;
  readonly name: string;
  /** The board it is, when it's one; null for a key in a browser. */
  readonly deviceId: string | null;
  readonly createdAt: string;
  readonly lastSignedAt: string | null;
}

/**
 * Something waiting for your key's signature: a payment an assistant asked for, linking your key to your PayPal at a
 * shop, or an allowance. `text` is exactly what the key is shown (or says) and signs.
 */
export interface SignRequest {
  /** The signable's own one-time id (pay_…, link_…, allow_…). */
  readonly id: string;
  readonly kind: "buy" | "link" | "allow";
  readonly text: string;
  /**
   * waiting for the key; signed; then paid (a payment), linked (a link) or active (an allowance the shop took,
   * until it's stopped); or declined, expired or failed.
   */
  readonly status: "waiting" | "signed" | "paid" | "linked" | "active" | "stopped" | "declined" | "expired" | "failed";
  /** The assistant that asked for it, by name; null for what you started yourself. */
  readonly agent: string | null;
  /** The shop's address. */
  readonly shop: string;
  readonly expires: string;
  readonly signature: string | null;
  /** The key that signed it. */
  readonly key: string | null;
  /** What came of it: the shop's order, once paid; the link or allowance as the shop holds it. */
  readonly result: unknown;
  readonly error: string | null;
  readonly createdAt: string;
  readonly signedAt: string | null;
}

export type Change = { readonly kind: "sign" } | { readonly kind: "keys" } | { readonly kind: "agents" } | { readonly kind: "audit" };

type Row = Record<string, unknown>;
const now = () => new Date().toISOString();
const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;
const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(24).toString("base64url");
const optional = (value: unknown) => (value == null ? null : String(value));

export class Store {
  readonly db: DatabaseSync;
  /** Emits "change" with a Change after every write. */
  readonly events = new EventEmitter();

  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_seen_at TEXT);
      CREATE TABLE IF NOT EXISTS signers (key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, name TEXT NOT NULL, device_id TEXT UNIQUE, created_at TEXT NOT NULL, last_signed_at TEXT);
      CREATE TABLE IF NOT EXISTS signs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL, status TEXT NOT NULL, agent TEXT, shop TEXT NOT NULL, expires TEXT NOT NULL, signature TEXT, key TEXT, result TEXT, error TEXT, created_at TEXT NOT NULL, signed_at TEXT);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audits (capture_id TEXT PRIMARY KEY, verdict TEXT NOT NULL, why TEXT NOT NULL, sign_id TEXT, order_id TEXT, invoice_id TEXT, amount TEXT NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, at TEXT NOT NULL, draft TEXT, checked_at TEXT NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  private changed(change: Change): void {
    this.events.emit("change", change);
  }

  // Assistants that shop for you, each by its own token ----------------------------------------------

  /** Adds an assistant; its token is shown this once, and kept only as a hash. */
  addAgent(name: string): { readonly agent: Agent; readonly token: string } {
    const token = newToken();
    const id = newId("agent");
    this.db.prepare("INSERT INTO agents (id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, NULL)").run(id, name.trim().slice(0, 60) || "An assistant", hashToken(token), now());
    this.changed({ kind: "agents" });
    return { agent: this.agent(id)!, token };
  }

  agent(id: string): Agent | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return row ? toAgent(row) : null;
  }

  /** The assistant a token is, when it's one; it's marked as seen. */
  agentByToken(token: string): Agent | null {
    const row = this.db.prepare("SELECT * FROM agents WHERE token_hash = ?").get(hashToken(token)) as Row | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(now(), String(row.id));
    return toAgent(row);
  }

  agents(): Agent[] {
    return (this.db.prepare("SELECT * FROM agents ORDER BY created_at").all() as Row[]).map(toAgent);
  }

  removeAgent(id: string): boolean {
    const removed = Number(this.db.prepare("DELETE FROM agents WHERE id = ?").run(id).changes) > 0;
    if (removed) this.changed({ kind: "agents" });
    return removed;
  }

  // Boards, and the keys that sign -------------------------------------------------------------------

  /** Adds a board that connects on its own; its token is shown this once. */
  addDevice(name: string): { readonly device: Device; readonly token: string } {
    const token = newToken();
    const id = newId("device");
    this.db.prepare("INSERT INTO devices (id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, NULL)").run(id, name.trim().slice(0, 60) || "A board", hashToken(token), now());
    this.changed({ kind: "keys" });
    return { device: this.device(id)!, token };
  }

  device(id: string): Device | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Row | undefined;
    return row ? toDevice(row) : null;
  }

  deviceByToken(token: string): Device | null {
    const row = this.db.prepare("SELECT * FROM devices WHERE token_hash = ?").get(hashToken(token)) as Row | undefined;
    if (!row) return null;
    this.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now(), String(row.id));
    return toDevice(row);
  }

  devices(): Device[] {
    return (this.db.prepare("SELECT * FROM devices ORDER BY created_at").all() as Row[]).map(toDevice);
  }

  /** Takes a board off, and its key with it: it signs for nothing from then on. */
  removeDevice(id: string): boolean {
    this.db.prepare("DELETE FROM signers WHERE device_id = ?").run(id);
    const removed = Number(this.db.prepare("DELETE FROM devices WHERE id = ?").run(id).changes) > 0;
    if (removed) this.changed({ kind: "keys" });
    return removed;
  }

  /** Adds a key that signs for you; it's pinned from now on. A key or board seen already is refused. */
  addSigner(input: { readonly key: string; readonly name: string; readonly deviceId?: string | null }): Signer {
    const result = this.db
      .prepare("INSERT INTO signers (key, fingerprint, name, device_id, created_at, last_signed_at) VALUES (?, ?, ?, ?, ?, NULL) ON CONFLICT DO NOTHING")
      .run(input.key, fingerprint(input.key), input.name.trim() || "A key", input.deviceId ?? null, now());
    if (Number(result.changes) !== 1) throw new Error("That key, or that board's key, is already added.");
    this.changed({ kind: "keys" });
    return this.signer(input.key)!;
  }

  signer(key: string): Signer | null {
    const row = this.db.prepare("SELECT * FROM signers WHERE key = ?").get(key) as Row | undefined;
    return row ? toSigner(row) : null;
  }

  /** The key a board of yours signs with, pinned when it was first seen. */
  signerForDevice(deviceId: string): Signer | null {
    const row = this.db.prepare("SELECT * FROM signers WHERE device_id = ?").get(deviceId) as Row | undefined;
    return row ? toSigner(row) : null;
  }

  signers(): Signer[] {
    return (this.db.prepare("SELECT * FROM signers ORDER BY created_at").all() as Row[]).map(toSigner);
  }

  /** Takes a key off: its signature counts for nothing here from then on. */
  removeSigner(key: string): boolean {
    const removed = Number(this.db.prepare("DELETE FROM signers WHERE key = ?").run(key).changes) > 0;
    if (removed) this.changed({ kind: "keys" });
    return removed;
  }

  // What's waiting for a key's signature, and what came of it ----------------------------------------

  addSignRequest(input: Pick<SignRequest, "id" | "kind" | "text" | "shop" | "expires"> & { readonly agent?: string | null; readonly result?: unknown }): SignRequest {
    this.db
      .prepare("INSERT INTO signs (id, kind, text, status, agent, shop, expires, result, created_at) VALUES (?, ?, ?, 'waiting', ?, ?, ?, ?, ?)")
      .run(input.id, input.kind, input.text, input.agent ?? null, input.shop, input.expires, input.result === undefined ? null : JSON.stringify(input.result), now());
    this.changed({ kind: "sign" });
    return this.signRequest(input.id)!;
  }

  signRequest(id: string): SignRequest | null {
    const row = this.db.prepare("SELECT * FROM signs WHERE id = ?").get(id) as Row | undefined;
    return row ? toSignRequest(row) : null;
  }

  /** What's waiting for a key, oldest first. */
  waitingSignRequests(): SignRequest[] {
    return (this.db.prepare("SELECT * FROM signs WHERE status = 'waiting' ORDER BY created_at, rowid").all() as Row[]).map(toSignRequest);
  }

  /** The latest requests, newest first: payments, links and allowances, or one kind. */
  signRequests(limit = 100, kind?: SignRequest["kind"]): SignRequest[] {
    const rows = kind
      ? this.db.prepare("SELECT * FROM signs WHERE kind = ? ORDER BY created_at DESC, rowid DESC LIMIT ?").all(kind, limit)
      : this.db.prepare("SELECT * FROM signs ORDER BY created_at DESC, rowid DESC LIMIT ?").all(limit);
    return (rows as Row[]).map(toSignRequest);
  }

  /** Records a key's signature, once; false if the request wasn't waiting any more. */
  markSigned(id: string, signature: string, key: string): boolean {
    const at = now();
    const signed = Number(this.db.prepare("UPDATE signs SET status = 'signed', signature = ?, key = ?, signed_at = ? WHERE id = ? AND status = 'waiting'").run(signature, key, at, id).changes) === 1;
    if (signed) {
      this.db.prepare("UPDATE signers SET last_signed_at = ? WHERE key = ?").run(at, key);
      this.changed({ kind: "sign" });
    }
    return signed;
  }

  /** Moves a request on from `from` (one of them); false if it wasn't in it. */
  moveSignRequest(id: string, from: SignRequest["status"] | readonly SignRequest["status"][], change: { readonly status: SignRequest["status"]; readonly result?: unknown; readonly error?: string | null }): boolean {
    const froms = typeof from === "string" ? [from] : [...from];
    const result = this.db
      .prepare(`UPDATE signs SET status = ?, result = COALESCE(?, result), error = ? WHERE id = ? AND status IN (${froms.map(() => "?").join(", ")})`)
      .run(change.status, change.result === undefined ? null : JSON.stringify(change.result), change.error ?? null, id, ...froms);
    const moved = Number(result.changes) === 1;
    if (moved) this.changed({ kind: "sign" });
    return moved;
  }

  // Settings: small things PureStrings keeps about itself, like its own key -------------------------

  setting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : null;
  }

  saveSetting(key: string, value: string): void {
    this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  /** The value for `key`, made with `make` and kept the first time it's asked for. */
  settingOr(key: string, make: () => string): string {
    const existing = this.setting(key);
    if (existing !== null) return existing;
    const value = make();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
    return this.setting(key) ?? value;
  }

  // What the auditor found: each PayPal charge, and whether a key (or an allowance) signed it ----------

  /** Keeps what the auditor found for a charge; a dispute drafted for it earlier is kept unless a new one's given. */
  saveFinding(finding: Finding, draft?: string): void {
    const { charge } = finding;
    this.db
      .prepare(
        `INSERT INTO audits (capture_id, verdict, why, sign_id, order_id, invoice_id, amount, currency, status, at, draft, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (capture_id) DO UPDATE SET verdict = excluded.verdict, why = excluded.why, sign_id = excluded.sign_id, order_id = COALESCE(excluded.order_id, order_id), invoice_id = excluded.invoice_id, amount = excluded.amount, currency = excluded.currency, status = excluded.status, at = excluded.at, draft = COALESCE(excluded.draft, draft), checked_at = excluded.checked_at`,
      )
      .run(charge.captureId, finding.verdict, finding.why, finding.signId, charge.orderId, charge.invoiceId, charge.amount, charge.currency, charge.status, charge.at, draft ?? null, now());
  }

  /** What the auditor found, newest charge first, each with the dispute drafted for it, if any. */
  findings(limit = 200): (Finding & { readonly draft: string | null; readonly checkedAt: string })[] {
    return (this.db.prepare("SELECT * FROM audits ORDER BY at DESC LIMIT ?").all(limit) as Row[]).map((row) => ({
      charge: { captureId: String(row.capture_id), orderId: optional(row.order_id), invoiceId: optional(row.invoice_id), amount: String(row.amount), currency: String(row.currency), status: String(row.status), at: String(row.at) },
      verdict: String(row.verdict) as Finding["verdict"],
      why: String(row.why),
      signId: optional(row.sign_id),
      draft: optional(row.draft),
      checkedAt: String(row.checked_at),
    }));
  }

  /** Says the auditor finished a check, for whoever shows its findings. */
  audited(): void {
    this.changed({ kind: "audit" });
  }
}

function toAgent(row: Row): Agent {
  return { id: String(row.id), name: String(row.name), createdAt: String(row.created_at), lastSeenAt: optional(row.last_seen_at) };
}

function toDevice(row: Row): Device {
  return { id: String(row.id), name: String(row.name), createdAt: String(row.created_at), lastSeenAt: optional(row.last_seen_at) };
}

function toSigner(row: Row): Signer {
  return { key: String(row.key), fingerprint: String(row.fingerprint), name: String(row.name), deviceId: optional(row.device_id), createdAt: String(row.created_at), lastSignedAt: optional(row.last_signed_at) };
}

function toSignRequest(row: Row): SignRequest {
  return {
    id: String(row.id),
    kind: String(row.kind) as SignRequest["kind"],
    text: String(row.text),
    status: String(row.status) as SignRequest["status"],
    agent: optional(row.agent),
    shop: String(row.shop),
    expires: String(row.expires),
    signature: optional(row.signature),
    key: optional(row.key),
    result: row.result == null ? null : (JSON.parse(String(row.result)) as unknown),
    error: optional(row.error),
    createdAt: String(row.created_at),
    signedAt: optional(row.signed_at),
  };
}
