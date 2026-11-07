/**
 * The PureStrings button's messages on its USB cable. The button writes each message as a frame: STX (0x02), 'T',
 * the length (4 bytes, little-endian), then the JSON. Anything between frames is the button's log, line by line.
 */

const STX = 0x02;
const HEAD = 6;
/** Bigger than anything either side sends; a header claiming more is noise, not a frame. */
const MAX_FRAME = 8_192;

export type CableEvent = { readonly kind: "line"; readonly text: string } | { readonly kind: "text"; readonly text: string };

/** A JSON message as a frame for the cable. */
export function encodeFrame(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  const frame = new Uint8Array(HEAD + bytes.length);
  frame[0] = STX;
  frame[1] = "T".charCodeAt(0);
  new DataView(frame.buffer).setUint32(2, bytes.length, true);
  frame.set(bytes, HEAD);
  return frame;
}

/** Splits what comes off the cable into log lines and messages, however the bytes are chunked. */
export class FrameReader {
  private pending = new Uint8Array(0);
  private line = "";
  private readonly decoder = new TextDecoder();

  push(chunk: Uint8Array): CableEvent[] {
    const events: CableEvent[] = [];
    const all = new Uint8Array(this.pending.length + chunk.length);
    all.set(this.pending);
    all.set(chunk, this.pending.length);
    let at = 0;
    while (at < all.length) {
      const stx = all.indexOf(STX, at);
      this.addText(all.subarray(at, stx < 0 ? all.length : stx), events);
      if (stx < 0) {
        at = all.length;
        break;
      }
      if (all.length - stx < HEAD) {
        at = stx;
        break;
      }
      const length = new DataView(all.buffer, all.byteOffset + stx + 2, 4).getUint32(0, true);
      if (all[stx + 1] !== "T".charCodeAt(0) || length > MAX_FRAME) {
        at = stx + 1; // not a frame: skip the stray byte
        continue;
      }
      if (all.length - stx - HEAD < length) {
        at = stx;
        break;
      }
      events.push({ kind: "text", text: new TextDecoder().decode(all.subarray(stx + HEAD, stx + HEAD + length)) });
      at = stx + HEAD + length;
    }
    this.pending = all.slice(at);
    return events;
  }

  private addText(bytes: Uint8Array, events: CableEvent[]): void {
    if (!bytes.length) return;
    this.line += this.decoder.decode(bytes, { stream: true });
    const parts = this.line.split("\n");
    this.line = parts.pop() ?? "";
    for (const part of parts) {
      const text = part.replace(/\r$/, "");
      if (text) events.push({ kind: "line", text });
    }
  }
}
