---
name: release
description: Release the rockDemo extension to the VS Code Marketplace by merging the current dev/x.y.z branch into main, pushing a release tag vX.Y.Z, and setting up the next dev/x.y.z branch for local dev. Use when the user asks to "make a release", "release", "publish", "cut a release", or "ship a new version".
---

# Release rockDemo to the Marketplace

Standardize cutting a release and managing the dedicated development branch (`dev/x.y.z`) lifecycle.

## The Dedicated Dev Branch Workflow (`dev/x.y.z`)

- **Rule**: All development work for version `x.y.z` takes place on a dedicated branch named `dev/x.y.z` (e.g., `dev/1.2.10`).
- **Never push directly to `main`**: All code reaches `main` exclusively through PR squash-merges.

## Automated "Make a Release" Flow

When the user asks to **"make a release"**, execute this complete end-to-end flow:

### 1. Commit and Sync Current Dev Branch
- Confirm current version `VER` from `package.json` (e.g. `1.2.10`).
- Ensure active branch is `dev/VER` (e.g. `dev/1.2.10`).
- If there are pending working tree changes, stage and commit them:
  ```bash
  git add -A
  git commit -m "feat: <summary of changes>"
  ```
- Push current dev branch to origin:
  ```bash
  git push -u origin dev/1.2.10
  ```

### 2. Create Pull Request and Merge to `main`
- Open a PR into `main`:
  ```bash
  gh pr create --base main --head dev/1.2.10 --title "release: v1.2.10" --body "Release version 1.2.10"
  ```
- Wait for status checks to complete:
  ```bash
  gh pr checks
  ```
- Squash-merge the PR into `main` and delete remote branch:
  ```bash
  gh pr merge --squash --delete-branch
  ```

### 3. Tag and Publish
- Switch to `main` and pull latest commit:
  ```bash
  git checkout main && git pull --prune
  ```
- Create and push tag `v1.2.10`:
  ```bash
  git tag v1.2.10
  git push origin v1.2.10
  ```
  *(Pushing `vX.Y.Z` tag triggers `.github/workflows/release.yml` to publish to VS Code Marketplace).*

### 4. Verify Release Build
- Watch the release workflow execution:
  ```bash
  gh run watch --exit-status
  ```

### 5. Prepare Next Dev Branch (`dev/x.y.(z+1)`)
- Determine next version `NEXT_VER` (e.g., `1.2.11`).
- Create and switch to new dev branch:
  ```bash
  git checkout -b dev/1.2.11
  ```
- Update `package.json` version without auto-tagging:
  ```bash
  npm version 1.2.11 --no-git-tag-version
  ```
- Commit version bump and push branch to origin:
  ```bash
  git add package.json
  git commit -m "chore: prepare dev/1.2.11 for next development cycle"
  git push -u origin dev/1.2.11
  ```
- Leave workspace checked out on `dev/1.2.11`.
