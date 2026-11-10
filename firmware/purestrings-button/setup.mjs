#!/usr/bin/env node
// Sets a PureStrings button up: makes its token in your PureStrings, writes config.h next to the sketch, and says
// how to flash it and connect it.
//
// Over USB (the default), the button talks through its cable and PureStrings' Key screen passes its messages on
// ("Connect by USB" in Chrome or Edge): no Wi-Fi, address or firewall rule. Over Wi-Fi (--wifi), it also finds this
// computer's address and asks for your Wi-Fi (the password typed hidden).
//
//   node firmware/purestrings-button/setup.mjs [--usb | --wifi] [--server http://127.0.0.1:7700]
//        [--name "Desk button"] [--ssid "My Wi-Fi"] [--host 192.168.1.20] [--force]
//
// PURESTRINGS_TOKEN: your PureStrings token, when it was started with one. WIFI_PASSWORD skips that question.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces, platform } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const server = (flag("server") ?? "http://127.0.0.1:7700").replace(/\/$/, "");
const token = process.env.PURESTRINGS_TOKEN?.trim();
const name = flag("name") ?? "PureStrings button";
const out = flag("out") ?? join(here, "config.h");
const FQBN = "esp32:esp32:esp32s3:USBMode=default,CDCOnBoot=cdc,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,DebugLevel=none";

