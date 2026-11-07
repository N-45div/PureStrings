// What the button keeps while it runs: its pins, what's on its screen, and its small helpers (the log, the LED,
// a beep). Everything else in the sketch reads and changes these.
#pragma once
#include <Adafruit_NeoPixel.h>
#include <Adafruit_ST7735.h>
#include <ESP_I2S.h>
#include <Preferences.h>
#include <vector>

// ---- Pins: OceanLabz's AI Explorer ESP32-S3 (github.com/ocean-labz/OceanLabz-AI-Explorer-S3-Board) --------------
constexpr int AMP_LRC = 21, AMP_BCLK = 48, AMP_DIN = 47;  // MAX98357A
constexpr int LED_PIN = 14;                                // WS2812B
constexpr int BUTTON_PIN = 0;                              // BOOT, the only button the code can read

struct TftPins {
  int8_t cs, dc, rst, bl, mosi, sclk;
};
// There's no schematic and OceanLabz's repo changed the screen's pins once, so both are here. 0: their map since
// 25 Sep 2026 ("verified working values"). 1: their earlier one, like the silkscreen. Five quick taps switch.
constexpr TftPins TFT_MAPS[2] = {{45, 1, 43, 44, 42, 38}, {45, 38, 1, 42, 43, 44}};

constexpr unsigned long HOLD_SIGN_MS = 2000;  // a payment takes a full two-second hold: it's money
constexpr size_t SIGN_LINES = 6;              // a cart's lines on one page of the screen
constexpr unsigned long SIGN_PAGE_MS = 3000;  // a longer cart turns to its next page this often
constexpr unsigned long REPLY_MS = 8000;      // how long an answer ("Paid", "Didn't go through") stays up

// The screen's colours (RGB565): dark paper, light ink, brass for amounts, red for a shop that's new to this key.
constexpr uint16_t BG = 0x10A5, INK = 0xEF7F, MUTED = 0xAD7A, DIM = 0x6B95, BRASS = 0xFDE4, MINT = 0x6F35,
                   TRACK = 0x296A, RED = 0xFA6B, WARN = 0xFD34;

// ---- State --------------------------------------------------------------------------------------------
enum class Mode { Connecting, Idle, Sign };

Adafruit_ST7735 *tft = nullptr;
Adafruit_NeoPixel led(1, LED_PIN, NEO_GRB + NEO_KHZ800);
I2SClass amp;
bool ampReady = false;
Preferences prefs;

Mode mode = Mode::Connecting;
bool redraw = true;
bool linkUp = false;     // talking to PureStrings now
int tftMap = 0;          // which of TFT_MAPS is in use
String note;             // what the connecting screen says
float spentToday = 0;    // dollars paid today, as PureStrings says
// The key as PureStrings holds it: kept (ok), or refused with why. Shown on the idle screen.
bool signerOk = false;
String signerNote;
// An answer to show for a while: "Paid" and its line, or why it didn't go through.
String replyHead, replyText;
bool replyGood = false;
unsigned long replyUntil = 0;

// ---- Small helpers ------------------------------------------------------------------------------------
/** One line on USB (115200 baud): what the button is doing, for when the screen can't say. */
template <typename... Args>
void logLine(const char *format, Args... args) {
  Serial.print("[purestrings] ");
  Serial.printf(format, args...);
  Serial.println();
}

void setLed(uint8_t r, uint8_t g, uint8_t b) {
  led.setPixelColor(0, led.Color(r, g, b));
  led.show();
}

/** A short tone on the speaker, faded in and out so it doesn't click. Quiet when there's no speaker. */
void beep(float hz, int ms) {
  if (!ampReady || VOLUME <= 0) return;
  constexpr uint32_t RATE = 16000;
  static int16_t chunk[160];
  const int total = RATE * ms / 1000;
  const float level = min(1.0f, VOLUME / 100.0f) * 0.3f;
  for (int done = 0; done < total;) {
    int n = min(160, total - done);
    for (int i = 0; i < n; i++) {
      float fade = min(1.0f, min((done + i) / 160.0f, (total - done - i) / 160.0f));
      chunk[i] = (int16_t)(sinf(2 * PI * hz * (done + i) / RATE) * 32767 * level * fade);
    }
    amp.write(reinterpret_cast<uint8_t *>(chunk), n * 2);
    done += n;
  }
}

/**
 * Words as the screen's font can show them: plain ASCII, with the few marks a shop's text uses spelled out, and
 * "?" for any other character, so a lookalike letter in a shop's name shows instead of vanishing.
 */
String ascii(const String &words) {
  String out;
  for (size_t i = 0; i < words.length(); i++) {
    uint8_t c = words[i];
    if (c < 0x80) {
      out += c >= 0x20 && c != 0x7F ? (char)c : '?';
      continue;
    }
    String three = words.substring(i, i + 3), two = words.substring(i, i + 2);
    if (three == "\xE2\x82\xB9") out += "Rs ";                                     // ₹
    else if (three == "\xE2\x82\xAC") out += "EUR ";                               // €
    else if (two == "\xC2\xA3") out += "GBP ";                                     // £
    else if (two == "\xC3\x97") out += "x";                                        // ×
    else if (three == "\xE2\x80\xA6") out += "...";                                // …
    else if (three == "\xE2\x80\x93" || three == "\xE2\x80\x94") out += "-";       // – —
    else if (three == "\xE2\x80\x98" || three == "\xE2\x80\x99") out += "'";       // ‘ ’
    else if (three == "\xE2\x80\x9C" || three == "\xE2\x80\x9D") out += "\"";      // “ ”
    else out += "?";
    while (i + 1 < words.length() && (words[i + 1] & 0xC0) == 0x80) i++;  // the rest of that character
  }
  return out;
}
