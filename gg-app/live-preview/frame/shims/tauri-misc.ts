// No-op stand-ins for the Tauri window/event/plugin modules the shared components import.
const noopUnlisten = async () => () => {};
const fakeWindow = {
  label: "live-preview",
  listen: noopUnlisten,
  once: noopUnlisten,
  onFocusChanged: noopUnlisten,
  onResized: noopUnlisten,
  onMoved: noopUnlisten,
  onCloseRequested: noopUnlisten,
  onDragDropEvent: noopUnlisten,
  isFocused: async () => document.hasFocus(),
  isVisible: async () => true,
  isMinimized: async () => false,
  isMaximized: async () => false,
  isFullscreen: async () => false,
  scaleFactor: async () => window.devicePixelRatio,
  innerSize: async () => ({ width: innerWidth, height: innerHeight }),
  setTitle: async () => {},
  setFocus: async () => {},
  show: async () => {},
  hide: async () => {},
  close: async () => {},
  emit: async () => {},
  setSize: async () => {},
  setMinSize: async () => {},
  setPosition: async () => {},
  startDragging: async () => {},
};
export const listen = noopUnlisten;
export const once = noopUnlisten;
export const emit = async () => {};
export const emitTo = async () => {};
export const getCurrentWindow = () => fakeWindow;
export const getCurrentWebviewWindow = () => fakeWindow;
export const getCurrentWebview = () => fakeWindow;
export const getAllWindows = async () => [fakeWindow];
export const getAllWebviewWindows = async () => [fakeWindow];
export class WebviewWindow {
  static getByLabel = async () => null;
  constructor() {
    return fakeWindow as unknown as WebviewWindow;
  }
}
export class Window extends WebviewWindow {}
export class LogicalSize {
  constructor(
    public width: number,
    public height: number,
  ) {}
}
export class PhysicalSize extends LogicalSize {}
export class LogicalPosition {
  constructor(
    public x: number,
    public y: number,
  ) {}
}
export class PhysicalPosition extends LogicalPosition {}
export const getVersion = async () => "live-preview";
export const getName = async () => "GG Coder";
export const TauriEvent = {};
// plugin-log
const log =
  (level: string) =>
  async (...a: unknown[]) =>
    console.debug(`[gg ${level}]`, ...a);
export const error = log("error");
export const warn = log("warn");
export const info = log("info");
export const debug = log("debug");
export const trace = log("trace");
export const attachConsole = noopUnlisten;
// plugin-dialog / process / updater
export const open = async () => null;
export const save = async () => null;
export const message = async () => {};
export const ask = async () => false;
export const confirm = async () => false;
export const relaunch = async () => {};
export const exit = async () => {};
export const check = async () => null;
export default {};
