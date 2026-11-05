#!/usr/bin/env bash
# Deep-sign every Mach-O binary staged for the macOS bundle BEFORE `tauri build`
# seals + notarizes the app.
#
# Why: Tauri signs the app shell and the `externalBin` it knows about, but it
# does NOT sign arbitrary Mach-O files shipped under `bundle.resources`
# (our sidecar's native addons: sharp, libvips, onnxruntime, fsevents, and the
# staged Node runtime). Apple's notary service rejects any embedded Mach-O that
# lacks a Developer ID signature + secure timestamp + hardened runtime. Signing
# the source files here means Tauri copies the already-signed binaries into the
# bundle, and notarization passes.
#
# Non-macOS binaries also ride along in the bundle (Linux .so, Windows .node).
# Those are ELF/PE, not Mach-O, so the notary ignores them — and we skip them
# here via a `file` check (codesign would error on a non-Mach-O).
#
# Usage: sign-nested-macos.sh "<signing identity>" <dir> [<dir> ...]
set -euo pipefail

IDENTITY="${1:?signing identity required}"
shift
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTITLEMENTS="$HERE/../src-tauri/entitlements.plist"

if [ ! -f "$ENTITLEMENTS" ]; then
  echo "entitlements not found: $ENTITLEMENTS" >&2
  exit 1
fi

signed=0
skipped=0
for root in "$@"; do
  [ -e "$root" ] || continue
  while IFS= read -r f; do
    if file "$f" | grep -q "Mach-O"; then
      # Apple's timestamp server has brief outages ("The timestamp service is
      # not available"); retry with backoff rather than failing the release.
      attempt=1
      until codesign --force --timestamp --options runtime \
        --entitlements "$ENTITLEMENTS" \
        --sign "$IDENTITY" "$f"; do
        if [ "$attempt" -ge 5 ]; then
          echo "codesign failed after $attempt attempts: $f" >&2
          exit 1
        fi
        sleep $((attempt * 15))
        attempt=$((attempt + 1))
      done
      signed=$((signed + 1))
    else
      skipped=$((skipped + 1))
    fi
  done < <(find "$root" -type f)
done

echo "nested codesign: signed $signed Mach-O file(s), skipped $skipped non-Mach-O"
