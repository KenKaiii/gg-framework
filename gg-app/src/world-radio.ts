import { useCallback, useEffect, useMemo, useRef } from "react";
import { getRadioState, setRadio, setRadioVolume, type RadioState } from "./agent";

/**
 * World's jukebox plays the app's own radio (the same stations and the same player as the title-bar radio button, on
 * this computer only). The game asks with `radio-get` / `radio-set` / `radio-volume`; we answer with the app-wide
 * state `{ t: 'radio', stations, current, volume }` (station urls stay in the app).
 */
export function useWorldRadio(post: (msg: Record<string, unknown>) => void): {
  onGameMessage: (data: { t?: unknown; station?: unknown; volume?: unknown }) => boolean;
} {
  const postRef = useRef(post);
  useEffect(() => {
    postRef.current = post;
  }, [post]);
  const volumeTimer = useRef(0);

  const send = useCallback((state: RadioState): void => {
    postRef.current({
      t: "radio",
      stations: state.stations.map((s) => ({ id: s.id, name: s.name, description: s.description })),
      current: state.current,
      volume: state.volume,
    });
  }, []);
  const refresh = useCallback((): void => {
    void getRadioState().then(send);
  }, [send]);

  useEffect(() => () => window.clearTimeout(volumeTimer.current), []);

  const onGameMessage = useCallback(
    (data: { t?: unknown; station?: unknown; volume?: unknown }): boolean => {
      if (data.t === "radio-get") {
        refresh();
        return true;
      }
      if (data.t === "radio-set" && typeof data.station === "string" && data.station.length <= 80) {
        void setRadio(data.station)
          .catch(() => null)
          .finally(refresh);
        return true;
      }
      if (
        data.t === "radio-volume" &&
        typeof data.volume === "number" &&
        Number.isFinite(data.volume)
      ) {
        const v = Math.max(0, Math.min(100, Math.round(data.volume)));
        // dragging sends many: save the last one after a short pause
        window.clearTimeout(volumeTimer.current);
        volumeTimer.current = window.setTimeout(() => {
          void setRadioVolume(v)
            .catch(() => null)
            .finally(refresh);
        }, 150);
        return true;
      }
      return false;
    },
    [refresh],
  );
  return useMemo(() => ({ onGameMessage }), [onGameMessage]); // stable: the message listener isn't re-added per render
}
