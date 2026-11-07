// setup.mjs writes config.h for you (node firmware/purestrings-button/setup.mjs). By hand: copy this file to
// config.h and fill it in. config.h stays out of git: it holds the button's token (and your Wi-Fi password).

// How it reaches PureStrings. 1: over its USB cable; PureStrings' Key screen, open in Chrome or Edge, passes its
// messages on ("Connect by USB"), so no Wi-Fi, address or firewall rule is needed. 0: over the Wi-Fi below.
#define PURESTRINGS_LINK_USB 1

// The button's token, from PureStrings' Key screen ("Add a button"), shown once.
#define PURESTRINGS_TOKEN "paste-the-button-token-here"

// Wi-Fi only (PURESTRINGS_LINK_USB 0). The ESP32-S3 joins 2.4 GHz networks only.
#define WIFI_SSID "your-wifi-name"
#define WIFI_PASSWORD "your-wifi-password"
// Where PureStrings' key socket is, as the button sees it: this computer's address on the Wi-Fi (not localhost),
// with PureStrings started on PURESTRINGS_HOST=0.0.0.0 and a token; or wss://<your host>/keys/ws when it's hosted.
#define PURESTRINGS_URL "ws://192.168.1.20:7700/keys/ws"

// How loud its beeps are, 0 (silent) to 100.
#define VOLUME 60
// Some screens show colours inverted, or look best upside down: 1 to turn either around.
#define SCREEN_INVERT 0
#define SCREEN_FLIP 0
