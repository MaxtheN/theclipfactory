"""Report how desktop builds are signed, from their manifests, in the GitHub Actions job summary.

Appends a line per artifact to $GITHUB_STEP_SUMMARY (when set) and prints a workflow notice for any
artifact that is not signed for distribution, so an unsigned build is never mistaken for a release.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

DISTRIBUTABLE = {"developer_id_notarized", "authenticode_certificate", "authenticode_trusted_signing"}
DESCRIPTIONS = {
    "developer_id_notarized": "Developer ID signed, notarized and stapled",
    "developer_id": "Developer ID signed, **not notarized** (add the APPLE_API_KEY_* secrets)",
    "ad_hoc_verified": "ad-hoc signed only (add the MACOS_CERTIFICATE_* secrets)",
    "authenticode_certificate": "Authenticode signed with the imported certificate",
    "authenticode_trusted_signing": "Authenticode signed with Azure Trusted Signing",
}


def line(record: dict) -> tuple[str, str | None]:
    signing, platform = record.get("signing", "unverified"), record.get("platform", "")
    if signing == "unsigned":
        description = ("unsigned (Linux packages are not signed)" if platform == "Linux" else
                       "**unsigned** (add the WINDOWS_CERTIFICATE_* or AZURE_* secrets)")
    else:
        description = DESCRIPTIONS.get(signing, f"signature {signing}")
    summary = f"- `{record['artifact']}`: {description}"
    notice = None
    if signing not in DISTRIBUTABLE and platform != "Linux":
        notice = (f"::notice title=Not signed for release::{record['artifact']} is {signing}. "
                  "See docs/releasing.md before publishing it.")
    return summary, notice


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("manifests", nargs="+", type=Path)
    args = parser.parse_args()
    lines = ["### Signing", ""]
    for path in args.manifests:
        summary, notice = line(json.loads(path.read_text()))
        lines.append(summary)
        if notice:
            print(notice)
    text = "\n".join(lines) + "\n"
    destination = os.environ.get("GITHUB_STEP_SUMMARY")
    if destination:
        with open(destination, "a", encoding="utf-8") as summary_file:
            summary_file.write(text)
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
