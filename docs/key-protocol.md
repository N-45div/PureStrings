# The PureStrings key protocol

Any device can be a PureStrings key: a button, a phone, a watch, a hardware wallet, a till. A key holds a P-256
key, shows what it's asked to sign from the text it signs, and signs only when its owner does something on purpose.
PureStrings passes the request on, and the shop checks the signature against the key you linked at PayPal before
it charges anyone. Nothing between the key and the shop has to be trusted: not the assistant, not the computer,
not PureStrings.

This page is everything a key does. Three keys follow it, and you can start from any of them:

| Key | Where | Signs with |
| --- | --- | --- |
| The PureStrings button | [`firmware/purestrings-button/`](../firmware/purestrings-button/) | mbedTLS on an ESP32-S3 (`key.h` signs, `signable.h` reads the text, `link.h` talks) |
| The key in a browser | [`packages/web/src/key.ts`](../packages/web/src/key.ts) | WebCrypto, with a key that can't be read out |
| The terminal key | [`scripts/terminal-key.ts`](../scripts/terminal-key.ts) | Node's crypto; the whole protocol in one file |

[`key-protocol/vectors.json`](key-protocol/vectors.json) has test vectors to check a key against.

## What a key must do

1. **Make its own key** (ECDSA P-256), and never let the private half out.
2. **Show the facts from the text it signs**, never from anything sent beside it:
   - for a payment: who asked (`by`), the shop's name and its id, every line (quantity, name, price), and the
     total with its currency;
   - for a link: the shop;
   - for an allowance: the shop, what it's for, the one assistant it's for (`by`), the limits, and when it ends.
3. **Refuse a text that isn't written the one way** (below). If it can't read a text, it doesn't sign it.
4. **Warn on a shop it hasn't signed for before**, by the shop's id, so a lookalike name stands out.
5. **Show every line before it can sign.** A long cart turns its pages first.
6. **Sign only on a deliberate act that the connected computer can't do for you.** On the button that's a full
   two-second hold, and a tap says no. The terminal key asks you to type the total, which is a much weaker act:
   there, the computer is the key.
7. **Never hide a character it can't draw.** The button shows `?` in its place.

## The conversation

A key reaches PureStrings in one of two ways. After that, the messages are the same.

- **WebSocket** at `/keys/ws`, with the key's token as `Authorization: Bearer <token>` or `?token=<token>`.
  PureStrings gives a new key its token on the Key screen ("Add a button").
- **USB**, for a device plugged into the computer PureStrings runs on. Each message is a frame:
  - the frame is `0x02`, a kind byte, the length as 4 bytes little-endian, then the payload;
  - kind `T` carries JSON, up to 8 KB; kind `B` carries the voice, from PureStrings to the key only;
  - log lines can go between frames.

  To start, the key sends `{"type":"usb","token":"..."}` every 2 seconds. PureStrings answers `usb-open` and
  then pings with `usb-ping` every 5 seconds; after 15 seconds without one, the key treats the link as closed.
  `usb-closed` says the link has ended. PureStrings finds Espressif devices (USB vendor `303a`) by itself. In
  Chrome or Edge, its Key screen can pass frames on through Web Serial instead.

PureStrings to the key:

