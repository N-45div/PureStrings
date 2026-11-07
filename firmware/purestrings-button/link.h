// The button's link to PureStrings (/keys/ws), one of two ways:
//   USB (PURESTRINGS_LINK_USB 1): each message is a frame on the cable: STX (0x02), 'T', its length (4 bytes,
//     little-endian), then the JSON. PureStrings' Key screen, open in Chrome or Edge, passes frames on to /keys/ws
//     as this button, with the token it announces ("Connect by USB"). Log lines share the cable, between frames.
//   Wi-Fi: a WebSocket to PURESTRINGS_URL, with the token as a bearer.
// Either way it's the same conversation: PureStrings says hello, the button says its public key, PureStrings says
// whether it keeps it (signer), then sends what's waiting (sign) or that nothing is (idle). The button answers
// sign {id, signature} or decline {id}, and hears how it went (signed, answered, payment, error).
#pragma once
#include <ArduinoJson.h>
#if !PURESTRINGS_LINK_USB
#include <WebSocketsClient.h>
#include <WiFi.h>
WebSocketsClient socket;
#endif

constexpr uint8_t STX = 0x02;

void sendJson(JsonDocument &doc) {
  String out;
  serializeJson(doc, out);
#if PURESTRINGS_LINK_USB
  const uint8_t head[6] = {STX, 'T', (uint8_t)out.length(), (uint8_t)(out.length() >> 8), (uint8_t)(out.length() >> 16), (uint8_t)(out.length() >> 24)};
  Serial.write(head, sizeof head);
  Serial.write(reinterpret_cast<const uint8_t *>(out.c_str()), out.length());
#else
  socket.sendTXT(out);
#endif
}

/** An answer to show for a while on the idle screen. */
void reply(const String &head, const String &text, bool good) {
  replyHead = head;
  replyText = text;
  replyGood = good;
  replyUntil = millis() + REPLY_MS;
  setLed(good ? 0 : 40, good ? 40 : 0, 0);
  redraw = true;
}

void linkOpened() {
  linkUp = true;
  logLine("connected to PureStrings");
  note = "";
  mode = Mode::Idle;
  redraw = true;
}

void linkClosed() {
#if PURESTRINGS_LINK_USB
  logLine(linkUp ? "lost PureStrings on USB; waiting for the Key screen again" : "waiting for PureStrings on USB: open its Key screen in Chrome or Edge and press Connect by USB");
  note = "Open PureStrings' Key screen in Chrome or Edge, then Connect by USB.";
#else
  logLine(mode == Mode::Connecting ? "can't reach PureStrings at %s (is it listening beyond its machine, the token right?)" : "lost PureStrings; retrying every 3 s", PURESTRINGS_URL);
  note = "Can't reach PureStrings yet. Retrying...";
#endif
  linkUp = false;
  signerOk = false;
  mode = Mode::Connecting;
  setLed(0, 0, 0);
  redraw = true;
}

void onMessage(const char *payload, size_t length) {
  JsonDocument doc;
  if (deserializeJson(doc, payload, length)) return;
  String type = doc["type"] | "";
  // The Key screen's own messages on the USB link: PureStrings is there, gone, or the page is still listening.
  if (type == "usb-ping") return;
  if (type == "usb-open") return linkOpened();
  if (type == "usb-closed") return linkClosed();
  if (type != "pong") logLine("from PureStrings: %s", type.c_str());
  if (type == "hello") {
    JsonDocument hello;
    hello["type"] = "hello";
    // The button's public key, so PureStrings can check what it signs; the private half never leaves the chip.
    if (chipkey::ready) hello["key"] = chipkey::keyText;
    sendJson(hello);
  } else if (type == "signer") {
    signerOk = doc["ok"] | false;
    signerNote = signerOk ? "key " + String(doc["fingerprint"] | "") : "key refused: see Keys";
    logLine("  key %s (%s)%s%s", signerOk ? "kept" : "refused", (const char *)(doc["fingerprint"] | ""), signerOk ? "" : ": ", signerOk ? "" : (const char *)(doc["problem"] | ""));
    redraw = true;
  } else if (type == "sign") {
    bool fresh = mode != Mode::Sign || signId != String(doc["id"] | "");
    startSigning(doc["id"] | "", doc["text"] | "", doc["more"] | 0);
    setLed(0, 20, 40);
    if (fresh) {
      beep(880, 90);
      beep(1320, 120);
    }
    redraw = true;
  } else if (type == "idle") {
    // Nothing waits (any more): what was on the screen was answered, here or elsewhere, or ran out.
    if (mode == Mode::Sign) setLed(0, 0, 0);
    mode = Mode::Idle;
    spentToday = doc["spentTodayUsd"] | 0.0f;
    redraw = true;
  } else if (type == "signed") {
    // PureStrings took the signature; the shop's answer comes as "payment".
    rememberShop(signShopId);
  } else if (type == "answered") {
    reply("Refused", "Nothing was paid.", false);
  } else if (type == "payment") {
    String status = doc["status"] | "";
    bool went = status == "paid" || status == "linking" || status == "set";
    reply(status == "paid" ? "Paid" : status == "linking" ? "Signed" : status == "set" ? "Allowance set" : "Didn't go", doc["line"] | "", went);
    if (went) beep(1320, 140);
    else beep(330, 300);
  } else if (type == "error") {
    String message = doc["message"] | "Something went wrong.";
    logLine("  error: %s", message.c_str());
    reply("Not done", message, false);
  }
}

