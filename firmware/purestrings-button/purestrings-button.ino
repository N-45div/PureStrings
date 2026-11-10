// The PureStrings button: an OceanLabz AI Explorer ESP32-S3 that is your key. It shows exactly what it's asked to
// sign (who asked, the shop, each line, the total), read from the text it signs, and signs it with a P-256 key made
// in its own chip, only when you hold its button for two seconds.
//
//   Something to sign: it chimes and says it. Hold 2 s (a bar fills, ticking; let go at the chirp) = sign: the shop
//                      charges PayPal, and it says what was paid. A tap = refuse. Let go early = nothing; hold again.
//   A long cart:       its pages turn by themselves; it signs only once every line has been shown.
//   Screen blank?      tap five times quickly with nothing to sign: it switches to the other screen wiring.
//
// It talks to PureStrings over its USB cable (plugged into the machine PureStrings runs on) or over Wi-Fi: see
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
#define VOLUME 150
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
  if (forSign && signReadable && signSeen && down && held > 120) {
    drawHoldBar(held);
    // How a hold feels: a click as you press, a tick each quarter of the way, rising, the LED warming toward
    // brass, and a bright chirp once it's full: let go now and it signs.
    static unsigned long ticked = 0;
    static int step = -1;
    int now4 = held >= HOLD_SIGN_MS ? 4 : (int)(4 * held / HOLD_SIGN_MS);
    if (downAt != ticked) {
      ticked = downAt;
      step = -1;
      hushed = true;
      flushPlayback();  // a hold interrupts whatever it was saying
    }
    if (now4 != step) {
      step = now4;
      if (step < 4) beep(500 + 150 * step, 35);
      else {
        beep(1320, 60);
        beep(1760, 90);
      }
      uint8_t warm = 10 + 12 * step;
      setLed(warm, warm * 2 / 3, 0);
    }
  }
  if (mode == Mode::Sign && !down) turnSignPage(now);
  if (!down && wasDown) {
    hushed = false;
    if (forSign && held > 30) {
      // Signed only by a full two-second hold, only if it could be read, and only once every line was shown. A tap
      // is no; letting go early is neither, so a hold that slips doesn't throw the payment away.
      JsonDocument answer;
      if (signReadable && held >= TAP_MS && held < HOLD_SIGN_MS) {
        logLine("let go early on %s: not signed, not refused", signId.c_str());
        hint("Hold until the bar is full.");
        beep(300, 140);
      } else if (signReadable && !signSeen && held >= HOLD_SIGN_MS) {
        logLine("not signed %s: not every line shown yet", signId.c_str());
        hint("Wait for every line, then hold.");
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
/** Why it started. A brownout means the speaker drew more than the USB port gives: turn VOLUME down. */
const char *startedBy() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "power on";
    case ESP_RST_EXT: return "the reset button";
    case ESP_RST_SW: return "a restart";
    case ESP_RST_USB: return "USB (a flash, or the port reset it)";
    case ESP_RST_BROWNOUT: return "a brownout: the speaker drew more than USB gives, so turn VOLUME down";
    case ESP_RST_PANIC: return "a crash";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT: return "a watchdog";
    default: return "something else";
  }
}

void setup() {
  Serial.setRxBufferSize(32768);  // room for half a second of PureStrings' voice, and more
  Serial.begin(115200);
#if ARDUINO_USB_MODE == 0
  // Locked (built with USBMode=default): the cable is the chip's USB-OTG port, so no program on the computer can
  // restart it into its flasher, and the chip's JTAG isn't on the cable at all. To update it, hold the button
  // while you plug it in: the chip starts in its flasher only then.
  Serial.enableReboot(false);
#endif
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
  ampReady = startSpeaker();
  if (!ampReady) logLine("no speaker: it needs PSRAM (compile with PSRAM=opi) and the amp");
  logLine("PureStrings button: screen wiring %d, speaker %s, free memory %u KB, link %s", tftMap + 1, ampReady ? "on" : "off", ESP.getFreeHeap() / 1024, PURESTRINGS_LINK_USB ? "USB" : "Wi-Fi");
  logLine("started after %s", startedBy());
  logLine(ARDUINO_USB_MODE == 0 ? "locked: to update it, hold the button while you plug it in"
                                : "not locked: a program on this computer can flash it over USB (see README: Lock it)");
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
    if (mode == Mode::Idle && !paying) setLed(0, 0, 0);
    redraw = true;
  }
  // Signed, waiting for PayPal: the LED breathes blue, for up to half a minute.
  static unsigned long breathed = 0;
  if (paying && millis() - payingSince > 30000) {
    paying = false;
    setLed(0, 0, 0);
  }
  if (paying && millis() - breathed > 30) {
    breathed = millis();
    float k = 0.5f + 0.5f * sinf(millis() / 220.0f);
    setLed(0, (uint8_t)(6 + 18 * k), (uint8_t)(14 + 46 * k));
  }
  if (redraw) draw();
  delay(5);
}
