// Tag the document with the host OS so CSS can gate macOS-only window chrome
// (the Overlay title bar's traffic-light insets) without leaking that padding
// onto Windows/Linux, which keep native decorations.

export type PlatformClass = "platform-macos" | "platform-windows" | "platform-linux";

/**
 * Map an OS identifier to its document class. Accepts either a Tauri os name
 * (`macos`/`windows`/`linux`) or a raw `navigator.userAgent`/`platform` string.
 * Anything unrecognized falls back to `platform-linux` (native chrome), which
 * is the safe default for non-mac hosts.
 */
export function platformClass(os: string): PlatformClass {
  const s = os.toLowerCase();
  if (s.includes("mac") || s.includes("darwin") || s.includes("iphone")) {
    return "platform-macos";
  }
  if (s.includes("win")) {
    return "platform-windows";
  }
  return "platform-linux";
}

/** Add the resolved `platform-*` class to <html> at boot. */
export function tagPlatform(doc: Document = document, nav: Navigator = navigator): PlatformClass {
  const source = nav.userAgent || nav.platform || "";
  const cls = platformClass(source);
  doc.documentElement.classList.add(cls);
  return cls;
}

/**
 * Native popup selects are reliable in WKWebView on macOS. WebView2 and
 * WebKitGTK have shipped popup regressions where the list opens but cannot be
 * selected, so Windows/Linux use the in-webview accessible menu fallback.
 */
export function supportsNativeSelectPopup(doc: Document = document): boolean {
  return doc.documentElement.classList.contains("platform-macos");
}
