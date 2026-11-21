#!/bin/bash
# Attach build files to the draft GitHub release for a tag, creating the draft if needed.
# Never publishes, and never changes the files of a release that is already published.
# Needs gh with GH_TOKEN (contents: write) and GH_REPO.
set -euo pipefail
TAG="${1:?usage: attach-release-assets.sh TAG FILE...}"
shift
(( $# )) || { echo 'No files to attach.' >&2; exit 1; }
if ! gh release view "$TAG" > /dev/null 2>&1; then
  gh release create "$TAG" --draft --verify-tag --title "Growth Factory $TAG" \
    --notes "Draft built from $TAG. Publish only when every Mac and Windows manifest shows a signed build (docs/releasing.md)."
fi
if [[ "$(gh release view "$TAG" --json isDraft --jq .isDraft)" != true ]]; then
  echo "Release $TAG is already published; its files are left unchanged." >&2
  exit 1
fi
gh release upload "$TAG" "$@" --clobber
echo "Attached $# files to the draft release $TAG."
