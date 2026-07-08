#!/usr/bin/env bash
# Antiphon release script — annotated tag + changelog. No registries, no
# publishing: Antiphon is self-hosted and deploys build from tags.
# Full flow: docs/releasing.md
#
# Usage:
#   scripts/release.sh [--dry-run]     (or: pnpm release [--dry-run])
#
# Reads the version from the root VERSION file, collects merge-commit
# subjects since the last v* tag into a new CHANGELOG.md section, commits
# the changelog, and creates annotated tag v<version>. Never pushes —
# review, then push branch + tag yourself.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

dry_run=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    *)
      echo "usage: scripts/release.sh [--dry-run]" >&2
      exit 2
      ;;
  esac
done

version=$(tr -d '[:space:]' <VERSION)
case "$version" in
  [0-9]*.[0-9]*.[0-9]*) ;;
  *)
    echo "release: VERSION must hold a semver version, got '$version'" >&2
    exit 1
    ;;
esac
tag="v$version"

if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  echo "release: tag $tag already exists — bump VERSION first" >&2
  exit 1
fi

# The changelog: merge-commit subjects since the last release. This repo's
# merges read like changelog lines already ("Merge feat/markers: song
# markers, bookmarks, per-song render (W2-B)") — drop the "Merge " prefix
# and use them verbatim. --first-parent keeps it to merges INTO this branch;
# back-merges of main into feature branches don't belong in a changelog.
last_tag=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
range="${last_tag:+$last_tag..}HEAD"
entries=$(git log --merges --first-parent --format='- %s' "$range" | sed 's/^- Merge /- /')
if [ -z "$entries" ]; then
  entries="- (no merge commits since ${last_tag:-repo start}; see \`git log $range\`)"
fi

section="## $tag — $(date +%Y-%m-%d)

$entries"

if $dry_run; then
  echo "release (dry-run): would tag $tag${last_tag:+ (previous: $last_tag)}"
  echo
  echo "CHANGELOG.md delta:"
  echo
  echo "$section"
  exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "release: working tree not clean — commit or stash first" >&2
  exit 1
fi

# Prepend the new section under the header, keeping earlier releases.
tmp=$(mktemp)
{
  echo "# Changelog"
  echo
  echo "$section"
  if [ -f CHANGELOG.md ]; then
    echo
    sed '/^# Changelog$/d' CHANGELOG.md | sed '/[^[:space:]]/,$!d'
  fi
} >"$tmp"
mv "$tmp" CHANGELOG.md

git add CHANGELOG.md
git commit -m "release: $tag"
git tag -a "$tag" -m "Antiphon $tag

$entries"

echo
echo "release: created $tag with updated CHANGELOG.md."
echo "Review (git show $tag), then publish with:"
echo "  git push origin HEAD $tag"
