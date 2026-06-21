---
name: release
description: Release the rockDemo extension to the VS Code Marketplace by bumping the version and pushing a tag, the right way. Use when the user asks to "release", "publish", "cut a release", "ship a new version", or "publish to the Marketplace". Suggests the correct next version, manages stable vs pre-release channels (even/odd minor), checks for an open/merged PR, and drives the tag-based publish + verification.
---

# Release rockDemo to the Marketplace

Standardize cutting a release. Publishing is **tag-driven**: pushing a `vX.Y.Z`
tag fires [.github/workflows/release.yml](../../../.github/workflows/release.yml),
which verifies the tag, runs `vsce publish`, and creates a GitHub Release. Full
reference: [BUILD.md](../../../BUILD.md).

> A release publishes to the Marketplace — it is **outward-facing and a version
> number is burned forever**. Confirm the version and channel with the user
> before pushing the tag.

## The channel rule (critical)

The Marketplace accepts only `major.minor.patch` (no `-alpha` suffix). Channel is
chosen automatically by the workflow from the **minor number's parity**:

- **even minor** (`0.0.x`, `0.2.x`, `1.0.x`) → **stable** (everyone).
- **odd minor** (`0.1.x`, `1.1.x`) → **pre-release** (`--pre-release`).

A version can be published once, to one channel. The line moves forward only:
`0.0.2` (stable) → `0.1.0` (pre) → `0.1.1` (pre) → `0.2.0` (stable).

## Preconditions to verify (in order — STOP on any failure)

1. **`gh auth status`** is authenticated.
2. **`VSCE_PAT` secret exists**: `gh secret list` should list `VSCE_PAT`. If
   missing, STOP — publishing will 401. Point the user to BUILD.md to create it.
3. **A PR landed**: releases should ship reviewed code. Check recent history:
   ```bash
   gh pr list --state merged --base main --limit 5
   git log --oneline -10
   ```
   If the changes being released never went through a PR (e.g. work sitting on a
   branch, or direct commits), STOP and tell the user to open one first (the
   `open-pr` skill). Only proceed past this if the user explicitly insists.
4. **Clean checkout on `main`, synced**:
   ```bash
   git checkout main && git pull --prune
   git status --short        # must be clean
   ```
   If there's an open PR not yet merged that the user wants in this release, STOP
   and have them merge it first (`gh pr merge --squash --delete-branch`).

## Suggest the next version

1. Read the current version: `node -p "require('./package.json').version"`.
2. Find the latest tag for context: `git tag --sort=-v:refname | head -5`.
3. **Recommend** the next version, and state the channel it implies. Decide the
   bump from the nature of the changes since the last release
   (`git log <lastTag>..HEAD --oneline`):
   - bug fixes / docs / small tweaks → **patch** (stays on the current channel).
   - new feature you want to trial → step onto an **odd minor** (pre-release),
     e.g. `0.0.x` → `0.1.0`.
   - promoting a proven pre-release line to stable → next **even minor**,
     e.g. `0.1.x` → `0.2.0`.
   Always tell the user: "This will publish **<version>** to the **<stable|
   pre-release>** channel." Get a yes before continuing.

## Cut the release

Bump on `main` so `package.json` and the tag always match (the workflow's guard
rejects a mismatch). `npm version` edits `package.json`, commits, and tags:

```bash
# pick exactly one form, matching the agreed version:
npm version patch                 # e.g. 0.0.2 -> 0.0.3
npm version minor                 # e.g. 0.0.3 -> 0.1.0
npm version <explicit>            # e.g. npm version 0.2.0

git push origin main --follow-tags   # pushes the commit AND the new tag
```

## Verify

```bash
gh run watch --exit-status              # follow the Release run to completion
```
Then confirm and report links:
- `npx @vscode/vsce show RockOps.rockdemo` (once indexed)
- Marketplace: https://marketplace.visualstudio.com/items?itemName=RockOps.rockdemo
- Release: the `gh run` output / repo Releases tab.

If the run fails:
- **"Verify tag matches package.json version"** → the tag and `package.json`
  disagree; never hand-create tags, always use `npm version`.
- **401 at publish** → `VSCE_PAT` missing/expired/wrong scope (Marketplace →
  Manage, All organizations).

## Notes / do-not

- **Never run `vsce publish` by hand.** Always publish through the tag so the
  build is reproducible and recorded as a GitHub Release.
- **Never re-tag or re-publish an existing version** — move forward instead.
- Don't push the tag until the user has confirmed the version and channel.
