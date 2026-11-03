import path from "node:path";
import fs from "node:fs/promises";
import { shrinkToFit, validateVisionImage } from "../utils/image.js";

// ── Chat attachments (images / videos / files dropped into the input) ──────
// The webview sends base64 payloads; we persist each under .gg/uploads/ so the
// agent's tools can open files, then hand media to the model as native blocks.
export interface AppAttachment {
  kind: "image" | "video" | "file";
  name: string;
  mediaType: string;
  /** base64 (no data: prefix). */
  data: string;
}

interface PreparedAttachment extends AppAttachment {
  path?: string;
}

export async function prepareAttachments(
  cwd: string,
  attachments: AppAttachment[],
): Promise<PreparedAttachment[]> {
  const dir = path.join(cwd, ".gg", "uploads");
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const out: PreparedAttachment[] = [];
  for (const a of attachments) {
    // Sanitize the filename and prefix with a short timestamp to avoid clobber.
    const safe = a.name.replace(/[^\w.-]+/g, "_").slice(-80) || "file";
    const fileName = `${Date.now().toString(36)}-${safe}`;
    const filePath = path.join(dir, fileName);
    const buf = Buffer.from(a.data, "base64");
    // Validate and cap image attachments before they become native image content
    // blocks. Anthropic applies a 2000 px per-dimension cap once conversation
    // history contains more than 20 images, so every attachment must be safe for
    // later turns too. Keep the original on disk, but send the resized bytes.
    // Corrupt or unsupported images become plain files so they cannot reject the
    // entire provider request.
    let prepared: PreparedAttachment = { ...a };
    if (a.kind === "image") {
      try {
        const resized = await shrinkToFit(buf, a.mediaType);
        const validatedType = await validateVisionImage(resized.buffer);
        prepared = validatedType
          ? {
              ...a,
              mediaType: validatedType,
              data: resized.buffer.toString("base64"),
            }
          : { ...a, kind: "file" };
      } catch {
        prepared = { ...a, kind: "file" };
      }
    }
    try {
      await fs.writeFile(filePath, buf);
      out.push({ ...prepared, path: filePath });
    } catch {
      out.push({ ...prepared });
    }
  }
  return out;
}