| Message | Means |
| --- | --- |
| `hello {name, version, speech}` | PureStrings is there. `speech: true` means its voice will follow, as binary. |
| `signer {ok, fingerprint, name, problem?}` | Whether PureStrings keeps this key. It pins a key the first time and refuses a different one later. |
| `sign {id, kind, flow, text, line, expires, more}` | Something to sign. `text` is exactly what's signed. `line` and `flow` are for speaking and headings only. `more` says how many wait after it. |
| `idle {spentTodayUsd}` | Nothing to sign (any more). |
| `signed {id}` | PureStrings took the signature; the shop is checking it. |
| `answered {id, yes: false}` | The no was taken. |
| `payment {id, status, line}` | How it went: `paid`, `linking` (finish on PayPal's page), `set` (an allowance), or `failed`. |
| `error {message}` · `pong` | |
| binary | The voice, as 24 kHz, 16-bit mono PCM, for a key with a speaker. |

The key to PureStrings:

| Message | Means |
| --- | --- |
| `hello {key}` | Its public key, after PureStrings' hello. |
| `sign {id, signature}` | Its signature of that `sign`'s `text`. |
| `decline {id}` | No. |
| `ping` | Keeps a quiet link open. |

A payment, start to end:

```
PureStrings → key   hello {"name":"PureStrings button","version":"0.1.0","speech":true}
key → PureStrings   hello {"key":"BDn2-CN6..."}
PureStrings → key   signer {"ok":true,"fingerprint":"2027 6CA7 40EF 8EE3","name":"PureStrings button"}
PureStrings → key   sign {"id":"pay_...","kind":"buy","flow":"OpenClaw asks","text":"{\"v\":1,...}","more":0,...}
                    (the key shows it, and its owner holds the button)
key → PureStrings   sign {"id":"pay_...","signature":"OuhEyEjV..."}
PureStrings → key   signed {"id":"pay_..."}
PureStrings → key   payment {"id":"pay_...","status":"paid","line":"Paid $28.50 to Bean & Leaf with PayPal."}
```

## The text a key signs

JSON with its keys in one fixed order, no spaces, UTF-8: what `JSON.stringify` writes. There's exactly one way
to write any payment. To check a text, read it, write it back in this order, and compare the bytes. A key refuses
a text that differs, so it and the shop can't read one text two ways.

| Kind | Keys, in order |
| --- | --- |
| `buy`, a payment | `v`, `kind`, `id`, `allow`?, `by`?, `shop {id, name}`, `cart`, `items [{name, qty, price}]`, `total`, `currency`, `expires` |
| `link`, linking the key at a shop | `v`, `kind`, `id`, `shop {id, name}`, `expires` |
| `allow`, an allowance | `v`, `kind`, `id`, `shop {id, name}`, `for`, `by`?, `agent`, `each`, `total`, `per`, `currency`, `expires` |

- `v` is `1`. `id` is new each time: `pay_`, `link_` or `allow_`, then 8 to 40 letters and digits.
- `shop.id` is the shop's host (and port), like `shop.example.com`. `shop.name` is up to 40 characters.
- Money is a string with two decimals (`"12.00"`). The lines must add up to `total`. A payment has 1 to 12 lines;
  `qty` is 1 to 99, and a line's name is up to 60 characters.
- `by` is the assistant that asked (up to 40 characters). `allow` names the allowance a payment is paid under.
- `agent` in an allowance is PureStrings' own key: the one that signs payments under that allowance.
- `per` is `day`, `week` or `month`. `expires` is UTC to the second: `2026-11-12T18:00:00Z`.
- Names are printable, on one line, with no control or direction-changing characters.
- The whole text is at most 1,500 characters.

## The signature

- **Signature:** ECDSA P-256 with SHA-256, over the text's UTF-8 bytes. It's sent as `r` and `s` side by side
  (64 bytes), base64url without padding: 86 characters. That's what WebCrypto gives; with mbedTLS, write out
  `r` and `s` yourself.
- **Public key:** the uncompressed point (65 bytes, starting `0x04`), base64url.
- **Fingerprint:** the first 8 bytes of the SHA-256 of those 65 bytes, in uppercase hex, in fours, like
  `2027 6CA7 40EF 8EE3`. A key shows its fingerprint, and PureStrings shows the same one, so you can see they match.

## Who checks what

- **PureStrings** pins each key the first time it connects: a button by its token, a browser key by the key
  itself. It refuses a key that has changed.
- **The shop** takes a key when you link it:
  - the key signs a `link`;
  - you say yes on PayPal's page;
  - the shop keeps that key with your saved PayPal.

  From then on, before it charges PayPal, the shop checks that a payment is:
  - signed by that key;
  - the cart it priced;
  - not expired;
  - new (the same `id` gets the same order back).
- **The auditor** reads PayPal's record, and flags any charge that no key of yours signed.

## Test vectors

[`key-protocol/vectors.json`](key-protocol/vectors.json) has:

- `key`: a test key, with its public key and fingerprint. Its private half is there so you can test signing; it's
  for tests only.
- `valid`: texts to accept. Each has a signature by the test key, and the one line and the spoken words
  PureStrings makes from it (`spokenNewShop` is for a shop the key hasn't signed for before).
- `refuse`: texts a key must refuse to sign: keys out of order, a space, lines that don't add up, something
  extra, a hidden direction change, a loosely written price, no expiry.
- `tampered`: texts whose signature must not check out.

A key passes when:
- it accepts every `valid` text;
- it refuses every `refuse` text;
- its signatures of the `valid` texts check out with PureStrings' code.

`npm test` checks PureStrings' side against the vectors (`packages/core/test/key-vectors.test.ts`).
`packages/core/test/button-firmware.test.ts` builds the button's signing code on your computer and checks its
signatures the same way.

## Adding a key

1. In PureStrings, open **Key** and press **Add a button**. Give the token it shows to your key.
2. Connect. PureStrings pins the key and shows its fingerprint.
3. Press **Link at the shop**. The key signs the link, and you say yes on PayPal's page.

From then on, any assistant's payment at that shop comes to that key. Try the terminal key:

```bash
KEY_TOKEN=<the token> node scripts/terminal-key.ts
```

## Where this comes from

- **Bank transaction signers.** Europe's payment rules (PSD2's "dynamic linking") ask for the amount and the
  payee to be shown to you and tied into what's signed, so that changing either one breaks it. Bank card readers
  with their own screen do this for transfers. A PureStrings key does it for every line of a cart, and for who
  asked.
- **Agent payments.** In Google's Agent Payments Protocol (AP2), which PayPal supports, a "cart mandate" is a
  cart the user signs, and an "intent mandate" is limits signed ahead of time. A signed payment here is a cart
  mandate signed on hardware, and an allowance is an intent mandate.
