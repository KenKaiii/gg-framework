import type { KenFace } from "./goal-ken-talk";
import { formatMonthYear, type ShipLog } from "./about-ship-log";

export const SKOOL_URL = "https://skool.com/kenkai";
export const SOURCE_URL = "https://github.com/KenKaiii/gg-framework";
export const YOUTUBE_URL = "https://youtube.com/@kenkaidoesai";

/**
 * When GG Coder began: the repo's first commit, as the command-line tool. The
 * desktop app came later; its first release is the changelog's oldest entry.
 */
export const GG_CODER_STARTED = "2026-03-04";

/** One thing Ken says in his box, with the face he says it with. */
export interface KenSay {
  readonly face: KenFace;
  readonly text: string;
}

/**
 * What Ken says on the About page: a few plain sentences, each short enough to
 * fit his box's three lines.
 */
export function aboutLines(log: ShipLog): readonly KenSay[] {
  return [
    {
      face: "happy",
      text: "Hey, I'm Ken. I built GG Coder, the coding agent you're using right now.",
    },
    {
      face: "neutral",
      text: `It started as a command-line tool in ${formatMonthYear(GG_CODER_STARTED)}. This desktop app came along in ${formatMonthYear(log.firstDate)}.`,
    },
    {
      face: "thinking",
      text: "I keep improving it most weeks, and I show how I build things like this on YouTube.",
    },
    {
      face: "happy",
      text: "Want to learn to build with AI too? Come join me on Skool. Happy to help you get going.",
    },
  ];
}
