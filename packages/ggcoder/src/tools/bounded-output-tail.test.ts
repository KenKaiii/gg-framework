import { describe, expect, it } from "vitest";
import {
  BOUNDED_OUTPUT_MAX_BYTES,
  BOUNDED_OUTPUT_MAX_LINES,
  BoundedOutputTail,
  isBinaryOutputChunk,
  OutputChunkDecoder,
} from "./bounded-output-tail.js";

describe("BoundedOutputTail", () => {
  it("preserves a terminal newline without inventing an empty line", () => {
    const tail = new BoundedOutputTail();
    tail.append("first\nsecond\n");

    expect(tail.snapshot()).toMatchObject({
      content: "first\nsecond\n",
      retainedLines: 2,
      capped: false,
    });
  });

  it("preserves a final partial line across appends", () => {
    const tail = new BoundedOutputTail();
    tail.append("first\npar");
    tail.append("tial-😀");

    expect(tail.snapshot()).toMatchObject({
      content: "first\npartial-😀",
      retainedLines: 2,
      capped: false,
    });
  });

  it("retains exactly the final 100 logical lines", () => {
    const tail = new BoundedOutputTail();
    const lines = Array.from({ length: 125 }, (_, index) => `line-${index}\n`);
    for (const line of lines) tail.append(line);

    const snapshot = tail.snapshot();
    expect(snapshot.content).toBe(lines.slice(-BOUNDED_OUTPUT_MAX_LINES).join(""));
    expect(snapshot.retainedLines).toBe(BOUNDED_OUTPUT_MAX_LINES);
    expect(snapshot.capped).toBe(true);
  });

  it("counts a partial final line toward the rolling line limit", () => {
    const tail = new BoundedOutputTail(3, 1_000);
    tail.append("one\ntwo\nthree\nfour");

    expect(tail.snapshot()).toMatchObject({
      content: "two\nthree\nfour",
      retainedLines: 3,
      capped: true,
    });
  });

  it("evicts complete lines before shortening the latest line", () => {
    const tail = new BoundedOutputTail(100, 12);
    tail.append("old\n");
    tail.append("latest界");

    expect(tail.snapshot()).toMatchObject({
      content: "latest界",
      retainedBytes: Buffer.byteLength("latest界"),
      capped: true,
    });
  });

  it("keeps a UTF-8-safe suffix when one line exceeds the byte cap", () => {
    const tail = new BoundedOutputTail(100, 10);
    tail.append("prefix-😀界");

    const snapshot = tail.snapshot();
    expect(snapshot.content).toBe("ix-😀界");
    expect(snapshot.content).not.toContain("�");
    expect(snapshot.retainedBytes).toBe(10);
    expect(snapshot.capped).toBe(true);
  });

  it("stays within 10 MiB while retaining the latest oversized output", () => {
    const tail = new BoundedOutputTail();
    tail.append(`${"a".repeat(BOUNDED_OUTPUT_MAX_BYTES)}\n`);
    tail.append(`latest-${"界".repeat(64)}`);

    const snapshot = tail.snapshot();
    expect(snapshot.totalInputBytes).toBeGreaterThan(BOUNDED_OUTPUT_MAX_BYTES);
    expect(snapshot.retainedBytes).toBeLessThanOrEqual(BOUNDED_OUTPUT_MAX_BYTES);
    expect(snapshot.content.endsWith(`latest-${"界".repeat(64)}`)).toBe(true);
    expect(snapshot.content).not.toContain("�");
    expect(snapshot.capped).toBe(true);
  });

  it("tracks input and retained UTF-8 bytes directly", () => {
    const tail = new BoundedOutputTail(2, 100);
    tail.append("😀\n");
    tail.append("界");

    expect(tail.snapshot()).toMatchObject({
      totalInputBytes: Buffer.byteLength("😀\n界"),
      retainedBytes: Buffer.byteLength("😀\n界"),
      retainedLines: 2,
    });
  });
});

describe("OutputChunkDecoder", () => {
  it("classifies malformed non-NUL UTF-8 from replacement-character evidence", () => {
    const decoder = new OutputChunkDecoder();

    expect(decoder.write(Buffer.from([0x66, 0x80, 0x67]))).toEqual({
      text: "",
      binary: true,
      unsafeBytes: 3,
    });
  });

  it("allows valid multibyte characters split across chunks", () => {
    const decoder = new OutputChunkDecoder();
    const encoded = Buffer.from("😀界");

    const chunks = [encoded.subarray(0, 2), encoded.subarray(2, 5), encoded.subarray(5)];
    const results = chunks.map((chunk) => decoder.write(chunk));

    expect(results.every(({ binary }) => !binary)).toBe(true);
    expect(results.map(({ text }) => text).join("")).toBe("😀界");
    expect(decoder.end()).toEqual({ text: "", binary: false, unsafeBytes: 0 });
  });

  it("detects malformed sequences spanning chunks and incomplete final sequences", () => {
    const spanning = new OutputChunkDecoder();
    expect(spanning.write(Buffer.from([0xe2]))).toMatchObject({ binary: false, text: "" });
    expect(spanning.write(Buffer.from([0x28, 0xa1]))).toEqual({
      text: "",
      binary: true,
      unsafeBytes: 3,
    });

    const incomplete = new OutputChunkDecoder();
    expect(incomplete.write(Buffer.from([0xf0, 0x9f]))).toMatchObject({ binary: false, text: "" });
    expect(incomplete.end()).toEqual({ text: "", binary: true, unsafeBytes: 2 });
  });
});

describe("isBinaryOutputChunk", () => {
  it("classifies NUL and control-heavy chunks as binary", () => {
    expect(isBinaryOutputChunk(Buffer.from([0x74, 0x00, 0x78, 0x74]))).toBe(true);
    expect(isBinaryOutputChunk(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x41]))).toBe(true);
  });

  it("allows normal shell controls, ANSI, CRLF, tabs, emoji, and UTF-8 splits", () => {
    expect(isBinaryOutputChunk(Buffer.from("\tline\r\n\u001b[31mred\u001b[0m\b"))).toBe(false);
    expect(isBinaryOutputChunk(Buffer.from("emoji 😀 and text"))).toBe(false);
    expect(isBinaryOutputChunk(Buffer.from("😀").subarray(1, 3))).toBe(false);
  });

  it("does not classify an isolated uncommon control as materially binary", () => {
    expect(isBinaryOutputChunk(Buffer.from("long text with one control \u0001 byte"))).toBe(false);
  });
});
