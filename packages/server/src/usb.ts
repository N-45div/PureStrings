import type { Store } from "@purestrings/core";
import { encodeFrame, FrameReader } from "@purestrings/core/cable";
import type { KeyHub, ToKey } from "./keys.ts";

/**
 * The PureStrings button on this computer's USB, run by PureStrings itself: plug it in and it's your key. No browser
 * tab, Wi-Fi or address. PureStrings finds it by Espressif's USB id, checks the token it announces, and passes what
 * it shows, what it signs and PureStrings' voice along its cable, as the Key screen's "Connect by USB" does from a
 * browser. A port something else holds (that page, a serial monitor, an upload) is left alone and tried again later.
 */

/** Espressif's USB vendor id: the ESP32-S3's own USB port. */
const ESPRESSIF = "303a";
const LOOK_MS = 2_000;
/** The button counts the link gone after 15 s without a word. */
const PING_MS = 5_000;
// PureStrings' voice is 16-bit PCM at 24 kHz, 48 bytes a millisecond. It goes on the cable at speaking pace, at most
// half a second ahead: the button's USB serial drops what doesn't fit its 32 KB buffer, so this always fits.
const SOUND_PER_MS = 48;
const SOUND_LEAD = 24_000;
const SOUND_CHUNK = 4_800;

type Binding = ReturnType<(typeof import("@serialport/bindings-cpp"))["autoDetect"]>;
type Port = Awaited<ReturnType<Binding["open"]>>;

const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface UsbButtons {
  /** The port a button is linked on now, if one is. */
  readonly linked: () => string | null;
  readonly stop: () => Promise<void>;
}

