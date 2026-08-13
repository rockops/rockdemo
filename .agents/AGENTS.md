# Workspace Guidelines & Rules (rockDemo)

## Dedicated Development Branch Workflow (`dev/x.y.z`)

1. **Always Work in `dev/x.y.z`**:
   - Active development work must always take place on a dedicated branch named `dev/x.y.z` (where `x.y.z` matches the current version in `package.json`, e.g., `dev/1.2.10`).
   - Never commit or push directly to `main`.

2. **Automated Release Workflow ("make a release")**:
   - When the user asks to "make a release", "release", or "publish":
     1. Stage and commit any pending changes on `dev/x.y.z`.
     2. Push `dev/x.y.z` to `origin` and open a PR into `main` (`gh pr create --base main`).
     3. Wait for CI checks (`gh pr checks`) and squash-merge into `main` (`gh pr merge --squash --delete-branch`).
     4. Switch to `main` (`git checkout main && git pull --prune`).
     5. Tag release `vX.Y.Z` (`git tag vX.Y.Z && git push origin vX.Y.Z`) to trigger the GitHub Actions publish workflow.
     6. Prepare next version `dev/x.y.(z+1)`: update `package.json` to `x.y.(z+1)`, create `dev/x.y.(z+1)` branch, commit version bump, push `dev/x.y.(z+1)`, and stay on `dev/x.y.(z+1)`.
