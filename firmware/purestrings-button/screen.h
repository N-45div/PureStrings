// The button's 1.8" screen (128 x 160): connecting, nothing to sign, something to sign, and how it went.
#pragma once
#include <Fonts/FreeSansBold9pt7b.h>
#include <SPI.h>

/** Words wrapped to the screen's width (21 characters of the built-in font). */
std::vector<String> wrap(const String &text, size_t width = 21, size_t maxLines = 6) {
  std::vector<String> lines;
  String line;
  int start = 0;
  while (start <= (int)text.length() && lines.size() < maxLines) {
    int space = text.indexOf(' ', start);
    String word = text.substring(start, space < 0 ? text.length() : space);
    while (word.length() > width) {  // a word longer than a line is cut across lines, not dropped
      if (line.length()) {
        lines.push_back(line);
        line = "";
      }
      lines.push_back(word.substring(0, width));
      word = word.substring(width);
    }
    if (line.length() + word.length() + (line.length() ? 1 : 0) > width && line.length()) {
      lines.push_back(line);
      line = "";
    }
    line += (line.length() ? " " : "") + word;
    if (space < 0) break;
    start = space + 1;
  }
  if (line.length() && lines.size() < maxLines) lines.push_back(line);
  if (lines.size() > maxLines) lines.resize(maxLines);
  return lines;
}

/** A heading in the bold font, centred, shortened with "..." when it doesn't fit. */
void caption(int baseline, const String &words, uint16_t color) {
  tft->setFont(&FreeSansBold9pt7b);
  tft->setTextSize(1);
  String line = words;
  int16_t x1, y1;
  uint16_t w, h;
  tft->getTextBounds(line, 0, baseline, &x1, &y1, &w, &h);
  while (w > 124 && line.length() > 4) {
    line = line.substring(0, line.length() - 4) + "...";
    tft->getTextBounds(line, 0, baseline, &x1, &y1, &w, &h);
  }
  tft->setTextColor(color);
  tft->setCursor((128 - (int)w) / 2 - x1, baseline);
  tft->print(line);
  tft->setFont(nullptr);
}

/** Small lines, centred, wrapped to the screen's 21 characters. Returns where the next line would go. */
int small(int y, const String &words, uint16_t color, size_t maxLines = 1) {
  tft->setFont(nullptr);
  tft->setTextSize(1);
  tft->setTextColor(color);
  for (const String &line : wrap(words, 21, maxLines)) {
    tft->setCursor((128 - (int)line.length() * 6) / 2, y);
    tft->print(line);
    y += 10;
  }
  return y;
}

/** An amount in big letters, centred: "$32.50", or "32.50 EUR". */
void bigAmount(int y, const String &value, const String &currency) {
  String amount = currency == "USD" ? "$" + value : value + " " + currency;
  tft->setFont(nullptr);
  tft->setTextSize(amount.length() > 10 ? 1 : 2);
  tft->setTextColor(BRASS);
  int width = amount.length() * (amount.length() > 10 ? 6 : 12);
  tft->setCursor(max(0, (128 - width) / 2), y);
  tft->print(amount);
  tft->setTextSize(1);
}

/** The shop's address, red with NEW when this key hasn't signed for it before. */
void shopId(int y) { small(y, ascii(signShopId) + (signNew ? "  NEW" : ""), signNew ? RED : DIM); }

void setupScreen() {
  const TftPins &p = TFT_MAPS[tftMap];
  pinMode(p.bl, OUTPUT);
  digitalWrite(p.bl, HIGH);
  SPIClass *spi = new SPIClass(FSPI);
  spi->begin(p.sclk, -1, p.mosi, p.cs);
  tft = new Adafruit_ST7735(spi, p.cs, p.dc, p.rst);
  tft->initR(INITR_BLACKTAB);
  tft->invertDisplay(SCREEN_INVERT);
  tft->setRotation(SCREEN_FLIP ? 2 : 0);
  tft->fillScreen(BG);
}

