#!/bin/bash
# Sign a built Growth Factory.app with a Developer ID certificate and the hardened runtime, then
# notarize and staple it when App Store Connect API key details are set. See docs/releasing.md.
#
#   GF_MAC_SIGN_IDENTITY  "Developer ID Application: Name (TEAMID)", in an unlocked keychain (required)
#   GF_NOTARY_KEY         path to an App Store Connect API key (.p8)  } all three to notarize;
#   GF_NOTARY_KEY_ID      the key's id                                } without them the app is
#   GF_NOTARY_ISSUER      the key's issuer id                         } signed but not notarized
set -euo pipefail
APP="${1:?usage: sign-mac-app.sh path/to/Growth Factory.app}"
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
ENTITLEMENTS="$ROOT/packaging/macos/entitlements.plist"
: "${GF_MAC_SIGN_IDENTITY:?GF_MAC_SIGN_IDENTITY must name a Developer ID Application identity}"
[[ -d "$APP/Contents" ]] || { echo "Not an app bundle: $APP" >&2; exit 1; }

sign() {
  codesign --force --timestamp --options runtime --entitlements "$ENTITLEMENTS" \
    --sign "$GF_MAC_SIGN_IDENTITY" "$1"
}

# Inside out, as Apple requires: every Mach-O file, then nested frameworks deepest first, then the app.
while IFS= read -r -d '' path; do
  if file -b "$path" | grep -q 'Mach-O'; then sign "$path"; fi
done < <(find "$APP/Contents" -type f -print0)
while IFS= read -r framework; do
  sign "$framework"
done < <(find "$APP/Contents" -type d -name '*.framework' | awk -F/ '{ print NF "\t" $0 }' | sort -rn | cut -f2-)
sign "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

if [[ -z "${GF_NOTARY_KEY:-}" || -z "${GF_NOTARY_KEY_ID:-}" || -z "${GF_NOTARY_ISSUER:-}" ]]; then
  echo "Signed with \"$GF_MAC_SIGN_IDENTITY\"; not notarized (no notarization key set)."
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
# notarytool takes a zip; the ticket is then stapled to the app itself, which is zipped again later.
ditto -c -k --sequesterRsrc --keepParent "$APP" "$work/notarize.zip"
notary=(--key "$GF_NOTARY_KEY" --key-id "$GF_NOTARY_KEY_ID" --issuer "$GF_NOTARY_ISSUER")
xcrun notarytool submit "$work/notarize.zip" "${notary[@]}" --wait --timeout 1h --output-format json \
  | tee "$work/result.json"
echo
if ! grep -Eq '"status" *: *"Accepted"' "$work/result.json"; then
  submission="$(sed -nE 's/.*"id" *: *"([^"]+)".*/\1/p' "$work/result.json" | head -1)"
  echo "Notarization was not accepted. Apple's log follows." >&2
  [[ -n "$submission" ]] && xcrun notarytool log "$submission" "${notary[@]}" >&2 || true
  exit 1
fi
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
# Gatekeeper's own verdict, as a downloaded copy would get it.
spctl --assess --type execute --verbose=4 "$APP"
echo "Signed with \"$GF_MAC_SIGN_IDENTITY\", notarized and stapled."
