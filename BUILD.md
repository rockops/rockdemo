# Build, Release & Publish

How rockDemo is built, versioned, and published to the VS Code Marketplace.

The whole process is driven by **two GitHub Actions workflows**:

| Workflow | File | Trigger | What it does |
| --- | --- | --- | --- |
| **CI** | [.github/workflows/ci.yml](.github/workflows/ci.yml) | every PR + push to `main` | **Builds the `.vsix` only** (build check + uploadable artifact). **Never publishes.** |
| **Release** | [.github/workflows/release.yml](.github/workflows/release.yml) | pushing a tag `vX.Y.Z` | Verifies the tag, **publishes to the Marketplace**, and creates a GitHub Release with the `.vsix` attached. |

> **The rule of thumb:** a **PR/push builds**, a **tag publishes**. Nothing reaches
> the Marketplace until a `vX.Y.Z` tag is pushed.

---

## When does the pipeline build vs. publish?

### Build only (no publish) — CI workflow
Runs automatically on:
- every **pull request** (any branch → `main`), and
- every **push to `main`** (e.g. right after a merge).

It runs `vsce package`, producing a `.vsix` that's attached to the run as an
artifact (Actions run → **Artifacts → vsix**). This proves the extension
packages cleanly. It does **not** touch the Marketplace and needs **no secrets**.

### Publish — Release workflow
Runs **only** when a tag matching `v*.*.*` is pushed. It:
1. checks out the tagged commit,
2. **verifies the tag equals `package.json`'s `version`** (fails otherwise — this
   catches "tagged `v0.0.3` but forgot to bump `package.json`"),
3. picks the channel from the **minor-version parity** (see below),
4. runs `vsce publish` using the `VSCE_PAT` secret, and
5. creates a **GitHub Release** with the built `.vsix` attached.

Requires the **`VSCE_PAT`** repository secret (Azure DevOps PAT, *Marketplace →
Manage* scope, *All accessible organizations*).

---

## Versioning: dev (pre-release) vs. stable

The VS Code Marketplace **only accepts `major.minor.patch`** — there is **no**
support for semver suffixes like `-alpha`/`-beta`. Pre-release builds use a
separate **pre-release channel** instead, selected by `vsce publish --pre-release`.

This repo follows Microsoft's recommended convention, applied automatically by
the Release workflow from the version's **minor number**:

| Minor number | Channel | Example | Who gets it |
| --- | --- | --- | --- |
| **even** | **stable** | `1.0.x`, `1.2.x`, `0.0.x` | everyone |
| **odd** | **pre-release** (`--pre-release`) | `1.1.x`, `1.3.x`, `0.1.x` | users who opt into pre-releases |

You don't pass any flag yourself — the workflow reads the parity and adds
`--pre-release` when the minor is odd.

> A given version number can be published **once**, to **one** channel. The
> even/odd scheme keeps the two channels in a single, non-colliding version line:
> `0.0.2` (stable) → `0.1.0` (pre-release) → `0.1.1` (pre-release) →
> `0.2.0` (stable) …

---

## The full release flow (commands)

### 1. Branch
Never commit features straight to `main`. Cut a branch:

```bash
git checkout main
git pull
git checkout -b feature/my-change
```

### 2. Work, then open a PR
```bash
git add -A
git commit -m "Describe the change"
git push -u origin feature/my-change
gh pr create --base main --fill
```
Opening the PR triggers **CI** → it **builds the `.vsix`** (no publish). Make sure
the `package` check is green before merging:
```bash
gh pr checks
```

### 3. Bump the version

Do the version bump on the branch (so it's reviewed in the PR), **or** on `main`
right after merging — pick one. `npm version` edits `package.json`, makes a
commit, **and creates the matching git tag**:

```bash
# Choose the bump that reflects the channel you want:
npm version patch    # 0.0.2 -> 0.0.3   (stable, since minor 0 is even)
npm version minor    # 0.0.3 -> 0.1.0   (pre-release, minor 1 is odd)
npm version 0.2.0    # explicit          (stable, minor 2 is even)
```

> ⚠️ If you bump on the branch, the tag `npm version` creates is **local**.
> Don't push it yet — push it only after the PR is merged (step 5), so the tag
> points at the commit that's actually on `main`.

### 4. Merge the PR
```bash
gh pr merge --squash --delete-branch
git checkout main
git pull
```

### 5. Tag → publish

If you bumped on `main` after merging, create the tag now; if you bumped on the
branch, the commit is on `main` after the squash merge and you just push the tag.

The reliable, always-correct sequence is to bump **on `main`** and push with the
tag in one go:

```bash
git checkout main
git pull
npm version patch                 # bumps package.json, commits, creates v0.0.3 tag
git push origin main --follow-tags   # pushes the commit AND the tag
```

Pushing the `vX.Y.Z` tag fires the **Release** workflow → it publishes to the
Marketplace and creates the GitHub Release.

### 6. Verify
```bash
gh run watch --exit-status                # follow the release run
npx @vscode/vsce show RockOps.rockdemo     # confirm the version once indexed
```
- Marketplace: https://marketplace.visualstudio.com/items?itemName=RockOps.rockdemo
- Releases: https://github.com/rockops/rockdemo/releases

---

## Recommended development practice

1. **`main` is always releasable.** All work goes through a PR; CI must be green.
2. **Ship pre-releases first.** For anything you want to try in the wild, cut a
   **pre-release** (odd minor, e.g. `0.1.0`). Testers who enabled pre-releases on
   the extension get it; everyone else stays on the last stable.
3. **Promote to stable.** Once a pre-release line is proven, release the next
   **even** minor (e.g. `0.2.0`) as the stable build.
4. **One version = one publish.** Never re-tag or re-publish an existing version;
   always move forward.
5. **Let the tag do the publishing.** Don't run `vsce publish` by hand from a
   laptop — push a tag so the build is reproducible and recorded.

### Example timeline

```
main: ──●──────●──────●──────●──────●──────────▶
        │      │      │      │      │
     v0.0.2  v0.1.0  v0.1.1  v0.1.2  v0.2.0
     stable  pre     pre     pre     stable
             └──────── testing ──────┘ promote
```

---

## Building a `.vsix` locally (optional)

To inspect or hand off a package without involving CI:

```bash
npx @vscode/vsce package          # -> rockdemo-<version>.vsix (gitignored)
```
Install it for a quick test:
```bash
code --install-extension rockdemo-<version>.vsix
# uninstall: code --uninstall-extension RockOps.rockdemo
```
This is the **same command CI runs**; it never publishes.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Release run fails at **"Verify tag matches package.json version"** | The tag (`vX.Y.Z`) doesn't match `package.json`'s `version`. Use `npm version` so they always match. |
| **`401`/auth error** at the publish step | `VSCE_PAT` is missing, expired, or scoped to a single org. Recreate it: *Marketplace → Manage* scope, **All accessible organizations**. |
| Release didn't run at all | The tag didn't match `v*.*.*`, or you pushed the commit without the tag. Push with `--follow-tags`. |
| Wrong channel (published stable instead of pre-release) | Check the minor's parity — odd = pre-release, even = stable. |