void drawSign() {
  small(4, ascii(signHeading()), MUTED);
  if (!signReadable) {
    small(40, "Won't sign this:", RED);
    small(52, signProblem, INK, 4);
    small(141, "tap: refuse", INK);
    return;
  }
  if (signKind == "link") {
    small(30, "Link your PayPal at", INK);
    small(44, ascii(signShop), BRASS, 2);
    shopId(68);
    small(84, "to this key?", INK);
  } else if (signKind == "allow") {
    small(18, "Let PureStrings spend:", INK);
    bigAmount(30, signEach, signCurrency);
    small(48, "a time, at most", INK);
    small(60, (signCurrency == "USD" ? "$" + signTotal : signTotal + " " + signCurrency) + " a " + signPer, BRASS);
    small(74, "at " + ascii(signShop), INK);
    shopId(84);
    small(98, "for " + ascii(signFor), INK, signBy.length() ? 1 : 2);
    if (signBy.length()) small(108, ascii(signBy) + " only", WARN);
    small(120, "until " + signUntil, DIM);
  } else {
    // The total, big; then who's paid (NEW when this key hasn't paid them before), then each line.
    bigAmount(18, signTotal, signCurrency);
    small(40, "to " + ascii(signShop), INK);
    shopId(50);
    int y = 66;
    size_t first = signPage * SIGN_LINES;
    for (size_t i = first; i < signLines.size() && i < first + SIGN_LINES; i++) {
      const SignLine &line = signLines[i];
      String left = String(line.qty) + "x " + ascii(line.name);
      size_t room = 21 - line.price.length() - 1;
      if (left.length() > room) left = left.substring(0, room - 1) + ".";
      tft->setTextColor(INK);
      tft->setCursor(1, y);
      tft->print(left);
      tft->setCursor(128 - (int)line.price.length() * 6, y);
      tft->print(line.price);
      y += 10;
    }
    if (signPages() > 1) small(y, "lines " + String(first + 1) + "-" + String(min(first + SIGN_LINES, signLines.size())) + " of " + String(signLines.size()), MUTED);
  }
  // Why the last hold didn't sign (PureStrings refused it, or this key can't), over the lines for a while.
  if (replyUntil && millis() < replyUntil) {
    tft->fillRect(0, 116, 128, 24, BG);
    small(118, ascii(replyText), WARN, 2);
  }
  if (!signSeen) small(141, "more lines... tap: no", INK);
  else small(141, signMore > 0 ? "hold 2s: sign  +" + String(signMore) : "hold 2s: sign tap: no", INK);
  tft->fillRoundRect(8, 153, 112, 5, 2, TRACK);
}

void draw() {
  if (!tft) return;
  redraw = false;
  tft->fillScreen(BG);
  if (mode == Mode::Connecting) {
    caption(40, "PureStrings", INK);
    caption(80, "Connecting", MUTED);
    small(96, ascii(note), MUTED, 5);
    return;
  }
  if (mode == Mode::Sign) return drawSign();
  if (replyUntil && millis() < replyUntil) {
    caption(40, replyHead, replyGood ? MINT : RED);
    small(60, ascii(replyText), INK, 8);
    return;
  }
  caption(30, "PureStrings", INK);
  small(44, "Nothing to sign", MUTED);
  tft->setTextSize(2);
  tft->setTextColor(BRASS);
  String spent = "$" + String(spentToday, 2);
  tft->setCursor(max(0, (128 - (int)spent.length() * 12) / 2), 70);
  tft->print(spent);
  tft->setTextSize(1);
  small(90, "paid today", MUTED);
  if (signerNote.length()) small(126, signerNote, signerOk ? DIM : WARN, 2);
  else if (chipkey::ready) small(126, "key " + chipkey::fingerprint, DIM);
  else small(126, "no key: can't sign", WARN);
}

/** While you hold on something to sign: a bar fills along the bottom; once it's full, letting go signs it. */
void drawHoldBar(unsigned long held) {
  if (!tft) return;
  static int drawn = -1;
  if (held == 0) {
    drawn = -1;
    return;
  }
  int width = held >= HOLD_SIGN_MS ? 112 : (int)(112 * held / HOLD_SIGN_MS);
  if (width == drawn) return;
  if (width >= 5) tft->fillRoundRect(8, 153, width, 5, 2, MINT);
  if (held >= HOLD_SIGN_MS && drawn < 112) {
    tft->fillRect(0, 140, 128, 10, BG);
    small(141, "let go to sign", MINT);
  }
  drawn = width;
}
