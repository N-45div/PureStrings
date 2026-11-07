import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFrame, FrameReader } from "../src/usb-frames.ts";

/** The button's cable: its messages as frames, its log between them, however the bytes arrive. */
describe("the button's USB frames", () => {
  const hello = JSON.stringify({ type: "hello", key: "BOk…" });

  it("reads back a message written as a frame, with the log around it", () => {
    const log = new TextEncoder().encode("[purestrings] key 1A2B 3C4D 5E6F 7A8B\r\n");
    const all = new Uint8Array([...log, ...encodeFrame(hello), ...new TextEncoder().encode("[purestrings] signed pay_1\n")]);
    assert.deepEqual(new FrameReader().push(all), [
      { kind: "line", text: "[purestrings] key 1A2B 3C4D 5E6F 7A8B" },
      { kind: "text", text: hello },
      { kind: "line", text: "[purestrings] signed pay_1" },
    ]);
  });

  it("puts a message back together when it comes a byte at a time", () => {
    const reader = new FrameReader();
    const events = [...encodeFrame(hello)].flatMap((byte) => reader.push(new Uint8Array([byte])));
    assert.deepEqual(events, [{ kind: "text", text: hello }]);
  });

  it("skips a stray byte that only looks like the start of a frame", () => {
    const noise = new Uint8Array([0x02, 0x58, 0xff, 0xff, 0xff, 0xff]);
    const events = new FrameReader().push(new Uint8Array([...noise, ...encodeFrame(hello)]));
    assert.deepEqual(events.filter((event) => event.kind === "text"), [{ kind: "text", text: hello }]);
  });

  it("keeps a name with accents whole", () => {
    const text = JSON.stringify({ type: "sign", text: "Café latte" });
    assert.deepEqual(new FrameReader().push(encodeFrame(text)), [{ kind: "text", text }]);
  });
});