const fail = (message) => {
  console.error(`\n${message}`);
  process.exit(1);
};
const run = (command, commandArgs) => {
  try {
    return execFileSync(command, commandArgs, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
};
/** A C string literal's insides: backslashes and quotes escaped. */
const cString = (value) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

// One reader for every question, its lines queued: piped answers arrive all at once, before the next question.
// Typing shows as * while muted (the password). A closed input answers undefined.
let reader;
let muted = false;
const lines = [];
const waiting = [];
const question = (text) => {
  if (!reader) {
    reader = createInterface({ input: process.stdin, output: process.stdout });
    reader._writeToOutput = (said) => {
      if (!muted) return reader.output.write(said);
      const prompt = reader.getPrompt();
      reader.output.write(said.startsWith(prompt) ? prompt + "*".repeat(said.length - prompt.length) : said.replace(/[^\r\n]/g, "*"));
    };
    reader.on("line", (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
    reader.on("close", () => waiting.splice(0).forEach((resolve) => resolve(undefined)));
  }
  if (lines.length) {
    process.stdout.write(`${text}\n`);
    return Promise.resolve(lines.shift());
  }
  reader.setPrompt(text);
  reader.prompt();
  return new Promise((resolve) => waiting.push(resolve));
};
const ask = async (text, fallback = "") => ((await question(fallback ? `${text} [${fallback}]: ` : `${text}: `)) ?? "").trim() || fallback;

// A config.h that's still the example (no token pasted in) holds nothing to lose.
if (existsSync(out) && !readFileSync(out, "utf8").includes("paste-the-button-token-here") && !args.includes("--force")) {
  fail(`${out} already exists. Add --force to replace it (it holds the button's token).`);
}

// 1. PureStrings answers, and the token works.
const headers = { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
const info = await fetch(`${server}/api/info`, { headers }).then(
  (response) => (response.ok ? response.json() : null),
  () => null,
);
if (!info) fail(`PureStrings isn't answering at ${server}. Start it first (npm start), or pass --server with its address.`);
const check = await fetch(`${server}/api/devices`, { headers });
if (check.status === 401) fail("PureStrings wants its token: set PURESTRINGS_TOKEN to the token it was started with.");
console.log(`PureStrings ${info.version ?? ""} answers at ${server}.`);

// 2. How the button reaches it: its USB cable through the Key screen, or Wi-Fi.
const wifiChosen = args.includes("--wifi") || (!args.includes("--usb") && /^w/i.test(await ask("Connect the button by usb (its cable, nothing to set up) or wifi", "usb")));
let wifi = null;
if (wifiChosen) {
  const url = new URL(server);
  const tls = url.protocol === "https:";
  let socketUrl;
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
    // This computer's address on the Wi-Fi: what the button connects to.
    const local = Object.entries(networkInterfaces())
      .flatMap(([iface, list]) => (list ?? []).filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => ({ iface, address: entry.address })))
      .filter(({ address }) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address))
      .sort((a, b) => Number(/wi-?fi|wlan|wireless/i.test(b.iface)) - Number(/wi-?fi|wlan|wireless/i.test(a.iface)));
    const host = flag("host") ?? local[0]?.address;
    if (!host) fail("Couldn't find this computer's address on a local network. Pass --host with it (ipconfig shows it).");
    socketUrl = `ws://${host}:${url.port || 80}/keys/ws`;
  } else {
    socketUrl = `${tls ? "wss" : "ws"}://${url.host}/keys/ws`;
  }
  // The ESP32-S3 has no 5 GHz radio; on Windows, say so when this computer is on 5 GHz.
  let current = "";
  if (platform() === "win32") {
    const now = run("netsh", ["wlan", "show", "interfaces"]);
    const value = (label) => now.split("\n").map((line) => line.trim()).find((line) => new RegExp(`^${label}\\s*:`).test(line))?.split(":").slice(1).join(":").trim() ?? "";
    current = value("SSID");
    if (Number(value("Channel")) > 14) console.log(`\nThis computer is on "${current}" at 5 GHz. The button can only join 2.4 GHz: give it your router's 2.4 GHz network.\n`);
  }
  const ssid = flag("ssid") ?? (await ask("Wi-Fi name for the button (2.4 GHz)", current));
  if (!ssid) fail("The button needs a Wi-Fi name.");
  let password = process.env.WIFI_PASSWORD;
  if (password === undefined) {
    muted = true;
    password = await question(`Password for "${ssid}" (empty for an open network): `);
    muted = false;
  }
  if (password === undefined) fail("Stopped before the Wi-Fi password was typed.");
  wifi = { ssid, password, socketUrl };
}
reader?.close();

// 3. The button's token, shown once: it goes straight into config.h.
const made = await fetch(`${server}/api/devices`, { method: "POST", headers, body: JSON.stringify({ name }) });
const device = await made.json().catch(() => ({}));
if (!made.ok || !device.token) fail(`PureStrings didn't make a token for the button: ${device.error ?? `HTTP ${made.status}`}`);

writeFileSync(
  out,
  `// Written by setup.mjs for "${cString(name)}". Holds the button's token${wifi ? " and your Wi-Fi password" : ""}: it stays out of git.
#define PURESTRINGS_LINK_USB ${wifi ? 0 : 1}
#define PURESTRINGS_TOKEN "${cString(device.token)}"
${wifi ? `#define WIFI_SSID "${cString(wifi.ssid)}"\n#define WIFI_PASSWORD "${cString(wifi.password)}"\n#define PURESTRINGS_URL "${cString(wifi.socketUrl)}"` : "// Over the USB cable: PureStrings (or its Key screen) passes its messages on. No Wi-Fi needed."}
#define VOLUME 150
#define SCREEN_INVERT 0
#define SCREEN_FLIP 0
`,
);
console.log(`\nWrote ${out} for "${name}" (${wifi ? `Wi-Fi, PureStrings at ${wifi.socketUrl}` : "USB"}).`);

// 4. What's left: flash it, then connect it.
const ports = run("arduino-cli", ["board", "list"]).match(/^COM\d+|^\/dev\/tty(ACM|USB)\d+/gm) ?? [];
const flash = `       arduino-cli compile --fqbn "${FQBN}" "${here}"
       arduino-cli upload --fqbn "${FQBN}" -p ${ports[0] ?? "<port: arduino-cli board list>"} "${here}"
     It's built locked: once it is, it takes new firmware only if you hold its button while you plug it in.`;
console.log(
  wifi
    ? `
Next:
  1. Start PureStrings so the button can reach it (a token is required off this machine):
       ${platform() === "win32" ? '$env:PURESTRINGS_HOST="0.0.0.0"; $env:PURESTRINGS_TOKEN="<16+ characters>"; npm start' : "PURESTRINGS_HOST=0.0.0.0 PURESTRINGS_TOKEN=<16+ characters> npm start"}
     On Windows, let port 7700 in on private networks (an Administrator PowerShell, once):
       New-NetFirewallRule -DisplayName "PureStrings 7700" -Direction Inbound -Protocol TCP -LocalPort 7700 -Action Allow -Profile Private
  2. Plug the button in by USB and flash it:
${flash}
  3. Watch it start: arduino-cli monitor -p ${ports[0] ?? "<port>"} -c baudrate=115200
`
    : `
Next:
  1. Start PureStrings as usual (npm start). Nothing to open up: the button comes in through the Key screen.
  2. Plug the button in by USB and flash it (close any serial monitor first):
${flash}
  3. Open PureStrings in Chrome or Edge, go to Key, press "Connect by USB" and pick the ESP32-S3.
     The card shows what the button says, then "Connected over USB". Disconnect there before you flash it again.
`,
);