#if PURESTRINGS_LINK_USB
uint8_t frameHead[6];
size_t headGot = 0, frameLeft = 0;
String frameText;
unsigned long lastHeard = 0, lastAnnounce = 0;

/** Reads frames off the cable, says who this button is until the Key screen answers, and notices it going quiet. */
void linkLoop() {
  static uint8_t chunk[512];
  while (Serial.available() > 0) {
    size_t got = Serial.read(chunk, min((size_t)Serial.available(), sizeof chunk));
    for (size_t i = 0; i < got;) {
      if (headGot < sizeof frameHead) {
        if (headGot == 0 && chunk[i] != STX) {
          i++;
          continue;
        }
        frameHead[headGot++] = chunk[i++];
        if (headGot < sizeof frameHead) continue;
        frameLeft = frameHead[2] | (frameHead[3] << 8) | (frameHead[4] << 16) | ((size_t)frameHead[5] << 24);
        if (frameHead[1] != 'T' || frameLeft > 8192) {
          headGot = 0;  // not a frame after all: look for the next STX
          continue;
        }
        frameText = "";
        if (frameLeft == 0) headGot = 0;
        continue;
      }
      size_t n = min(frameLeft, got - i);
      frameText.concat(reinterpret_cast<const char *>(chunk + i), n);
      i += n;
      frameLeft -= n;
      if (frameLeft == 0) {
        lastHeard = millis();
        headGot = 0;
        onMessage(frameText.c_str(), frameText.length());
      }
    }
  }
  unsigned long now = millis();
  if (!linkUp && now - lastAnnounce > 2000) {
    lastAnnounce = now;
    JsonDocument hello;
    hello["type"] = "usb";
    hello["token"] = PURESTRINGS_TOKEN;
    sendJson(hello);
  }
  // The Key screen pings every 5 s; quiet for 15, the page is gone.
  if (linkUp && now - lastHeard > 15000) linkClosed();
}

void startLink() { linkClosed(); }
#else
void onSocket(WStype_t type, uint8_t *payload, size_t length) {
  if (type == WStype_CONNECTED) linkOpened();
  else if (type == WStype_DISCONNECTED) linkClosed();
  else if (type == WStype_TEXT) onMessage(reinterpret_cast<const char *>(payload), length);
}

void linkLoop() { socket.loop(); }

/** Joins the Wi-Fi, then connects to PURESTRINGS_URL ("ws://192.168.1.20:7700/keys/ws", or wss:// when hosted). */
void startLink() {
  String url = PURESTRINGS_URL;
  bool tls = url.startsWith("wss://");
  String rest = url.substring(url.indexOf("://") + 3);
  int slash = rest.indexOf('/');
  String hostPort = slash < 0 ? rest : rest.substring(0, slash);
  String path = slash < 0 ? "/keys/ws" : rest.substring(slash);
  int colon = hostPort.lastIndexOf(':');
  static String host = colon < 0 ? hostPort : hostPort.substring(0, colon);
  int port = colon < 0 ? (tls ? 443 : 80) : hostPort.substring(colon + 1).toInt();

  note = "Joining " WIFI_SSID "...";
  draw();
  logLine("joining Wi-Fi \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  unsigned long started = millis(), lastNote = 0;
  while (WiFi.status() != WL_CONNECTED) {
    delay(100);
    unsigned long waited = millis() - started;
    if (waited > 12000 && millis() - lastNote > 10000) {
      lastNote = millis();
      logLine("still joining \"%s\" after %lu s (status %d): it needs 2.4 GHz; check WIFI_SSID and WIFI_PASSWORD in config.h", WIFI_SSID, waited / 1000, (int)WiFi.status());
      note = "Still joining " WIFI_SSID ". It needs 2.4 GHz Wi-Fi; check config.h.";
      draw();
    }
  }
  logLine("Wi-Fi joined: address %s, signal %d dBm", WiFi.localIP().toString().c_str(), (int)WiFi.RSSI());
  logLine("connecting to %s (host %s, port %d, path %s)", PURESTRINGS_URL, host.c_str(), port, path.c_str());
  note = "Connecting to " + host + "...";
  draw();
  static String auth = String("Authorization: Bearer ") + PURESTRINGS_TOKEN;
  if (tls) socket.beginSSL(host.c_str(), port, path.c_str());
  else socket.begin(host.c_str(), port, path.c_str());
  socket.setExtraHeaders(auth.c_str());
  socket.onEvent(onSocket);
  socket.setReconnectInterval(3000);
  socket.enableHeartbeat(20000, 5000, 2);
}
#endif