export function usbButtons(options: { readonly store: Store; readonly hub: KeyHub; readonly version: string; readonly log?: (line: string) => void }): UsbButtons {
  const log = options.log ?? ((line: string) => console.log(`[purestrings] ${line}`));
  const said = new Set<string>();
  const sayOnce = (line: string) => {
    if (said.has(line)) return;
    said.add(line);
    log(line);
  };
  let binding: Binding | null | undefined;
  let current: { readonly path: string; readonly end: (why?: string) => Promise<void>; linked: boolean } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  /** One button on one port, from the moment it opens until it's unplugged or PureStrings stops. */
  const run = (path: string, port: Port) => {
    const frames = new FrameReader();
    let writing: Promise<unknown> = Promise.resolve();
    let session: ReturnType<KeyHub["connect"]> | null = null;
    let ended = false;
    let showing = "";
    let linkedAt = 0;
    const write = (bytes: Uint8Array) => {
      writing = writing.then(() => port.write(Buffer.from(bytes))).catch(() => undefined);
    };
    const toButton = (message: object) => write(encodeFrame(JSON.stringify(message)));

    let sound: Uint8Array[] = [];
    let soundSince = 0;
    let soundSent = 0;
    let soundTimer: ReturnType<typeof setTimeout> | undefined;
    const feedSound = () => {
      clearTimeout(soundTimer);
      soundTimer = undefined;
      if (ended) return;
      const now = Date.now();
      // Once everything sent has had time to play, the next words start a fresh clock.
      if (soundSent <= (now - soundSince) * SOUND_PER_MS) {
        soundSince = now;
        soundSent = 0;
      }
      let room = (now - soundSince) * SOUND_PER_MS + SOUND_LEAD - soundSent;
      while (sound.length && (sound[0]?.length ?? 0) <= room) {
        const chunk = sound.shift()!;
        write(encodeFrame(chunk, "B"));
        soundSent += chunk.length;
        room -= chunk.length;
      }
      if (sound.length) soundTimer = setTimeout(feedSound, 50);
    };
    const sendAudio = (pcm: Uint8Array) => {
      for (let at = 0; at < pcm.length; at += SOUND_CHUNK) sound.push(pcm.slice(at, at + SOUND_CHUNK));
      feedSound();
    };
    const send = (message: ToKey) => {
      // Something new to sign: whatever the button was still saying is stale (it empties its own speaker too).
      if (message.type === "sign" && message.id !== showing) {
        sound = [];
        soundSent = 0;
      }
      if (message.type === "sign" || message.type === "idle") showing = message.type === "sign" ? message.id : "";
      toButton(message);
    };

    const fromButton = (text: string) => {
      let message: { type?: unknown; token?: unknown };
      try {
        message = JSON.parse(text) as typeof message;
      } catch {
        return;
      }
      if (message.type !== "usb") return session?.receive(text);
      if (typeof message.token !== "string") return;
      const device = options.store.deviceByToken(message.token);
      if (!device) return sayOnce(`The button on ${path} has a token this PureStrings didn't make. Add a button in Keys, then run firmware/purestrings-button/setup.mjs and flash it.`);
      // It says who it is until it hears it's linked, so one more can follow on the cable's heels. Later than that,
      // it has restarted, and it's greeted afresh.
      if (session && Date.now() - linkedAt < 3_000) return;
      session?.close();
      linkedAt = Date.now();
      showing = "";
      toButton({ type: "usb-open" });
      session = options.hub.connect(send, { name: device.name, version: options.version, deviceId: device.id }, sendAudio);
      state.linked = true;
      log(`${device.name} is your key on USB (${path}); no browser needed`);
    };

    const ping = setInterval(() => {
      if (session) toButton({ type: "usb-ping" });
    }, PING_MS);

    const end = async (why?: string) => {
      if (ended) return;
      ended = true;
      clearInterval(ping);
      clearTimeout(soundTimer);
      if (session) toButton({ type: "usb-closed" });
      session?.close();
      session = null;
      if (why) log(why);
      await writing;
      await port.close().catch(() => undefined);
      if (current === state) current = null;
    };
    const state = { path, end, linked: false };

    void (async () => {
      const buffer = Buffer.alloc(4_096);
      try {
        for (;;) {
          const { bytesRead } = await port.read(buffer, 0, buffer.length);
          if (ended) return;
          for (const event of frames.push(buffer.subarray(0, bytesRead))) {
            if (event.kind === "text") fromButton(event.text);
            else log(`  button: ${event.text.replace(/^\[purestrings\] /, "")}`);
          }
        }
      } catch (error) {
        await end(ended ? undefined : `Lost the button on ${path}: ${failure(error)}. It's picked up again when it's back.`);
      }
    })();
    // A button still linked to a page that's gone would never say who it is: tell it the link is closed.
    toButton({ type: "usb-closed" });
    return state;
  };

  const look = async () => {
    timer = undefined;
    if (stopped) return;
    if (binding === undefined) {
      try {
        binding = (await import("@serialport/bindings-cpp")).autoDetect();
      } catch (error) {
        binding = null;
        log(`No USB serial here (${failure(error)}): the button links over Wi-Fi or from the Key screen instead.`);
      }
    }
    if (!binding) return;
    if (!current) {
      const ports = await binding.list().catch(() => []);
      for (const info of ports.filter((one) => one.vendorId?.toLowerCase() === ESPRESSIF)) {
        try {
          // DTR up, RTS down, as a serial monitor opens it: opening the port mustn't restart the button.
          const port = await binding.open({ path: info.path, baudRate: 115_200, hupcl: true, rtscts: false });
          log(`Found a button on USB (${info.path}); waiting for it to say who it is...`);
          current = run(info.path, port);
          said.clear();
          break;
        } catch (error) {
          sayOnce(`The button on ${info.path} is busy (${failure(error)}): the Key screen, a serial monitor or an upload has it. Trying again every few seconds.`);
        }
      }
    }
    if (!stopped) timer = setTimeout(() => void look(), LOOK_MS);
  };
  void look();

  return {
    linked: () => (current?.linked ? current.path : null),
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await current?.end();
    },
  };
}
