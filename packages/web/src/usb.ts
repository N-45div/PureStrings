import { encodeFrame, FrameReader } from "./usb-frames.ts";

/**
 * The PureStrings button on its USB cable, through this page: Chrome's and Edge's Web Serial read the button, and
 * this page passes its messages on to /keys/ws as that button, with the token it announces. No Wi-Fi, address or
 * firewall rule. The link stays up while you move between screens.
 */

/** Espressif's USB vendor id: the ESP32-S3's own USB port. */
const ESPRESSIF = 0x303a;
const KEEP_LINES = 200;

// ---- Web Serial, as much of it as this needs (not in TypeScript's DOM types yet) ---------------------------
interface SerialPortLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { readonly baudRate: number; readonly bufferSize?: number }): Promise<void>;
  close(): Promise<void>;
  setSignals?(signals: { readonly dataTerminalReady?: boolean; readonly requestToSend?: boolean }): Promise<void>;
  getInfo(): { readonly usbVendorId?: number };
}

interface SerialLike {
  requestPort(options?: { readonly filters?: readonly { readonly usbVendorId?: number }[] }): Promise<SerialPortLike>;
  getPorts(): Promise<SerialPortLike[]>;
  addEventListener(type: "connect", listener: () => void): void;
}

function webSerial(): SerialLike | null {
  return typeof navigator !== "undefined" && "serial" in navigator ? (navigator as Navigator & { serial: SerialLike }).serial : null;
}

export type UsbState = "closed" | "waiting" | "connecting" | "live";

export interface UsbLine {
  readonly id: number;
  readonly text: string;
  readonly from: "button" | "link";
}

export interface UsbSnapshot {
  readonly state: UsbState;
  readonly lines: readonly UsbLine[];
  readonly error: string | null;
}

let snapshot: UsbSnapshot = { state: "closed", lines: [], error: null };
let lineId = 0;
const listeners = new Set<() => void>();

