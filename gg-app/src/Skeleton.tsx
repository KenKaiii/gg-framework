import type { CSSProperties } from "react";

/**
 * A single shimmering placeholder block. Used to reserve the exact shape of
 * content that's still loading so the real thing crossfades in rather than
 * popping. Width/height/radius are inline so callers can match the element
 * they're standing in for; the sweep animation is shared CSS (`.skeleton`).
 */
export function Skeleton({
  width,
  height = 13,
  radius,
  className,
  style,
}: {
  width?: number | string;
  height?: number | string;
  /** Border radius override; defaults to the pill radius for label-like blocks. */
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}): React.ReactElement {
  return (
    <span
      className={className ? `skeleton ${className}` : "skeleton"}
      style={{
        width,
        height,
        ...(radius !== undefined ? { borderRadius: radius } : null),
        ...style,
      }}
      aria-hidden="true"
    />
  );
}

/**
 * Footer placeholder shown until the session has hydrated. The empty left
 * cluster preserves alignment for transient task/plan status; project context
 * now lives in the title bar.
 */
export function FooterSkeleton(): React.ReactElement {
  return (
    <>
      <span className="footer-left footer-reveal" />
      <span className="footer-right footer-reveal">
        <Skeleton width={84} />
        <Skeleton width={56} />
      </span>
    </>
  );
}

/**
 * A few staggered message-shaped rows shown while an existing session's
 * transcript is being fetched. Crossfades out to the real history.
 */
export function TranscriptSkeleton(): React.ReactElement {
  return (
    <div className="transcript-skeleton" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="skeleton-msg" style={{ animationDelay: `${i * 70}ms` }}>
          <Skeleton className="skeleton-dot" width={10} height={10} radius="50%" />
          <span className="skeleton-lines">
            <Skeleton width="62%" height={11} />
            <Skeleton width="90%" height={11} />
            <Skeleton width="44%" height={11} />
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Placeholder rows for the project / session list while discovery runs.
 */
export function ListSkeleton({ rows = 5 }: { rows?: number }): React.ReactElement {
  return (
    <div className="list-skeleton" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-item" style={{ animationDelay: `${i * 60}ms` }}>
          <Skeleton width="42%" height={13} />
          <Skeleton width="22%" height={11} />
        </div>
      ))}
    </div>
  );
}
