import { useFocusedAnimation, TICK_INTERVAL } from "../components/AnimationContext.js";

const BLINK_INTERVAL_MS = 600;

/**
 * Synchronized blink hook.
 *
 * All instances derive visibility from the same global animation clock,
 * so every blinking element toggles in unison.
 *
 * @returns `true` when the element should be visible, `false` when hidden.
 *          Always returns `true` when `enabled` is `false`.
 */
export function useBlink(enabled: boolean, intervalMs = BLINK_INTERVAL_MS): boolean {
  const { active: isActive, tick } = useFocusedAnimation(enabled);

  if (!isActive) return true;
  return Math.floor((tick * TICK_INTERVAL) / intervalMs) % 2 === 0;
}
