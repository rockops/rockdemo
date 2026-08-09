---
name: open-pr
description: Open a pull request for the rockDemo extension from the current dev/x.y.z branch into main, the right way. Use when the user asks to "create a PR", "open a PR", "raise a PR", or "submit my changes for review".
---

# Open a Pull Request (rockDemo)

Standardize opening a PR from the current dedicated development branch `dev/x.y.z` into `main`.

## Preconditions to verify

1. **`gh auth status`** must be authenticated.
2. **Dedicated Dev Branch (`dev/x.y.z`)**: Check current branch `git rev-parse --abbrev-ref HEAD`.
   - Never commit or push directly to `main`.
   - Development should occur on `dev/x.y.z` (e.g. `dev/1.2.10`).

## Steps

1. Inspect working tree (`git status --short`). Stage and commit pending changes if present.
2. Push branch with upstream tracking:
   ```bash
   git push -u origin "$(git rev-parse --abbrev-ref HEAD)"
   ```
3. Open PR into `main`:
   ```bash
   gh pr create --base main --head "$(git rev-parse --abbrev-ref HEAD)" --title "<title>" --body "<body>"
   ```
4. Check build checks status:
   ```bash
   gh pr checks
   ```
