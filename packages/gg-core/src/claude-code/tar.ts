import fs from "node:fs";
import fsp from "node:fs/promises";
import zlib from "node:zlib";

const BLOCK = 512;

function readString(buf: Buffer, offset: number, length: number): string {
  const end = buf.indexOf(0, offset);
  return buf.toString("utf8", offset, end === -1 || end > offset + length ? offset + length : end);
}

function readSize(buf: Buffer, offset: number): number {
  // GNU base-256 encoding (high bit set) for sizes past the octal limit.
  if (buf[offset]! & 0x80) {
    let value = buf[offset]! & 0x7f;
    for (let i = 1; i < 12; i++) value = value * 256 + buf[offset + i]!;
    return value;
  }
  const text = readString(buf, offset, 12).trim();
  return text ? parseInt(text, 8) : 0;
}

function paxPath(data: Buffer): string | undefined {
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space === -1) break;
    const len = parseInt(data.toString("utf8", pos, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = data.toString("utf8", space + 1, pos + len - 1);
    const eq = record.indexOf("=");
    if (eq !== -1 && record.slice(0, eq) === "path") return record.slice(eq + 1);
    pos += len;
  }
  return undefined;
}

/**
 * Stream one regular file out of a .tgz into `destPath` without unpacking the
 * rest (or holding the ~300 MB binary in memory). Resolves false when the
 * archive has no such entry.
 */
export async function extractFileFromTarGz(
  tgzPath: string,
  entryName: string,
  destPath: string,
): Promise<boolean> {
  const input = fs.createReadStream(tgzPath).pipe(zlib.createGunzip());
  let pending: Buffer = Buffer.alloc(0);
  let remaining = 0; // data bytes left in the current entry
  let padding = 0; // zero bytes after the data, up to the block boundary
  let kind: "skip" | "pax" | "longname" | "target" = "skip";
  let meta: Buffer[] = [];
  let overridePath: string | undefined;
  let out: fsp.FileHandle | undefined;
  let found = false;

  try {
    for await (const chunk of input as AsyncIterable<Buffer>) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let pos = 0;
      while (pos < pending.length) {
        if (remaining > 0) {
          const take = Math.min(remaining, pending.length - pos);
          const slice = pending.subarray(pos, pos + take);
          if (kind === "target") await out!.write(slice);
          else if (kind === "pax" || kind === "longname") meta.push(Buffer.from(slice));
          pos += take;
          remaining -= take;
          if (remaining === 0) {
            if (kind === "target") {
              await out!.close();
              out = undefined;
              found = true;
            } else if (kind === "pax") {
              overridePath = paxPath(Buffer.concat(meta)) ?? overridePath;
            } else if (kind === "longname") {
              overridePath = readString(Buffer.concat(meta), 0, Number.MAX_SAFE_INTEGER);
            }
          }
          continue;
        }
        if (padding > 0) {
          const skip = Math.min(padding, pending.length - pos);
          pos += skip;
          padding -= skip;
          continue;
        }
        if (found) break;
        if (pending.length - pos < BLOCK) break;
        const header = pending.subarray(pos, pos + BLOCK);
        pos += BLOCK;
        if (header.every((b) => b === 0)) continue; // end-of-archive blocks
        const size = readSize(header, 124);
        const type = String.fromCharCode(header[156] || 0x30);
        let name = readString(header, 0, 100);
        if (readString(header, 257, 6) === "ustar") {
          const prefix = readString(header, 345, 155);
          if (prefix) name = `${prefix}/${name}`;
        }
        remaining = size;
        padding = (BLOCK - (size % BLOCK)) % BLOCK;
        meta = [];
        if (type === "x") kind = "pax";
        else if (type === "L") kind = "longname";
        else {
          const path = overridePath ?? name;
          overridePath = undefined;
          if ((type === "0" || type === "\0" || type === "7") && path === entryName) {
            kind = "target";
            out = await fsp.open(destPath, "w", 0o755);
            if (size === 0) {
              await out.close();
              out = undefined;
              found = true;
            }
          } else {
            kind = "skip";
          }
        }
      }
      pending = pos < pending.length ? Buffer.from(pending.subarray(pos)) : Buffer.alloc(0);
      if (found) break;
    }
    if (!found && out) throw new Error(`Archive ended inside ${entryName}`);
    return found;
  } finally {
    if (out) await out.close().catch(() => {});
    input.destroy();
  }
}
