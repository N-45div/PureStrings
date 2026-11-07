// The PureStrings button: an OceanLabz AI Explorer ESP32-S3 that is your key. It shows exactly what it's asked to
// sign (who asked, the shop, each line, the total), read from the text it signs, and signs it with a P-256 key made
// in its own chip, only when you hold its button for two seconds.
//
//   Something to sign: hold 2 s (a bar fills; let go once it's full) = sign. A quick press = refuse.
//   A long cart:       its pages turn by themselves; it signs only once every line has been shown.
//   Screen blank?      tap five times quickly with nothing to sign: it switches to the other screen wiring.
//
// It talks to PureStrings over its USB cable (through the Key screen in Chrome or Edge) or over Wi-Fi: see
// config.example.h and README.md. Everything it does is logged on USB at 115200 baud.

#if __has_include("config.h")
#include "config.h"
#else
#error "Copy config.example.h to config.h and fill it in, or run: node firmware/purestrings-button/setup.mjs"
#endif
#ifndef PURESTRINGS_LINK_USB
#define PURESTRINGS_LINK_USB 1
#endif
#ifndef VOLUME
#define VOLUME 60
#endif
#ifndef SCREEN_INVERT
#define SCREEN_INVERT 0
#endif
#ifndef SCREEN_FLIP
#define SCREEN_FLIP 0
#endif

#include "key.h"
#include "state.h"
#include "signable.h"
#include "screen.h"
#include "link.h"

// ---- The button -----------------------------------------------------------------------------------------
bool wasDown = false;
unsigned long downAt = 0;
unsigned long tapTimes[5] = {0};
int taps = 0;

/** A quick press with nothing to sign: puts away an answer; five in a row switch the screen's wiring. */
void onTap() {
  tapTimes[taps % 5] = millis();
  taps++;
  if (taps >= 5 && millis() - tapTimes[taps % 5] < 2500) {
    logLine("five quick taps: switching to screen wiring %d and restarting", 2 - tftMap);
    prefs.putInt("tft", 1 - tftMap);
    for (int i = 0; i < 6; i++) {
      setLed(i % 2 ? 0 : 40, 0, i % 2 ? 0 : 40);
      delay(150);
    }
    ESP.restart();
  }
  replyUntil = 0;
  redraw = true;
}

void readButton() {
  bool down = digitalRead(BUTTON_PIN) == LOW;
  unsigned long now = millis();
  if (down && !wasDown) downAt = now;
  unsigned long held = now - downAt;
  // A press that began before this arrived isn't an answer to it.
  bool forSign = mode == Mode::Sign && signId.length() && downAt >= signAt;
  if (forSign && signReadable && signSeen && down && held > 120) drawHoldBar(held);
  if (mode == Mode::Sign && !down) turnSignPage(now);
  if (!down && wasDown) {
    if (forSign && held > 30) {
      // Signed only by a full two-second hold, only if it could be read, and only once every line was shown;
      // anything less is no.
      JsonDocument answer;
      if (signReadable && !signSeen && held >= HOLD_SIGN_MS) {
        logLine("not signed %s: not every line shown yet", signId.c_str());
      } else if (signReadable && signerOk && held >= HOLD_SIGN_MS) {
        String signature = chipkey::sign(signText);
        if (signature.length()) {
          answer["type"] = "sign";
          answer["id"] = signId;
          answer["signature"] = signature;
          logLine("signed %s", signId.c_str());
        } else {
          logLine("couldn't sign %s: no working key", signId.c_str());
          reply("Can't sign", "This key failed its own check, so it signs nothing.", false);
        }
      } else if (signReadable && !signerOk && held >= HOLD_SIGN_MS) {
        logLine("not signed %s: PureStrings hasn't kept this key", signId.c_str());
        reply("Can't sign", signerNote.length() ? signerNote : "PureStrings hasn't taken this key yet.", false);
      } else {
        answer["type"] = "decline";
        answer["id"] = signId;
        logLine("refused %s", signId.c_str());
      }
      if (!answer["type"].isNull()) sendJson(answer);
      redraw = true;
    } else if (mode != Mode::Sign && held > 30 && held < 350) {
      onTap();
    }
    drawHoldBar(0);
  }
  wasDown = down;
}

// ---- Setup and loop -------------------------------------------------------------------------------------
void setup() {
  Serial.setRxBufferSize(8192);
  Serial.begin(115200);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  led.begin();
  led.setBrightness(60);
  prefs.begin("purestrings", false);
  // The key, before I2S starts: making one uses the chip's own entropy source, which I2S mustn't share.
  if (chipkey::load(prefs)) logLine("made this button's key: %s", chipkey::fingerprint.c_str());
  else if (chipkey::ready) logLine("key %s", chipkey::fingerprint.c_str());
  else logLine("couldn't make a key: this button can't sign");
  // It signs a test text and checks it with its own public key, as PureStrings will; failing that, it signs nothing.
  if (chipkey::ready && !chipkey::selfCheck()) {
    chipkey::ready = false;
    logLine("the key failed its self-check: this button won't sign");
  } else if (chipkey::ready) {
    logLine("signing self-check passed");
  }
  tftMap = prefs.getInt("tft", 0) == 1 ? 1 : 0;
  // The LED blinks the screen wiring in use (once or twice), so a dark screen still says something.
  for (int i = 0; i <= tftMap; i++) {
    setLed(30, 0, 30);
    delay(200);
    setLed(0, 0, 0);
    delay(200);
  }
  setupScreen();
  amp.setPins(AMP_BCLK, AMP_LRC, AMP_DIN);
  ampReady = amp.begin(I2S_MODE_STD, 16000, I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_MONO);
  logLine("PureStrings button: screen wiring %d, speaker %s, free memory %u KB, link %s", tftMap + 1, ampReady ? "on" : "off", ESP.getFreeHeap() / 1024, PURESTRINGS_LINK_USB ? "USB" : "Wi-Fi");
  beep(660, 100);
  beep(990, 140);
  startLink();
  draw();
}

void loop() {
  linkLoop();
  readButton();
  if (replyUntil && millis() > replyUntil) {
    replyUntil = 0;
    if (mode == Mode::Idle) setLed(0, 0, 0);
    redraw = true;
  }
  if (redraw) draw();
  delay(5);
}
