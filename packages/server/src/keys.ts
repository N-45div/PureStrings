import { amountText, type Change, fingerprint, keyText, parseSignable, type Purse, type Signer, type Store } from "@purestrings/core";
import type { Hono } from "hono";
import type { UpgradeWebSocket, WSContext } from "hono/ws";
import { bearerOf, same } from "./auth.ts";
import { paymentLine } from "./shops.ts";

/**
 * Your keys' link to PureStrings: the PureStrings button, or the virtual key in your browser, connects here over a
 * WebSocket. It's shown what's waiting for its signature (exactly the text it signs), signs it or says no, and is
 * told how it went. A key's private half never leaves it; PureStrings holds only its public key, pinned the first
 * time it connects, so a swapped key can't pay as yours.
 */

/** What a key shows: something to sign, or nothing waiting. */
export type Screen =
  | {
      readonly type: "sign";
      readonly id: string;
      readonly kind: "buy" | "link" | "allow";
      /** Who asked, for a heading: an assistant's name, or what it is. */
      readonly flow: string;
      /** Exactly what the key signs; it shows the facts from this, never from `line`. */
      readonly text: string;
      /** The same in one line, for saying aloud and for screens that can't read the text. */
      readonly line: string;
      readonly expires: string;
      /** How many more are waiting after this one. */
      readonly more: number;
    }
  | { readonly type: "idle"; readonly spentTodayUsd: number; readonly nextRun: null; readonly flows: readonly [] };

export type ToKey =
  | { readonly type: "hello"; readonly name: string; readonly version: string; readonly speech: false }
  | Screen
  | { readonly type: "signer"; readonly ok: boolean; readonly fingerprint: string; readonly name: string; readonly problem?: string }
  | { readonly type: "signed"; readonly id: string }
  | { readonly type: "answered"; readonly id: string; readonly yes: false }
  /** What came of what the key signed: paid; linking (finish on PayPal's page); set (an allowance); or failed, with why. */
  | { readonly type: "payment"; readonly id: string; readonly status: "paid" | "linking" | "set" | "failed"; readonly line: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "pong" };

