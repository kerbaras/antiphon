# Releasing Antiphon

Antiphon is self-hosted — there is no npm/crates publishing. A release is an
annotated git tag plus a `CHANGELOG.md` entry; deployments (W2-E) build from
tags, never from a moving branch.

## The single source of version

The root `VERSION` file (currently `0.1.0`). Workspace `package.json` /
`Cargo.toml` versions are internal wiring and are not bumped per release.

## When to bump

Pre-1.0, keep it simple:

- **minor** (`0.1.0 → 0.2.0`): new user-facing capability (a workstream or a
  wave of them: markers, EQ, exports…).
- **patch** (`0.1.0 → 0.1.1`): fixes/hardening only, safe to hot-swap on an
  existing deployment.
- **1.0.0**: when a stranger can self-host from the runbook and record a real
  performance without us in the room.

## How to cut a release

```sh
# 1. On an up-to-date main with CI green, set the new version:
$EDITOR VERSION            # e.g. 0.2.0
git commit -am "chore: bump VERSION to 0.2.0"

# 2. Preview the tag + changelog entry (writes nothing):
pnpm release --dry-run

# 3. Cut it — updates CHANGELOG.md, commits, creates annotated tag v0.2.0:
pnpm release

# 4. Review, then publish:
git show v0.2.0
git push origin HEAD v0.2.0
```

The changelog is generated from merge-commit subjects since the previous tag
(`git log --merges`). Merges in this repo are descriptive by convention —
`Merge feat/markers: song markers, bookmarks, per-song render (W2-B)` — so
they read as changelog lines directly. Keep writing merge subjects that way;
hand-edit the generated section before pushing if a line needs polish.

## Deploying a release

Build/deploy from the tag checkout (`git checkout v0.2.0`), so the running
version is always attributable to an exact tree. See the W2-E deployment
runbook once it lands.
