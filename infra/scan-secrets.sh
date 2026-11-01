#!/usr/bin/env bash
# Secret scan before pushing: the full git history, plus every file git
# would commit right now (tracked + untracked-but-not-ignored). Ignored
# files such as your local .env are skipped on purpose: they never reach
# GitHub. Needs gitleaks (brew install gitleaks).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

echo "== history"
gitleaks git . --redact --no-banner

echo "== working tree (files git would commit)"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git ls-files -co --exclude-standard -z | while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  mkdir -p "$tmp/$(dirname "$f")"
  cp "$f" "$tmp/$f"
done
echo "$(find "$tmp" -type f | wc -l | tr -d ' ') files"
gitleaks dir "$tmp" --redact --no-banner
echo "== clean"
