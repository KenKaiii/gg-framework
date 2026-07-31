import { StringDecoder } from "node:string_decoder";

export const BOUNDED_OUTPUT_MAX_LINES = 100;
export const BOUNDED_OUTPUT_MAX_BYTES = 10 * 1024 * 1024;

export interface BoundedOutputTailSnapshot {
  content: string;
  totalInputBytes: number;
  retainedBytes: number;
  retainedLines: number;
  capped: boolean;
}

/**
 * Returns a UTF-8-safe suffix whose encoded size is at most maxBytes.
 */
function utf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0 || value.length === 0) return "";
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;

  let start = encoded.length - maxBytes;
  while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start += 1;
  return encoded.subarray(start).toString("utf8");
}

/**
 * Rolling text tail bounded by logical lines and encoded UTF-8 bytes.
 * Complete oldest lines are evicted before the current line is shortened.
 */
export class BoundedOutputTail {
  private readonly completeLines: string[] = [];
  private partialLine = "";
  private completeBytes = 0;
  private partialBytes = 0;
  private inputBytes = 0;
  private didCap = false;

  constructor(
    private readonly maxLines = BOUNDED_OUTPUT_MAX_LINES,
    private readonly maxBytes = BOUNDED_OUTPUT_MAX_BYTES,
  ) {
    if (!Number.isInteger(maxLines) || maxLines < 1) {
      throw new RangeError("maxLines must be a positive integer");
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError("maxBytes must be a positive integer");
    }
  }

  append(text: string): void {
    if (text.length === 0) return;
    this.inputBytes += Buffer.byteLength(text, "utf8");

    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      if (newline === -1) {
        this.appendToPartial(text.slice(start));
        break;
      }

      this.appendToPartial(text.slice(start, newline + 1));
      this.completeLines.push(this.partialLine);
      this.completeBytes += this.partialBytes;
      this.partialLine = "";
      this.partialBytes = 0;
      this.enforceLineLimit();
      start = newline + 1;
    }
  }

  snapshot(): BoundedOutputTailSnapshot {
    return {
      content: this.completeLines.join("") + this.partialLine,
      totalInputBytes: this.inputBytes,
      retainedBytes: this.completeBytes + this.partialBytes,
      retainedLines: this.completeLines.length + (this.partialLine.length > 0 ? 1 : 0),
      capped: this.didCap,
    };
  }

  private appendToPartial(fragment: string): void {
    if (fragment.length === 0) return;
    const fragmentBytes = Buffer.byteLength(fragment, "utf8");

    while (
      this.completeLines.length > 0 &&
      this.completeBytes + this.partialBytes + fragmentBytes > this.maxBytes
    ) {
      this.evictOldestCompleteLine();
    }

    if (this.completeBytes + this.partialBytes + fragmentBytes <= this.maxBytes) {
      this.partialLine += fragment;
      this.partialBytes += fragmentBytes;
      this.enforceLineLimit();
      return;
    }

    const availableForPartial = this.maxBytes - this.completeBytes;
    if (fragmentBytes >= availableForPartial) {
      this.partialLine = utf8Suffix(fragment, availableForPartial);
    } else {
      this.partialLine =
        utf8Suffix(this.partialLine, availableForPartial - fragmentBytes) + fragment;
    }
    this.partialBytes = Buffer.byteLength(this.partialLine, "utf8");
    this.didCap = true;
    this.enforceLineLimit();
  }

  private enforceLineLimit(): void {
    const partialCount = this.partialLine.length > 0 ? 1 : 0;
    while (this.completeLines.length + partialCount > this.maxLines) {
      this.evictOldestCompleteLine();
    }
  }

  private evictOldestCompleteLine(): void {
    const evicted = this.completeLines.shift();
    if (evicted === undefined) return;
    this.completeBytes -= Buffer.byteLength(evicted, "utf8");
    this.didCap = true;
  }
}

const ALLOWED_TEXT_CONTROLS = new Set([0x08, 0x09, 0x0a, 0x0d, 0x1b]);
const REPLACEMENT_CHARACTER = "\uFFFD";

export interface OutputChunkDecodeResult {
  text: string;
  binary: boolean;
  unsafeBytes: number;
}

/** Conservatively identifies byte patterns that are unsafe for the UTF-8 text log. */
export function isBinaryOutputChunk(chunk: Buffer): boolean {
  if (chunk.includes(0)) return true;
  if (chunk.length === 0) return false;

  let disallowedControls = 0;
  for (const byte of chunk) {
    if ((byte < 0x20 && !ALLOWED_TEXT_CONTROLS.has(byte)) || byte === 0x7f) {
      disallowedControls += 1;
    }
  }

  return disallowedControls >= 4 && disallowedControls / chunk.length >= 0.1;
}

/**
 * Stateful UTF-8 decoder that rejects binary byte patterns and decoder replacement
 * characters. Decoder state prevents valid code points split across chunks from being
 * mistaken for malformed UTF-8.
 */
export class OutputChunkDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private pendingBytes = 0;
  private binary = false;

  write(chunk: Buffer): OutputChunkDecodeResult {
    if (this.binary) return { text: "", binary: true, unsafeBytes: chunk.length };

    const bytesUnderTest = this.pendingBytes + chunk.length;
    if (isBinaryOutputChunk(chunk)) {
      this.binary = true;
      return { text: "", binary: true, unsafeBytes: bytesUnderTest };
    }

    const text = this.decoder.write(chunk);
    if (text.includes(REPLACEMENT_CHARACTER)) {
      this.binary = true;
      return { text: "", binary: true, unsafeBytes: bytesUnderTest };
    }

    this.pendingBytes = bytesUnderTest - Buffer.byteLength(text, "utf8");
    return { text, binary: false, unsafeBytes: 0 };
  }

  end(): OutputChunkDecodeResult {
    if (this.binary) return { text: "", binary: true, unsafeBytes: 0 };

    const text = this.decoder.end();
    if (text.includes(REPLACEMENT_CHARACTER)) {
      this.binary = true;
      const unsafeBytes = this.pendingBytes;
      this.pendingBytes = 0;
      return { text: "", binary: true, unsafeBytes };
    }

    this.pendingBytes = 0;
    return { text, binary: false, unsafeBytes: 0 };
  }
}
