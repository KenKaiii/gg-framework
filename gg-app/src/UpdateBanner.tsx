import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { UpdateInfo } from "./update";
import { KEY_ART_STYLE, PixelText, UpdateArrow, UpdateBurst, UpdateMeter } from "./UpdateKeyParts";
import { PCT_COLS } from "./update-key-art";
import "./UpdateBanner.css";

/**
 * The workspace's update bar, its own row under the footer: the same arcade
 * art as Home's update key, laid out as a strip. An indigo bar with a gold
 * pixel rim; UPDATE's pixels fly in beside a hopping arrow, then the versions
 * and a little INSTALL key that goes down when the bar is pressed. Installing
 * turns the bar into an XP meter with the builder running along it; at 100% it
 * reads UPDATED! and goes off in a burst of pixels. The slot stays mounted
 * from "available" through "installing", so the bar opens once and the swap
 * to the meter never replays it.
 */
export function UpdateBanner({
  appUpdate,
}: {
  appUpdate: Pick<UpdateInfo, "phase" | "version" | "progress" | "install">;
}): React.ReactElement | null {
  const { phase, version, progress } = appUpdate;
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void getVersion()
      .then((v) => {
        if (live) setCurrent(v);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (phase !== "available" && phase !== "installing") return null;
  const pct = Math.max(0, Math.min(100, Math.round(progress ?? 0)));
  const done = phase === "installing" && pct >= 100;
  const newest = version ?? "the latest version";

  return (
    <div className="update-banner-slot" style={KEY_ART_STYLE}>
      {phase === "available" ? (
        <button
          type="button"
          className="update-banner"
          aria-label={`Update to ${newest}. Installs and restarts the app.`}
          title={`Update to ${newest}`}
          onClick={() => void appUpdate.install()}
        >
          <span className="ub-row" aria-hidden="true">
            <UpdateArrow />
            <PixelText text="Update" cell={2} fly spread={50} />
            <span className="ub-versions">
              {current && (
                <>
                  <span>{`v${current}`}</span>
                  <span className="ub-versions-to">{"to"}</span>
                </>
              )}
              <span className="ub-versions-new">{`v${version ?? ""}`}</span>
            </span>
            <span className="ub-key">
              <span className="ub-key-base" />
              <span className="ub-key-face">
                <PixelText text="Install" cell={2} />
              </span>
            </span>
          </span>
        </button>
      ) : (
        // Same .update-banner box as the available state, so the swap to the
        // meter changes the contents, never the height.
        <div
          className={`update-banner update-banner-busy${done ? " is-done" : ""}`}
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={done ? "Update installed. Restarting." : "Downloading update"}
        >
          {done ? (
            <span className="ub-row" aria-hidden="true">
              <PixelText text="Updated!" cell={2} fly spread={30} />
            </span>
          ) : (
            <span className="ub-row" aria-hidden="true">
              <PixelText text="XP" cell={2} />
              <UpdateMeter pct={pct} />
              <PixelText text={`${pct}%`} cell={2} minCols={PCT_COLS} />
            </span>
          )}
          {done && <UpdateBurst flat />}
        </div>
      )}
    </div>
  );
}
