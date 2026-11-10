# Hardware security: what the button stops, and what it doesn't yet

PureStrings treats every program as untrusted: the assistant, the browser, the computer it runs on, and
PureStrings itself. A payment goes through only when a key signs it, and the shop checks that signature before it
charges PayPal. The PureStrings button keeps that decision, and its key, off the computer: it shows the cart on
its own screen and signs it only when you hold it.

That's worth only as much as the button's own firmware. This page is about that firmware: what the button stops
today, what it doesn't, and the steps that close the rest.

## What it stops today

| Someone who... | can... | but... |
| --- | --- | --- |
| fooled your assistant | ask for anything | the button shows exactly what's asked, and you refuse |
| broke into PureStrings | ask for anything, and change what's shown beside it | the button reads every fact from the text it signs |
| changes a signed cart, or replays it | send it to the shop | the signature doesn't match, or the shop returns the same order again |
| runs a program on the computer it's plugged into | send the button anything, and read its log | it can't hold the button, and a locked button can't be reflashed or debugged over the cable |
| holds the shop's PayPal keys | charge your PayPal directly | the auditor flags any charge no key of yours signed, and drafts a dispute |

## The cable

The button talks over USB, and on an ESP32-S3 that cable can do more than talk. Built the usual way, a program on
the computer can:
- restart the chip into its ROM flasher (that's how `esptool` uploads with no buttons pressed), and flash
  firmware that signs without a hold;
- reach the chip's built-in JTAG debugger, stop it, and read its memory.

The firmware is the same, the key is the same, and PureStrings would see nothing wrong.

So the button is built **locked**:
- Its cable goes to the chip's USB-OTG port instead of the built-in USB serial and JTAG port.
- The firmware turns off the requests that restart it into the flasher.
- New firmware goes on only if you hold the button while you plug it in. The chip reads that pin in its ROM,
  before any firmware runs, and nothing on the computer can press it.

Tried on the button:
- `esptool` gets "Failed to connect to ESP32-S3: No serial data received".
- Arduino's 1200-baud touch does nothing.
- Windows sees one serial port and no JTAG device.
- Locked, the button still links, speaks and pays.

Building it unlocked (`USBMode=hwcdc`) is for working on the firmware.

## What's still open

- **The button in someone's hands.** They can hold it while plugging it in and flash it. Or they can read the
  chip's flash, where the key sits as plain bytes, and copy the key.
- **The moment it starts.** At power-on, the chip's ROM and bootloader run before the firmware moves the cable
  to USB-OTG. For that moment the built-in USB serial and JTAG port is on the cable, and a program waiting for it
  could reach the debugger. A program can't make that moment happen, because the firmware won't restart on
  request. But a crash makes one, and so does every time you plug the button in.
- **Your eyes.** The button shows the shop's id and warns on a new one, but a name you don't read is a name
  you don't check.

## Closing it

From cheapest to strongest.

1. **Locked firmware.** Built, tried on the button, and the default. It can be undone: flash an unlocked build
   while holding the button.
2. **The chip's eFuses, on a second board.** These are one-time switches in the chip. Once they're burned, they
   can't be unburned, so don't try it on the button you demo with. With ESP-IDF (Arduino as an ESP-IDF
   component; Arduino's own bootloader can't do this), turn on:
   - **Secure Boot v2** (`CONFIG_SECURE_BOOT_V2_ENABLED`): the chip runs only firmware signed with your signing
     key, so a reflashed button won't start at all.
   - **Flash encryption, release mode** (`CONFIG_SECURE_FLASH_ENC_ENABLED`,
     `CONFIG_SECURE_FLASH_ENCRYPTION_MODE_RELEASE`): flash read off the chip is noise. Release mode also turns JTAG
     off for good.
   - **NVS encryption** (`CONFIG_NVS_ENCRYPTION`, with the key kept by the chip's HMAC peripheral): the key in its
     store is encrypted too.
   - **Secure download mode** (`CONFIG_SECURE_ENABLE_SECURE_ROM_DL_MODE`), or no download mode at all: holding
     the button at start-up no longer lets anyone read flash.
3. **A secure element.** An ATECC608B on the button's I²C pins makes a P-256 key inside itself and signs with
   it, and nothing can read the key out. The signatures are the same P-256 ones, so PureStrings and the shops
   don't change. Another way is a chip whose own signing hardware keeps the key in eFuses: Espressif's ESP32-H2,
   C5 and P4 have one; the S3 doesn't.
4. **Proof of where a key lives.** A secure element comes with a certificate chain showing that its key was
   made inside one. A shop could then take only keys that live in hardware.

Steps 2 to 4 aren't built. The protocol doesn't change for any of them: a hardened button, or a key on a secure
element, signs the same text the same way ([`key-protocol.md`](key-protocol.md)).

## Other keys

- **The key in a browser** can't be read out of the browser, but any script on PureStrings' page can ask it to
  sign. It's for trying PureStrings without the button.
- **The terminal key** keeps its key in a file, and the computer it runs on draws its screen. It shows the
  protocol, and it's for testing.
- **A key on a phone** could keep its key in the phone's Secure Enclave or Keystore. Both sign P-256, so it
  would sign the same way. Neither shows you what it signs on a screen apps can't draw on, and that's the part
  the button is for.
