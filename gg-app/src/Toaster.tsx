import { useEffect, useRef, useState } from "react";
import { Info, CheckCircle2, AlertTriangle, XCircle, X } from "lucide-react";
import { theme } from "./theme";
import { subscribeToasts, dismissToast, type Toast, type ToastTone } from "./toast";

// Must match the .toast-out animation duration in App.css.
const EXIT_MS = 260;

const TONE_COLOR: Record<ToastTone, string> = {
  info: theme.primary,
  success: theme.success,
  warning: theme.warning,
  error: theme.error,
};

const TONE_ICON: Record<ToastTone, React.ComponentType<{ size?: number }>> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

/**
 * Bottom-right toast stack. Each toast slides up + fades in on enter, and
 * slides down + fades out on exit. The rendered list lags the bus: when a toast
 * leaves the bus it's kept around (marked `leaving`) for the exit animation,
 * then dropped. Mounted once at the app root; driven by the toast bus.
 */
export function Toaster(): React.ReactElement {
  // Rendered list, each tagged with whether it's animating out.
  const [rendered, setRendered] = useState<(Toast & { leaving?: boolean })[]>([]);
  const timers = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    return subscribeToasts((busToasts) => {
      setRendered((prev) => {
        const busIds = new Set(busToasts.map((t) => t.id));
        // Mark any rendered toast no longer on the bus as leaving, and schedule
        // its removal after the exit animation.
        const next = prev.map((r) => {
          if (!busIds.has(r.id) && !r.leaving) {
            if (!timers.current.has(r.id)) {
              timers.current.set(
                r.id,
                setTimeout(() => {
                  timers.current.delete(r.id);
                  setRendered((cur) => cur.filter((c) => c.id !== r.id));
                }, EXIT_MS),
              );
            }
            return { ...r, leaving: true };
          }
          return r;
        });
        // Append toasts new on the bus that aren't rendered yet.
        const renderedIds = new Set(next.map((r) => r.id));
        for (const t of busToasts) {
          if (!renderedIds.has(t.id)) next.push(t);
        }
        return next;
      });
    });
  }, []);

  useEffect(() => {
    const map = timers.current;
    return () => {
      for (const id of map.values()) clearTimeout(id);
      map.clear();
    };
  }, []);

  return (
    <div className="toaster">
      {rendered.map((t) => {
        const color = TONE_COLOR[t.tone];
        const Icon = TONE_ICON[t.tone];
        return (
          <div key={t.id} className={`toast${t.leaving ? " leaving" : ""}`} role="status">
            <span
              className="toast-icon"
              style={{
                color,
                borderColor: `${color}55`,
                background: `${color}1a`,
                display: "inline-flex",
              }}
            >
              <Icon size={14} />
            </span>
            <span className="toast-msg">{t.message}</span>
            <button className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
