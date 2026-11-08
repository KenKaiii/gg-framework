import { describe, expect, it } from "vitest";
import sharp from "sharp";
import {
  appToolImages,
  SCREEN_PREVIEW_MAX,
  screenPreview,
  boundedSize,
  fitsVisualBudget,
  previewForApp,
  previewsForImageBlocks,
  shrinkToFit,
  withAppImagePreviews,
} from "./image.js";

const PATCH = 28;
const MAX_PATCHES = 1568;
const MAX_EDGE = 1568;

function patchArea(width: number, height: number): number {
  return (width * height) / (PATCH * PATCH);
}

/** Solid-colour PNG of exact dimensions — cheap to encode, real bytes for sharp. */
function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 32, g: 64, b: 128, alpha: 1 } },
  })
    .png()
    .toBuffer();
}

describe("previewsForImageBlocks", () => {
  it("previews image blocks only, shrinking wide ones for the chat", async () => {
    const wide = (await makePng(1200, 300)).toString("base64");
    const caption = { type: "text", text: "caption" };
    const previews = await previewsForImageBlocks([
      caption,
      { type: "image", mediaType: "image/png", data: wide },
    ]);

    expect(previews).toHaveLength(1);
    expect(previews[0]?.mediaType).toBe("image/png");
    const meta = await sharp(Buffer.from(previews[0]?.base64 ?? "", "base64")).metadata();
    expect(meta.width).toBe(480);
  });
});

describe("boundedSize", () => {
  const cases: Array<{
    name: string;
    input: [number, number];
    expected: [number, number];
  }> = [
    {
      name: "1280x800 laptop screenshot is already inside the budget",
      input: [1280, 800],
      expected: [1280, 800],
    },
    {
      name: "2000x2000 square shrinks to the patch budget",
      input: [2000, 2000],
      expected: [1108, 1108],
    },
    { name: "1x1 survives", input: [1, 1], expected: [1, 1] },
    { name: "1568x1 is exactly at the edge cap", input: [1568, 1], expected: [1568, 1] },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      expect(boundedSize(input[0], input[1])).toEqual({ width: expected[0], height: expected[1] });
    });
  }

  it("2560x1600 stays within 1568 patches", () => {
    const { width, height } = boundedSize(2560, 1600);
    expect(patchArea(width, height)).toBeLessThanOrEqual(MAX_PATCHES);
    expect(Math.max(width, height)).toBeLessThanOrEqual(MAX_EDGE);
    // aspect preserved within a pixel of rounding
    expect(Math.abs(width / height - 2560 / 1600)).toBeLessThan(0.01);
  });

  it("caps a 3000x400 panorama at 1568 on the long edge", () => {
    // Well inside the patch budget (1.2 MP) — only the per-side cap binds here.
    expect(patchArea(3000, 400)).toBeLessThanOrEqual(MAX_PATCHES);
    expect(boundedSize(3000, 400)).toEqual({ width: 1568, height: 209 });
  });

  it("returns the largest fitting size, not merely a fitting one", () => {
    for (const [w, h] of [
      [2000, 2000],
      [2560, 1600],
      [4000, 3000],
      [800, 5000],
    ] as Array<[number, number]>) {
      const { width, height } = boundedSize(w, h);
      expect(fitsVisualBudget(width, height)).toBe(true);
      // One pixel more on the long edge must break the budget or hit the cap.
      const landscape = w >= h;
      const long = landscape ? width : height;
      expect(long).toBeGreaterThan(0);
      if (long < MAX_EDGE) {
        const nextLong = long + 1;
        const ratio = landscape ? h / w : w / h;
        const nextShort = Math.max(1, Math.round(nextLong * ratio));
        const next = landscape
          ? { width: nextLong, height: nextShort }
          : { width: nextShort, height: nextLong };
        expect(fitsVisualBudget(next.width, next.height)).toBe(false);
      }
    }
  });

  it("leaves non-finite or sub-pixel input alone", () => {
    expect(boundedSize(0, 0)).toEqual({ width: 0, height: 0 });
    expect(boundedSize(Number.NaN, 10)).toEqual({ width: Number.NaN, height: 10 });
  });
});

describe("fitsVisualBudget", () => {
  it("rejects anything past the per-side cap even at tiny area", () => {
    expect(fitsVisualBudget(1569, 1)).toBe(false);
    expect(fitsVisualBudget(1568, 1)).toBe(true);
  });

  it("rejects anything past the patch budget", () => {
    expect(fitsVisualBudget(1108, 1108)).toBe(true);
    expect(fitsVisualBudget(1109, 1109)).toBe(false);
  });
});