function update(next: Partial<UsbSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

const note = (text: string, from: "button" | "link" = "link") => update({ lines: [...snapshot.lines.slice(-(KEEP_LINES - 1)), { id: ++lineId, text, from }] });

/** /keys/ws for the button's own token: not yours, so PureStrings sees the button, not the key in this browser. */
function socketUrl(token: string): string {
  const url = new URL("keys/ws", window.location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("token", token);
  return url.toString();
}

let port: SerialPortLike | null = null;
let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
let socket: WebSocket | null = null;
let writing: Promise<void> = Promise.resolve();
let ping: ReturnType<typeof setInterval> | undefined;
/** No new socket until this time: after a refusal, not at every announcement. */
let quietUntil = 0;
/** Connected by you and not disconnected since: plugging the button back in reconnects it. */
let wanted = false;

/** A message to the button, as a frame on its cable, in order. */
function toButtonText(text: string): void {
  const out = writer;
  if (!out) return;
  const frame = encodeFrame(text);
  writing = writing.then(() => out.write(frame)).catch(() => undefined);
}

const toButton = (message: object): void => toButtonText(JSON.stringify(message));

// The button's voice, from PureStrings: 16-bit PCM at 24 kHz (48 bytes a millisecond). It goes on the cable at
// speaking pace, at most a second ahead, so the button's USB buffer never has to hold more than that.
const SOUND_PER_MS = 48;
const SOUND_LEAD = 48_000;
let sound: Uint8Array[] = [];
let soundSince = 0;
let soundSent = 0;
let soundTimer: ReturnType<typeof setTimeout> | undefined;

function feedSound(): void {
  clearTimeout(soundTimer);
  soundTimer = undefined;
  const out = writer;
  if (!out) {
    sound = [];
    return;
  }
  const now = Date.now();
  // Once everything sent has had time to play, the next words start a fresh clock.
  if (soundSent <= (now - soundSince) * SOUND_PER_MS) {
    soundSince = now;
    soundSent = 0;
  }
  let room = (now - soundSince) * SOUND_PER_MS + SOUND_LEAD - soundSent;
  while (sound.length && (sound[0]?.length ?? 0) <= room) {
    const chunk = sound.shift()!;
    const frame = encodeFrame(chunk, "B");
    writing = writing.then(() => out.write(frame)).catch(() => undefined);
    soundSent += chunk.length;
    room -= chunk.length;
  }
  if (sound.length) soundTimer = setTimeout(feedSound, 50);
}

function toButtonSound(bytes: Uint8Array): void {
  for (let at = 0; at < bytes.length; at += 4_800) sound.push(bytes.slice(at, at + 4_800));
  feedSound();
}

function openSocket(token: string): void {
  update({ state: "connecting" });
  note("The button said who it is. Connecting it to PureStrings...");
  const opened = new WebSocket(socketUrl(token));
  opened.binaryType = "arraybuffer";
  socket = opened;
  let live = false;
  opened.onopen = () => {
    live = true;
    update({ state: "live" });
    note("Connected: the button is talking to PureStrings.");
    toButton({ type: "usb-open" });
  };
  opened.onmessage = (message) => {
    if (typeof message.data === "string") {
      // Something new to sign: whatever the button was still saying is stale.
      if (message.data.startsWith('{"type":"sign"')) sound = [];
      toButtonText(message.data);
    } else if (message.data instanceof ArrayBuffer) toButtonSound(new Uint8Array(message.data));
  };
  opened.onclose = () => {
    if (socket !== opened) return;
    socket = null;
    if (!port) return;
    // Refused straight away is almost always the token: wait a little before trying it again.
    quietUntil = Date.now() + (live ? 1_000 : 10_000);
    note(live ? "PureStrings closed the connection; it reconnects when the button asks." : "PureStrings refused the button. Is its token one this PureStrings made (Add a button)?");
    toButton({ type: "usb-closed" });
    update({ state: "waiting" });
  };
}

/** A message from the button: who it is (the link's own), or one for PureStrings. */
function fromButton(text: string): void {
  let message: { type?: unknown; token?: unknown };
  try {
    message = JSON.parse(text) as typeof message;
  } catch {
    return note("The button sent something that isn't JSON; skipped.");
  }
  if (message.type === "usb") {
    if (typeof message.token !== "string") return;
    // Announcing while connected means the button restarted: start afresh, so PureStrings greets it again.
    if (socket?.readyState === WebSocket.OPEN) {
      const stale = socket;
      socket = null;
      stale.close();
      note("The button started over; reconnecting it.");
      quietUntil = 0;
    }
    if (!socket && Date.now() >= quietUntil) openSocket(message.token);
    return;
  }
  if (socket?.readyState === WebSocket.OPEN) socket.send(text);
}

async function readLoop(from: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  const frames = new FrameReader();
  try {
    for (;;) {
      const { value, done } = await from.read();
      if (done) break;
      for (const event of value ? frames.push(value) : []) {
        if (event.kind === "line") note(event.text, "button");
        else fromButton(event.text);
      }
    }
  } catch (error) {
    if (reader === from) note(`The cable stopped: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (reader === from) await close();
}

async function close(): Promise<void> {
  clearInterval(ping);
  ping = undefined;
  const open = socket;
  socket = null;
  open?.close();
  if (open) toButton({ type: "usb-closed" });
  const [r, w, p] = [reader, writer, port];
  reader = null;
  writer = null;
  port = null;
  await r?.cancel().catch(() => undefined);
  r?.releaseLock();
  await writing.catch(() => undefined);
  w?.releaseLock();
  await p?.close().catch(() => undefined);
  update({ state: "closed" });
}

async function connect(chosen: SerialPortLike): Promise<void> {
  update({ error: null });
  try {
    await close();
    await chosen.open({ baudRate: 115_200, bufferSize: 16_384 });
    // DTR up, RTS down: what a serial monitor sends, so opening the port doesn't reset the button.
    await chosen.setSignals?.({ dataTerminalReady: true, requestToSend: false }).catch(() => undefined);
    if (!chosen.readable || !chosen.writable) throw new Error("The port opened but can't be read or written.");
    port = chosen;
    writer = chosen.writable.getWriter();
    reader = chosen.readable.getReader();
    wanted = true;
    update({ state: "waiting" });
    note("Port open. Waiting for the button to say who it is...");
    // A button still linked to a page that's gone would never say who it is again: tell it the link is closed.
    toButton({ type: "usb-closed" });
    ping = setInterval(() => {
      if (socket?.readyState === WebSocket.OPEN) toButton({ type: "usb-ping" });
    }, 5_000);
    void readLoop(reader);
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    update({ error: /open/i.test(said) ? "Couldn't open the button's port. PureStrings itself, a serial monitor or an upload may have it. Close that, then connect again." : `Couldn't connect the button: ${said}` });
  }
}

export const usb = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  snapshot: (): UsbSnapshot => snapshot,
  /** Chrome and Edge on a desktop have Web Serial; other browsers don't. */
  supported: (): boolean => webSerial() !== null,
  /** Asks which port (Chrome lists the ESP32-S3's own USB), then connects it. */
  async choose(): Promise<void> {
    const serial = webSerial();
    if (!serial) return;
    let chosen: SerialPortLike;
    try {
      chosen = await serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF }] });
    } catch {
      return; // the chooser was closed without a pick
    }
    await connect(chosen);
  },
  /** Reconnects a button this browser was allowed before, when there's exactly one. */
  async resume(): Promise<void> {
    const serial = webSerial();
    if (!serial || snapshot.state !== "closed") return;
    const ours = (await serial.getPorts().catch(() => [])).filter((one) => one.getInfo().usbVendorId === ESPRESSIF);
    if (ours.length === 1 && ours[0]) await connect(ours[0]);
  },
  /** Lets go of the port (to flash the button, say); it stays let go until you connect again. */
  disconnect: (): Promise<void> => {
    wanted = false;
    return close();
  },
  clearLog: (): void => update({ lines: [] }),
};

// The button unplugged and plugged back in (or restarted by a flash): pick it up again once its USB is ready.
webSerial()?.addEventListener("connect", () => {
  if (wanted) setTimeout(() => void usb.resume(), 800);
});
