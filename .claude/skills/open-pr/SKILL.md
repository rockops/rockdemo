---
name: open-pr
description: Open a pull request for the rockDemo extension from the current dev branch into main, the right way. Use when the user asks to "create a PR", "open a PR", "raise a PR", or "submit my changes for review". Handles branch checks, committing/pushing pending work, a clean PR title/body, and waiting for the CI build check.
---

# Open a Pull Request (rockDemo)

Standardize opening a PR from the **current working branch** into `main`. The CI
workflow ([.github/workflows/ci.yml](../../.github/workflows/ci.yml)) packages the
`.vsix` on every PR — it **builds only, never publishes**. See
[BUILD.md](../../BUILD.md) for the overall flow.

## Preconditions to verify (in order)

1. **Tooling**: `gh auth status` must show an authenticated account. If not, stop
   and tell the user to run `gh auth login` (it's interactive — do not attempt it
   yourself).
2. **Not on `main`**: run `git rev-parse --abbrev-ref HEAD`. If the branch is
   `main`, STOP and ask the user — they must be on a dev/feature branch. Do not
   create a branch silently unless they ask.
3. **Up to date with main**: optionally `git fetch origin main`. If the branch is
   far behind, mention it; don't force a rebase without asking.

## Steps

1. **Inspect the working tree**: `git status --short` and `git diff --stat`.
   - If there are uncommitted changes, summarize them and propose a commit. Group
     logically; write a clear message. Only commit after the user is on board (or
     if they already asked you to "create the PR" with obvious pending work —
     committing it is part of doing it right).
   - End commit messages with the required co-author trailer.
2. **Push the branch** with upstream tracking:
   ```bash
   git push -u origin "$(git rev-parse --abbrev-ref HEAD)"
   ```
3. **Write the PR**. Title = concise summary of the change. Body should cover:
   - **Summary** — what changed and why.
   - **Notable details / risks** — anything a reviewer should scrutinize.
   - Do NOT bump the version or mention publishing here — releasing is a separate
     step (see the `release` skill). A PR only needs to merge cleanly.
4. **Create it**:
   ```bash
   gh pr create --base main --head "$(git rev-parse --abbrev-ref HEAD)" \
     --title "<title>" --body "<body>"
   ```
   End the PR body with the Claude Code generated-with line.
5. **Report the CI status**. Give the user the PR URL, then check the build:
   ```bash
   gh pr checks
   ```
   If the `package` check is still running, say so; if it failed, surface the log
   and offer to fix. A green `package` check means the `.vsix` built cleanly.

## Notes / do-not

- **Never publish from this skill.** Opening a PR must not touch the Marketplace
  or push tags. Publishing happens only via the `release` skill (tag push).
- If a PR already exists for this branch, `gh pr create` will error — instead run
  `gh pr view --web` and tell the user it's already open.
- Keep `main` protected: never push commits directly to `main` here.
