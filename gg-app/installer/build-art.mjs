// Convert the rendered installer PNGs into the exact assets Tauri's bundlers
// consume, committed under installer/out/:
//   - dmg-background.png : 1320×800 (2× the 660×400 Finder window) — create-dmg
//     takes PNG directly, so we just copy/normalize it.
//   - nsis-sidebar.bmp   : 24-bit BMP, 164×314 (NSIS Welcome/Finish).
//   - nsis-header.bmp    : 24-bit BMP, 150×57  (NSIS page header).
//
// NSIS requires uncompressed BMP and neither sharp nor sips writes BMP, so we
// resize with sharp → raw RGB and pack the BMP (BITMAPINFOHEADER, bottom-up,
// 4-byte row padding) by hand. Run via: pnpm --filter gg-app installer:art
// (after regenerating the PNGs with the screenshot step — see README in
// installer/). Chromium/Playwright is only needed for the PNG step, not here.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "packages",
    "ggcoder",
    "package.json",
  ),
);
const sharp = require("sharp");

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "out");

/** Pack RGB pixels (row-major, top-down) into a 24-bit uncompressed BMP. */
function encodeBmp(rgb, width, height) {
  const rowSize = Math.ceil((width * 3) / 4) * 4; // 4-byte aligned
  const pixelArraySize = rowSize * height;
  const fileSize = 54 + pixelArraySize;
  const buf = Buffer.alloc(fileSize);

  // BITMAPFILEHEADER (14 bytes)
  buf.write("BM", 0, "ascii");
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(54, 10); // pixel data offset
  // BITMAPINFOHEADER (40 bytes)
  buf.writeUInt32LE(40, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(height, 22); // positive → bottom-up
  buf.writeUInt16LE(1, 26); // planes
  buf.writeUInt16LE(24, 28); // bpp
  buf.writeUInt32LE(pixelArraySize, 34);

  // Pixel array: bottom-up rows, BGR order.
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 3;
    let dst = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      const s = srcRow + x * 3;
      buf[dst++] = rgb[s + 2]; // B
      buf[dst++] = rgb[s + 1]; // G
      buf[dst++] = rgb[s]; // R
    }
  }
  return buf;
}

async function toBmp(srcPng, width, height, outName) {
  const { data } = await sharp(srcPng)
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bmp = encodeBmp(data, width, height);
  writeFileSync(join(outDir, outName), bmp);
  console.log(`wrote ${outName} (${width}×${height}, ${bmp.length} bytes)`);
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  // DMG background MUST be 660×400 px to match the Finder window's point size:
  // Finder maps 1 background pixel → 1 window point (it does NOT scale the
  // image to fit), so a larger image only shows its top-left crop. We author
  // dmg.html at 2× (1320×800) and downscale here → supersampled/crisp at the
  // correct final size. Drop-zone rings at 2×(360,340)/(960,340) become
  // (180,170)/(480,170), matching appPosition / applicationFolderPosition in
  // tauri.conf.json.
  await sharp(join(here, "dmg-background.png"))
    .resize(660, 400, { fit: "fill" })
    .png()
    .toFile(join(outDir, "dmg-background.png"));
  console.log("wrote dmg-background.png (660×400)");

  await toBmp(join(here, "nsis-sidebar.png"), 164, 314, "nsis-sidebar.bmp");
  await toBmp(join(here, "nsis-header.png"), 150, 57, "nsis-header.bmp");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
