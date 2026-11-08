import { useEffect, useId, useState } from "react";
import { getPoll, votePoll, type PollState } from "./agent";
import { toast } from "./toast";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const PRIVACY = "Your vote is anonymous.";

function closesLabel(closesAt: number, now: number): string {
  const left = closesAt - now;
  if (left < DAY_MS) return `closes in ${Math.max(1, Math.ceil(left / HOUR_MS))}h`;
  return `closes in ${Math.ceil(left / DAY_MS)}d`;
}

function percent(count: number, total: number): number {
  return total > 0 ? Math.round((count / total) * 100) : 0;
}

/**
 * Home's weekly feature poll, set by the owner on the gg-poll server: one
 * question on the What's new board, its answers as the board's rows. After a
 * vote each row fills to its share; picking another answer moves the vote
 * until the poll closes. With no open poll (or no network) it isn't shown.
 */
export function HomePoll(): React.ReactElement | null {
  const [state, setState] = useState<PollState | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  // Read out once a vote is saved; refetches on focus stay quiet.
  const [announce, setAnnounce] = useState("");
  // When the poll was last read, for "days left" (render stays pure).
  const [checkedAt, setCheckedAt] = useState(0);
  const titleId = useId();

  useEffect(() => {
    let live = true;
    const load = (): void =>
      void getPoll()
        .then((s) => {
          if (!live) return;
          setState(s);
          setCheckedAt(Date.now());
        })
        .catch(() => {});
    load();
    // Pick up a new week's poll, or votes from other windows, when Home is looked at again.
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.removeEventListener("focus", load);
    };
  }, []);

  const poll = state?.status === 200 ? state.poll : null;
  if (!state || !poll) return null;

  const voted = state.myChoice !== null;

  async function choose(choice: number): Promise<void> {
    if (!poll || pending !== null || choice === state?.myChoice) return;
    setPending(choice);
    try {
      const next = await votePoll(poll.id, choice);
      if (next.status === 200 && next.poll) {
        setState(next);
        const share = percent(next.counts[choice] ?? 0, next.total);
        setAnnounce(`Vote saved: ${poll.options[choice]}, ${share}% of ${next.total} votes.`);
      } else if (next.status === 409) {
        toast("This poll just closed.", "warning");
        setState(await getPoll());
      } else if (next.status === 0) {
        toast("Couldn't reach the poll. Try again in a moment.", "warning");
      } else {
        toast(`Couldn't save your vote: ${next.error ?? `HTTP ${next.status}`}.`, "warning");
      }
    } catch (e) {
      toast(`Couldn't save your vote: ${String(e)}`, "warning");
    } finally {
      setPending(null);
    }
  }

  const count = poll.options.length;
  return (
    <section
      className={`home-poll is-${count}${voted ? " is-voted" : ""}`}
      aria-labelledby={titleId}
    >
      <header className="home-poll-head">
        <h2 id={titleId} className="home-poll-title">
          Weekly poll
        </h2>
        <span className="home-poll-closes">
          {voted && `${state.total} ${state.total === 1 ? "vote" : "votes"} · `}
          {closesLabel(poll.closesAt, checkedAt)}
        </span>
      </header>
      <p className="home-poll-question">{poll.question}</p>
      <ul className="home-poll-options">
        {poll.options.map((option, i) => {
          const mine = state.myChoice === i;
          const share = percent(state.counts[i] ?? 0, state.total);
          return (
            <li key={option}>
              <button
                type="button"
                className={`home-poll-option${mine ? " is-mine" : ""}`}
                aria-pressed={mine}
                aria-busy={pending === i ? true : undefined}
                disabled={pending !== null && pending !== i}
                aria-label={voted ? `${option}, ${share}%${mine ? ", your pick" : ""}` : option}
                title={option}
                onClick={() => void choose(i)}
              >
                {voted && (
                  <span
                    className="home-poll-bar"
                    style={{ transform: `scaleX(${share / 100})` }}
                    aria-hidden="true"
                  />
                )}
                <span className="home-poll-label">{option}</span>
                {mine && (
                  <svg
                    className="home-poll-pick"
                    viewBox="0 0 7 6"
                    shapeRendering="crispEdges"
                    aria-hidden="true"
                  >
                    <path d="M6 0h1v2H6v1H5v1H4v1H3v1H2V5H1V4H0V2h1v1h1v1h1V3h1V2h1V1h1z" />
                  </svg>
                )}
                {voted && <span className="home-poll-pct">{`${share}%`}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="home-poll-foot">{PRIVACY}</p>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </section>
  );
}