type FromKey = { readonly type?: unknown; readonly id?: unknown; readonly signature?: unknown; readonly key?: unknown };

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class KeyHub {
  private readonly store: Store;
  private readonly purse: Purse;
  private readonly now: () => number;

  constructor(store: Store, purse: Purse, options: { readonly now?: () => number } = {}) {
    this.store = store;
    this.purse = purse;
    this.now = options.now ?? Date.now;
  }

  /** What every key shows now: the oldest thing waiting for a signature, or how much was paid today. */
  screen(): Screen {
    const waiting = this.store.waitingSignRequests();
    const first = waiting[0];
    if (first) {
      const flow = first.kind === "link" ? "Link a shop" : first.kind === "allow" ? "An allowance" : first.agent ? `${first.agent} asks` : "A payment";
      return { type: "sign", id: first.id, kind: first.kind, flow, text: first.text, line: paymentLine(first), expires: first.expires, more: waiting.length - 1 };
    }
    const start = new Date(this.now());
    start.setHours(0, 0, 0, 0);
    let spent = 0;
    for (const request of this.store.signRequests(200, "buy")) {
      if (request.status !== "paid" || (request.signedAt ?? request.createdAt) < start.toISOString()) continue;
      const payment = parseSignable(request.text);
      if (payment.kind === "buy" && payment.currency === "USD") spent += Number(payment.total);
    }
    return { type: "idle", spentTodayUsd: Math.round(spent * 100) / 100, nextRun: null, flows: [] };
  }

  /**
   * A key connected: it's sent the screen now and whenever it changes, and told how what it signed went. Returns
   * what to call with each message it sends, and when it goes.
   */
  connect(send: (message: ToKey) => void, hello: { readonly name: string; readonly version: string; readonly deviceId?: string | null }) {
    let last = "";
    /** The key this one signs with, once it's said it and PureStrings holds it; why not, when it's refused. */
    let signer: Signer | null = null;
    let problem: string | null = null;
    const signedHere = new Set<string>();
    const since = new Date(this.now()).toISOString();
    const told = new Set<string>();

    const show = () => {
      const screen = this.screen();
      const shown = JSON.stringify(screen);
      if (shown === last) return;
      last = shown;
      send(screen);
    };

    /** How each thing this key signed went, once the shop has answered; and payments made under an allowance meanwhile. */
    const tell = () => {
      for (const id of signedHere) {
        const request = this.store.signRequest(id);
        if (!request) continue;
        const linking = request.kind === "link" && request.status === "signed" && typeof (request.result as { approveUrl?: unknown } | null)?.approveUrl === "string";
        const set = request.kind === "allow" && request.status === "active";
        if (request.status !== "paid" && request.status !== "failed" && !linking && !set) continue;
        signedHere.delete(id);
        const status = request.status === "failed" ? "failed" : linking ? "linking" : set ? "set" : "paid";
        let line = status === "failed" ? `It didn't go through: ${request.error ?? "the shop said no"}` : "Paid.";
        const signed = parseSignable(request.text);
        if (status === "paid" && signed.kind === "buy") line = `Paid ${amountText(signed.total, signed.currency)} to ${signed.shop.name} with PayPal.`;
        if (status === "linking") line = `Signed. To finish, say yes on PayPal's page in PureStrings, and ${signed.shop.name} is linked.`;
        if (status === "set" && signed.kind === "allow") line = `Allowance set: up to ${amountText(signed.each, signed.currency)} a time and ${amountText(signed.total, signed.currency)} a ${signed.per} at ${signed.shop.name}.`;
        send({ type: "payment", id, status, line });
      }
      for (const request of this.store.signRequests(20, "buy")) {
        if (request.status !== "paid" || (request.signedAt ?? "") < since || told.has(request.id)) continue;
        const payment = parseSignable(request.text);
        if (payment.kind !== "buy" || !payment.allow) continue;
        told.add(request.id);
        send({ type: "payment", id: request.id, status: "paid", line: `${payment.by ?? "PureStrings"} paid ${amountText(payment.total, payment.currency)} to ${payment.shop.name} under your allowance.` });
      }
    };

    /**
     * The key says its public key: kept the first time (a button by its device, a key in a browser by the key
     * itself), and from then on only that key signs for it. A button that comes back with another key is refused
     * until it's removed and added again.
     */
    const pin = (raw: string) => {
      let key: string;
      signer = null;
      problem = null;
      try {
        key = keyText(raw);
      } catch (error) {
        problem = `That key isn't one PureStrings can use: ${failure(error)}`;
        return send({ type: "error", message: problem });
      }
      const deviceId = hello.deviceId ?? null;
      const held = deviceId ? this.store.signerForDevice(deviceId) : this.store.signer(key);
      if (held && held.key !== key) {
        problem = `This button's key changed since it was added (it was ${held.fingerprint}, now ${fingerprint(key)}), so it signs nothing. If you replaced its firmware, remove it in Keys and add it again.`;
      } else if (held) {
        signer = held;
      } else {
        try {
          signer = this.store.addSigner({ key, name: deviceId ? hello.name : "Key in a browser", deviceId });
        } catch (error) {
          problem = `PureStrings can't take this key: ${failure(error)}`;
        }
      }
      send({ type: "signer", ok: signer !== null, fingerprint: fingerprint(key), name: signer?.name ?? hello.name, ...(problem ? { problem } : {}) });
    };

    const onChange = (change: Change) => {
      if (change.kind === "sign") tell();
      show();
    };

    send({ type: "hello", name: hello.name, version: hello.version, speech: false });
    show();
    this.store.events.on("change", onChange);
    // A waiting payment expires, and a new day starts, without a change: look again each minute.
    const tick = setInterval(show, 60_000);
    tick.unref?.();

    return {
      receive: (raw: string) => {
        let message: FromKey | null;
        try {
          message = JSON.parse(raw) as FromKey | null;
        } catch {
          return send({ type: "error", message: "Send JSON." });
        }
        switch (message?.type) {
          case "ping":
            return send({ type: "pong" });
          case "hello":
            if (typeof message.key === "string") pin(message.key);
            return;
          case "sign": {
            if (typeof message.id !== "string" || typeof message.signature !== "string") break;
            if (!signer) return send({ type: "error", message: problem ?? "This key hasn't said its public key, so it can't sign: update its firmware." });
            try {
              this.purse.sign(message.id, message.signature, signer.key);
              signedHere.add(message.id);
              send({ type: "signed", id: message.id });
            } catch (error) {
              send({ type: "error", message: failure(error) });
            }
            return show();
          }
          case "decline": {
            if (typeof message.id !== "string") break;
            try {
              this.purse.decline(message.id);
              send({ type: "answered", id: message.id, yes: false });
            } catch (error) {
              send({ type: "error", message: failure(error) });
            }
            return show();
          }
        }
        send({ type: "error", message: `PureStrings doesn't know "${String(message?.type ?? "")}" with what was sent.` });
      },
      close: () => {
        clearInterval(tick);
        this.store.events.off("change", onChange);
      },
    };
  }
}

/** /keys/ws: a button with its own key token, or the virtual key in your browser with your PureStrings token. */
export function keyRoutes(app: Hono, options: { readonly store: Store; readonly hub: KeyHub; readonly version: string; readonly token?: string; readonly upgradeWebSocket: UpgradeWebSocket }): void {
  app.get(
    "/keys/ws",
    async (c, next) => {
      const given = bearerOf(c.req.header("authorization")) ?? c.req.query("token") ?? "";
      const device = given ? options.store.deviceByToken(given) : null;
      if (device || !options.token || same(given, options.token)) {
        c.set("keyName" as never, (device?.name ?? "Key in a browser") as never);
        c.set("deviceId" as never, (device?.id ?? null) as never);
        return next();
      }
      return c.json({ error: "Send the button's key token, or your PureStrings token, as Authorization: Bearer <token> or ?token=." }, 401);
    },
    options.upgradeWebSocket((c) => {
      const name = String(c.get("keyName" as never) ?? "A key");
      const deviceId = (c.get("deviceId" as never) as string | null | undefined) ?? null;
      let session: ReturnType<KeyHub["connect"]> | null = null;
      return {
        onOpen: (_event, socket: WSContext) => {
          session = options.hub.connect((message) => socket.send(JSON.stringify(message)), { name, version: options.version, deviceId });
        },
        onMessage: (event) => {
          if (typeof event.data === "string") session?.receive(event.data);
        },
        onClose: () => session?.close(),
        onError: () => session?.close(),
      };
    }),
  );
}