describe("shrinkToFit", () => {
  it("returns a 1280x800 PNG byte-identical to the input", async () => {
    const original = await makePng(1280, 800);
    const { buffer, mediaType } = await shrinkToFit(original, "image/png");
    expect(mediaType).toBe("image/png");
    expect(buffer.equals(original)).toBe(true);
  });

  it("downscales a 2000x2000 PNG to 1108x1108 and keeps it a PNG", async () => {
    const { buffer, mediaType } = await shrinkToFit(await makePng(2000, 2000), "image/png");
    expect(mediaType).toBe("image/png");
    const meta = await sharp(buffer).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 1108, height: 1108 });
    expect(meta.format).toBe("png");
  });

  it("brings a 2560x1600 screenshot inside the patch budget", async () => {
    const { buffer } = await shrinkToFit(await makePng(2560, 1600), "image/png");
    const meta = await sharp(buffer).metadata();
    expect(patchArea(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(MAX_PATCHES);
  });

  it("caps a 3000x400 panorama at the long-edge limit", async () => {
    const { buffer } = await shrinkToFit(await makePng(3000, 400), "image/png");
    const meta = await sharp(buffer).metadata();
    // sharp's fit: "inside" preserves the exact source aspect, so the long edge
    // can land a pixel under the target — it must never land over it.
    expect(meta.width).toBeLessThanOrEqual(MAX_EDGE);
    expect(meta.width).toBeGreaterThan(MAX_EDGE - 4);
    expect(patchArea(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(MAX_PATCHES);
  });

  it("leaves a 1x1 image untouched", async () => {
    const original = await makePng(1, 1);
    const { buffer } = await shrinkToFit(original, "image/png");
    expect(buffer.equals(original)).toBe(true);
  });

  it("preserves the alpha channel rather than flattening to JPEG", async () => {
    const transparent = await sharp({
      create: {
        width: 2000,
        height: 2000,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .png()
      .toBuffer();
    const { buffer, mediaType } = await shrinkToFit(transparent, "image/png");
    expect(mediaType).toBe("image/png");
    const meta = await sharp(buffer).metadata();
    expect(meta.hasAlpha).toBe(true);
  });
});

/** A screenshot-sized PNG. */
function screenshotPng(width = 1400, height = 900): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 210, g: 40, b: 40 } },
  })
    .png()
    .toBuffer();
}

describe("previewForApp", () => {
  it("narrows a wide image to 480 px, as WebP", async () => {
    const out = await previewForApp(await screenshotPng(), "image/png");
    const meta = await sharp(out.buffer).metadata();
    expect([out.mediaType, meta.format, meta.width]).toEqual(["image/webp", "webp", 480]);
  });

  it("keeps a narrow image's size, as WebP", async () => {
    const out = await previewForApp(await screenshotPng(300, 200), "image/png");
    const meta = await sharp(out.buffer).metadata();
    expect([out.mediaType, meta.width, meta.height]).toEqual(["image/webp", 300, 200]);
  });

  it("gives back what it can't read, as it was", async () => {
    const junk = Buffer.from("not an image");
    expect(await previewForApp(junk, "image/png")).toEqual({
      buffer: junk,
      mediaType: "image/png",
    });
  });
});

describe("withAppImagePreviews", () => {
  it("makes each image preview the app's, and keeps the rest", async () => {
    const png = (await screenshotPng()).toString("base64");
    const details = {
      outPath: "/shots/a.png",
      imagePreviews: [{ base64: png, mediaType: "image/png", path: "/shots/a.png" }],
    };
    const out = (await withAppImagePreviews(details)) as typeof details;
    const [preview] = out.imagePreviews;
    expect(out.outPath).toBe("/shots/a.png");
    expect([preview?.mediaType, preview?.path]).toEqual(["image/webp", "/shots/a.png"]);
    const meta = await sharp(Buffer.from(preview?.base64 ?? "", "base64")).metadata();
    expect([meta.format, meta.width]).toEqual(["webp", 480]);
    // The tool's own details are untouched.
    expect(details.imagePreviews[0]?.mediaType).toBe("image/png");
  });

  it("gives back details with no image previews as they are", async () => {
    const plain = { diff: "x" };
    const none = { imagePreviews: [] };
    for (const details of [undefined, "text", plain, none]) {
      expect(await withAppImagePreviews(details)).toBe(details);
    }
  });
});

describe("appToolImages", () => {
  it("gives each image as a WebP data URL 480 px wide, with the file's path", async () => {
    const data = (await screenshotPng()).toString("base64");
    const [image] = await appToolImages([{ data, mediaType: "image/png" }], "/shots/a.png");
    const prefix = "data:image/webp;base64,";
    expect(image?.src.startsWith(prefix)).toBe(true);
    expect(image?.path).toBe("/shots/a.png");
    const meta = await sharp(
      Buffer.from(image?.src.slice(prefix.length) ?? "", "base64"),
    ).metadata();
    expect([meta.format, meta.width]).toEqual(["webp", 480]);
  });

  it("gives an image it can't read as it was", async () => {
    const data = Buffer.from("not an image").toString("base64");
    expect(await appToolImages([{ data, mediaType: "image/png" }], undefined)).toEqual([
      { src: `data:image/png;base64,${data}` },
    ]);
  });
});

describe("screenPreview", () => {
  /** A poster-like PNG: smooth gradients, as a generated image has. */
  async function poster(width: number, height: number): Promise<Buffer> {
    const raw = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 3;
        raw[i] = (x * 255) / width;
        raw[i + 1] = (y * 255) / height;
        raw[i + 2] = ((x + y) * 127) / (width + height);
      }
    }
    return sharp(raw, { raw: { width, height, channels: 3 } })
      .png()
      .toBuffer();
  }

  it("makes a big picture fit 2048 px, as a smaller WebP", async () => {
    const big = await poster(3000, 2000);
    const out = await screenPreview(big);
    const meta = await sharp(out ?? Buffer.alloc(0)).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["webp", SCREEN_PREVIEW_MAX, 1365]);
    expect(out?.length).toBeLessThan(big.length);
  });

  it("leaves a picture its WebP wouldn't make smaller", async () => {
    // A small WebP already: made again, it comes out no smaller.
    const small = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .webp({ quality: 80, effort: 2 })
      .toBuffer();
    expect(await screenPreview(small)).toBeNull();
  });

  it("leaves what it can't read", async () => {
    expect(await screenPreview(Buffer.from("not an image"))).toBeNull();
  });
});
