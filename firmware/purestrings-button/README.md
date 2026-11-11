# The PureStrings button

The PureStrings button is a key you can hold. It's an
[OceanLabz AI Explorer ESP32-S3](https://github.com/ocean-labz/OceanLabz-AI-Explorer-S3-Board) with a
1.8" screen, a speaker and one button. When an assistant asks to pay, the button shows exactly what it would
sign: who asked, the shop, each line and the total. It signs only when you hold the button for two seconds.
The shop charges your PayPal only for a cart that this key signed. The screen is optional: without one, the button
reads each request aloud, and everything below works the same, minus what's drawn.

- **Something to sign:** it chimes and shows the total, then who's paid, then each line, and it says it aloud
  ("OpenClaw asks to pay 12 dollars to Bean & Leaf..."). A shop it hasn't signed for before shows **NEW** in red,
  and it warns you, so a lookalike stands out. Hold for two seconds to sign: a bar fills and ticks, and a chirp
  says it's full. Let go, and the LED breathes while the shop charges your PayPal; then it chimes and says what
  was paid. A tap refuses. Let go early and nothing's sent: hold again.
- **A long cart:** more than six lines turn their pages every three seconds. It signs only once every page
  has been shown.
- **Links and allowances:** linking the key to your PayPal at a shop, and an allowance (what PureStrings may
  spend on its own there: a time, a day, week or month, until when), are signed the same way.
- **Nothing to sign:** it shows what was paid today and its key's fingerprint.

It talks to PureStrings over its USB cable (the default) or over Wi-Fi.

- **USB:** plugged into the computer PureStrings runs on, PureStrings finds the button and links it itself,
  with no page open. Plugged into another computer, PureStrings' Key screen in Chrome or Edge reads it through
  Web Serial and passes its messages on ("Connect by USB"). Either way there's no Wi-Fi, no address and no
  firewall rule, and the ESP32-S3's own USB port needs no driver. Set `PURESTRINGS_USB=off` to leave it to the
  Key screen.
- **Wi-Fi:** the button connects to PureStrings' key socket (`/keys/ws`) by itself. That's your machine on your
  network, or a hosted PureStrings over `wss://`.

Its voice comes from PureStrings. With an OpenAI key set (`OPENAI_API_KEY`, or `MODEL_KEY` with OpenAI's
`MODEL_URL`), OpenAI's `gpt-4o-mini-tts` makes the words and PureStrings streams them to the speaker. Without a key,
it chimes and shows. What it says comes from the text it signs, but trust the screen: that's what the key read.

## Set it up

1. **Tools.** Install [arduino-cli](https://arduino.github.io/arduino-cli/), the ESP32 core 3.3.12 and these
   libraries:

   ```bash
   arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
   arduino-cli core update-index
   arduino-cli core install esp32:esp32@3.3.12
   arduino-cli lib install "Adafruit ST7735 and ST7789 Library" "Adafruit GFX Library" "Adafruit NeoPixel" ArduinoJson WebSockets
   ```

2. **Write `config.h`** while PureStrings is running (`npm start`), from the repository's root:

   ```bash
   node firmware/purestrings-button/setup.mjs            # asks: usb (Enter) or wifi
   ```

   It makes the button's token in PureStrings and writes `config.h`, which git ignores. For Wi-Fi it also
   finds this computer's address and asks for the Wi-Fi name and password. Set `PURESTRINGS_TOKEN` if
   PureStrings was started with one.

   To do it by hand instead, copy `config.example.h` to `config.h`, then press **Add a button** on the Key screen
   and paste the token it shows.

3. **Compile and flash** with the button plugged in:

   ```bash
   FQBN="esp32:esp32:esp32s3:USBMode=default,CDCOnBoot=cdc,FlashMode=qio,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,DebugLevel=none"
   arduino-cli board list                                   # find its port, e.g. COM5
   arduino-cli compile --fqbn "$FQBN" firmware/purestrings-button
   arduino-cli upload --fqbn "$FQBN" -p COM5 firmware/purestrings-button
   ```

   That builds it **locked** (below). A button that's already locked takes new firmware only when you ask it to
   in person: unplug it, hold its button while you plug it back in, let go, then upload (its port may change).
   While you work on the firmware itself, `USBMode=hwcdc` builds it unlocked, so an upload needs no hands.

4. **Over USB, connect it:** open PureStrings in Chrome or Edge, go to **Key**, press **Connect by USB** and
   pick the ESP32-S3. The card shows what the button says, then "Connected over USB". Press **Disconnect**
   there before you flash it again, because only one program can hold the port.

5. **Link it at the shop:** in **Key**, under Buttons, press **Link at the shop**. The button shows "Link your
   PayPal at Bean & Leaf"; hold to sign it. Then say yes on PayPal's page. From then on the shop charges your
   PayPal for carts this button signs.

## How it signs

- **Its own key.** The first time it starts, the button makes a P-256 key with the chip's own entropy source
  and keeps it in its flash. It gives PureStrings only the public half, and its log prints the key's
  fingerprint (`key 1A2B 3C4D 5E6F 7A8B`). The Key screen shows the same fingerprint, so you can check they
  match. At each start it signs a test text and checks it with its own public key; a button that fails that
  signs nothing.
- **Kept the first time.** PureStrings keeps the key the first time the button says it. If the button later
  says another key, PureStrings refuses it and the button shows "key refused". That happens after new firmware
  that wiped its flash, or with another ESP32 using its token. Remove the button on the Key screen and add it
  again to trust the new key.
- **What it shows is what it signs.** It reads the shop, each line, the total and who asked from the exact
  text it signs, not from anything sent with it. It won't sign a text whose lines don't add up to its total.
  Any character its font can't show appears as `?`, so a lookalike letter in a shop's name can't hide.
- **How.** ECDSA P-256 over the SHA-256 of the text's bytes, deterministic (RFC 6979), r and s side by side,
  base64url. PureStrings checks the signature, and so does the shop, against the key you linked there, before
  it charges your PayPal.

`packages/core/test/button-firmware.test.ts` builds this signing code (`key.h`) on a computer against mbedTLS,
with stand-ins for the chip's flash and random source in `test/host`. It checks the key and signatures with the
code PureStrings and the shop use. The test needs a C++ compiler and mbedTLS: `apt install g++ libmbedtls-dev`,
or on Windows MSYS2's `mingw-w64-ucrt-x86_64-gcc` and `mingw-w64-ucrt-x86_64-mbedtls`. Without them it's
skipped.

## Locked

A key is only as good as the firmware it runs. If a program on your computer could quietly flash the button with
firmware that signs without a hold, holding the button would prove nothing. So the button is built locked
(`USBMode=default`):

- Its cable goes to the ESP32-S3's USB-OTG port, and the firmware turns off the requests that restart a chip
  into its flasher. `esptool` gets "Failed to connect to ESP32-S3: No serial data received", and Arduino's
  1200-baud touch does nothing.
- The chip's built-in JTAG debugger isn't on the cable at all, so nothing can stop the chip and read its memory
  through it. Windows lists the button as a single serial port.
- New firmware goes on only when you hold the button while plugging it in. The chip reads that button when it
  starts, in its own ROM, before any firmware runs.

The log says which it is at each start: `locked: to update it, hold the button while you plug it in`.

Locking stops a program on the computer. It doesn't stop someone who has the button in their hands: they can
hold it while plugging it in and flash it, or read the key out of the chip's flash, where it sits unencrypted.
Closing that takes the chip's one-time eFuses (secure boot and flash encryption), or a secure element that keeps
the key. [`docs/hardware-security.md`](../../docs/hardware-security.md) goes through what each step stops.

## If something's off

The button logs every step on USB at 115200 baud. Over USB, the Key screen's card shows the log. Over Wi-Fi,
read it with `arduino-cli monitor -p COM5 -c baudrate=115200`.

- **Blank screen:** OceanLabz changed the screen's pins once, and there's no schematic. With nothing to
  sign, tap the button five times quickly: it switches to the other wiring and restarts. At start-up the LED
  blinks once or twice to say which wiring is in use.
- **Colours look wrong or it's upside down:** set `SCREEN_INVERT` or `SCREEN_FLIP` to 1 in `config.h`.
- **Connect by USB lists nothing:** use a cable that carries data, not a charging-only one, and the button's
  ESP32-S3 USB port.
- **"Couldn't open the button's port":** a serial monitor or an upload has it. Close that, then connect again.
- **"PureStrings refused the button":** its token isn't one this PureStrings made. Run `setup.mjs` again (with
  `--force`) and flash it.
- **Stuck joining Wi-Fi:** it needs a 2.4 GHz network.
- **"Can't reach PureStrings" over Wi-Fi:** check these, in order:
  - PureStrings runs with `PURESTRINGS_HOST=0.0.0.0` and a `PURESTRINGS_TOKEN`;
  - port 7700 is open on a Private network;
  - `PURESTRINGS_URL` in `config.h` is this computer's current address.
- **Won't boot with an SD card in:** GPIO 3 and 46 (the SD slot) are strapping pins, so take the card out.
