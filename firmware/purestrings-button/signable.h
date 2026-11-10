// What the button is asked to sign: a payment, a link to a shop, or an allowance. Everything it shows is read from
// signText itself, the exact text that gets signed, never from words PureStrings sends beside it: the shop, each
// line, the total, and who asked (`by`). A text it can't read, or whose lines don't add up to its total, it won't sign.
#pragma once
#include <ArduinoJson.h>

struct SignLine {
  String name, price;
  int qty = 0;
};

String signId, signText, signKind, signBy, signShop, signShopId, signTotal, signCurrency, signProblem;
std::vector<SignLine> signLines;
bool signReadable = false, signNew = false;
// An allowance: PureStrings may pay at this shop on its own, up to signEach a time and signTotal a signPer.
String signEach, signPer, signFor, signUntil;
int signMore = 0;            // how many more wait after this one
unsigned long signAt = 0;    // when it arrived: a press that began before isn't a signature
// A cart longer than one page turns its pages by itself, and is signed only once every page has been shown:
// the button never signs a line it hasn't shown.
size_t signPage = 0;
unsigned long signPageAt = 0;
bool signSeen = false;

size_t signPages() { return signKind == "buy" ? (signLines.size() + SIGN_LINES - 1) / SIGN_LINES : 1; }

/** Turns a long cart to its next page, while the button isn't held; the last page shown means every line was. */
void turnSignPage(unsigned long now) {
  size_t pages = signPages();
  if (pages < 2 || now - signPageAt < SIGN_PAGE_MS) return;
  signPage = (signPage + 1) % pages;
  signPageAt = now;
  if (signPage == pages - 1) signSeen = true;
  redraw = true;
}

/** An amount written the one way PureStrings writes it ("12.50") as whole cents, or -1 when it isn't. */
long centsOf(const String &value) {
  int dot = value.indexOf('.');
  if (dot < 1 || dot > 7 || (int)value.length() != dot + 3) return -1;
  long cents = 0;
  for (size_t i = 0; i < value.length(); i++) {
    char c = value.c_str()[i];
    if ((int)i == dot) continue;
    if (c < '0' || c > '9') return -1;
    cents = cents * 10 + (c - '0');
  }
  return cents;
}

/** Shops this key has signed for before, by their id: one it hasn't shows as NEW, so a lookalike stands out. */
bool knownShop(const String &id) {
  String known = "," + prefs.getString("shops", "") + ",";
  return known.indexOf("," + id + ",") >= 0;
}

void rememberShop(const String &id) {
  if (!id.length() || knownShop(id)) return;
  String known = prefs.getString("shops", "");
  known = known.length() ? known + "," + id : id;
  if (known.length() > 1000) known = known.substring(known.indexOf(',', known.length() - 1000) + 1);
  prefs.putString("shops", known);
}

/** What the screen's heading says: who asked, from the text. */
String signHeading() {
  if (signKind == "link") return "Link a shop";
  if (signKind == "allow") return "An allowance";
  return signBy.length() ? signBy + " asks" : "A payment";
}

/** Reads the text to sign into what the screen shows, or says why it won't be signed. */
void readSignable() {
  signLines.clear();
  signReadable = false;
  signProblem = "";
  signBy = "";
  JsonDocument doc;
  if (deserializeJson(doc, signText)) {
    signProblem = "it can't be read";
    return;
  }
  signKind = doc["kind"] | "";
  signShop = doc["shop"]["name"] | "";
  signShopId = doc["shop"]["id"] | "";
  if (!signShopId.length() || !signShop.length() || (signKind != "buy" && signKind != "link" && signKind != "allow")) {
    signProblem = "it isn't something this key signs";
    return;
  }
  signNew = !knownShop(signShopId);
  signUntil = String(doc["expires"] | "").substring(0, 10);
  if (signKind == "link") {
    signReadable = true;
    return;
  }
  signCurrency = doc["currency"] | "";
  signTotal = doc["total"] | "";
  if (signCurrency.length() != 3) {
    signProblem = "it has no currency";
    return;
  }
  if (signKind == "allow") {
    signFor = doc["for"] | "";
    signBy = doc["by"] | "";
    signEach = doc["each"] | "";
    signPer = doc["per"] | "";
    long each = centsOf(signEach), total = centsOf(signTotal);
    if (each <= 0 || total <= 0 || each > total || (signPer != "day" && signPer != "week" && signPer != "month")) {
      signProblem = "its limits don't make sense";
      return;
    }
    signReadable = true;
    return;
  }
  signBy = doc["by"] | "";
  JsonArray items = doc["items"].as<JsonArray>();
  if (items.isNull() || items.size() < 1 || items.size() > 12) {
    signProblem = "it has no lines, or too many";
    return;
  }
  long sum = 0;
  for (JsonObject item : items) {
    SignLine line;
    line.name = item["name"] | "";
    line.price = item["price"] | "";
    line.qty = item["qty"].is<int>() ? item["qty"].as<int>() : 0;
    long each = centsOf(line.price);
    if (!line.name.length() || each <= 0 || line.qty < 1 || line.qty > 99) {
      signProblem = "a line has no name, price or count";
      return;
    }
    sum += each * line.qty;
    signLines.push_back(line);
  }
  if (centsOf(signTotal) != sum) {
    signProblem = "its lines don't add up to its total";
    return;
  }
  signReadable = true;
}

/** A new thing to sign: read it, and start its pages from the first. */
void startSigning(const String &id, const String &text, int more) {
  bool fresh = mode != Mode::Sign || signId != id;
  signMore = more;
  if (!fresh) return;
  signId = id;
  signText = text;
  signAt = millis();
  readSignable();
  signPage = 0;
  signPageAt = millis();
  signSeen = signPages() <= 1;
  replyUntil = 0;
  mode = Mode::Sign;
  logLine("to sign %s: %s at %s (%s)%s", signId.c_str(), signKind.c_str(), signShopId.c_str(), signReadable ? "readable" : signProblem.c_str(), signNew ? ", a new shop" : "");
}
