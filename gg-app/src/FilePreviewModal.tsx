import { useEffect, useState } from "react";
import { ArrowSquareOutIcon } from "@phosphor-icons/react";
import { openProjectPath, readPreviewFile, type PreviewFile } from "./agent";
import { Modal } from "./Modal";
import { Markdown } from "./Markdown";
import {
  autoPreviewEnabled,
  closeFilePreview,
  setAutoPreview,
  subscribeFilePreview,
} from "./file-preview";
import "./FilePreview.css";

type Loaded =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; file: PreviewFile; url?: string };

function base64Blob(data: string, mediaType: string): Blob {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mediaType });
}

function fileLabel(path: string): string {
  return (
    path
      .replace(/[?#].*$/, "")
      .split(/[\\/]/)
      .filter(Boolean)
      .pop() ?? path
  );
}

/**
 * Shows a generated document (Markdown, image, PDF, video) inside the app.
 * Mounted once at the app root; anything calls `openFilePreview(path)`.
 */
export function FilePreviewHost(): React.ReactElement | null {
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => subscribeFilePreview(setPath), []);
  return path ? <FilePreviewModal key={path} path={path} /> : null;
}

function FilePreviewModal({ path }: { path: string }): React.ReactElement {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [auto, setAuto] = useState(autoPreviewEnabled);

  useEffect(() => {
    let live = true;
    let url: string | undefined;
    readPreviewFile(path).then(
      (file) => {
        if (!live) return;
        // Video and PDF play from a blob URL: the webview can't read disk paths itself.
        if (file.data && (file.kind === "video" || file.kind === "pdf")) {
          url = URL.createObjectURL(base64Blob(file.data, file.mediaType));
        } else if (file.data) {
          url = `data:${file.mediaType};base64,${file.data}`;
        }
        setLoaded({ state: "ready", file, url });
      },
      (e: unknown) => {
        if (live)
          setLoaded({ state: "error", message: String(e instanceof Error ? e.message : e) });
      },
    );
    return () => {
      live = false;
      if (url?.startsWith("blob:")) URL.revokeObjectURL(url);
    };
  }, [path]);

  const title = loaded.state === "ready" ? loaded.file.name : fileLabel(path);
  const openExternally = (): void =>
    void openProjectPath(loaded.state === "ready" ? loaded.file.path : path);

  return (
    <Modal title={title} onClose={closeFilePreview} className="file-preview-modal">
      <div
        className="file-preview-body"
        data-kind={loaded.state === "ready" ? loaded.file.kind : undefined}
      >
        {loaded.state === "loading" && (
          <p className="file-preview-note" role="status">
            Loading {title}…
          </p>
        )}
        {loaded.state === "error" && (
          <p className="file-preview-note" role="alert">
            Couldn&apos;t preview this file: {loaded.message}
          </p>
        )}
        {loaded.state === "ready" && loaded.file.kind === "markdown" && (
          <div className="file-preview-markdown assistant-text">
            <Markdown>{loaded.file.text ?? ""}</Markdown>
          </div>
        )}
        {loaded.state === "ready" && loaded.file.kind === "image" && loaded.url && (
          <img className="file-preview-image" src={loaded.url} alt={loaded.file.name} />
        )}
        {loaded.state === "ready" && loaded.file.kind === "video" && loaded.url && (
          <video className="file-preview-video" src={loaded.url} controls autoPlay={false}>
            <track kind="captions" />
          </video>
        )}
        {loaded.state === "ready" && loaded.file.kind === "pdf" && loaded.url && (
          <iframe className="file-preview-pdf" src={loaded.url} title={loaded.file.name} />
        )}
      </div>
      <div className="file-preview-foot">
        <label className="file-preview-auto">
          <input
            type="checkbox"
            checked={auto}
            onChange={(e) => {
              setAuto(e.target.checked);
              setAutoPreview(e.target.checked);
            }}
          />
          Open new documents automatically
        </label>
        <button type="button" className="modal-btn" onClick={openExternally}>
          <ArrowSquareOutIcon size={14} aria-hidden /> Open in default app
        </button>
      </div>
    </Modal>
  );
}
