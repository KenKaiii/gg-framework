// Stands in for @tauri-apps/api/core inside the live preview frame.
import { frameInvoke } from "./invoke";

export function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  return frameInvoke<T>(cmd, args);
}
export const convertFileSrc = (p: string): string => p;
export const transformCallback = (): number => 0;
export class Channel {
  onmessage: (m: unknown) => void = () => {};
}
export const isTauri = (): boolean => false;
