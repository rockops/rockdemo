# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

**rockDemo** is a VS Code extension that turns [Killercoda](https://killercoda.com)-style
markdown scenarios into live, clickable demos. It renders CodeLens buttons above
actionable fenced code blocks, and runs full multi-step, Docker-backed scenarios
described by an `index.json`. Published to the VS Code Marketplace as `RockOps.rockdemo`.

## Key facts before you start

- **No build step, no npm dependencies.** The `vscode` module is provided by the host
  at runtime. There is no `npm install`, nothing to compile — the extension runs
  straight from `src/extension.js`. The only third-party code is a *vendored* copy of
  highlight.js under `media/` (a static asset, not an npm package).
- **The whole implementation is one file: [src/extension.js](src/extension.js)** (~2600 lines).
  Parser, CodeLens provider, markdown renderer, Docker orchestration, and the scenario
  player webview all live here.
- **Docker is required** for scenario mode (not for plain CodeLens on markdown).
- Requires VS Code `^1.75.0`. Activates `onLanguage:markdown`.

## Running / testing

There is no test suite and no linter configured. You verify changes by running the
extension in VS Code's **Extension Development Host**:

- Press **F5** (or Run and Debug → "Run rockDemo Extension"). This is defined in
  [.vscode/launch.json](.vscode/launch.json) and opens a second VS Code window with
  rockDemo loaded from source, pre-opened on `scenarios/simple`.
- After editing `src/extension.js`, reload the dev-host window (`Ctrl/Cmd+R`) to pick
  up changes.
- Try edit/demo mode on [example/scenario.md](example/scenario.md); try scenario mode
  on [scenarios/simple/index.json](scenarios/simple/index.json) (needs Docker running).

Package a `.vsix` locally (same command CI runs; never publishes):
```bash
npx @vscode/vsce package
```

## Architecture (src/extension.js)

Read the file for detail; the notable pieces and how they fit together:

- **Parsing** — `parseScenario` / `parseAnnotation`: a line-based parser for actionable
  fenced blocks and their `{{exec}}` / `{{copy}}` / `{{open}}` annotations (plus the
  `interrupt` modifier). `bash`/`sh`/`shell` blocks are runnable by default.
- **Edit mode** — `ScenarioCodeLensProvider`: turns parsed blocks into `vscode.CodeLens`
  buttons above the markdown.
- **Demo/webview rendering** — `renderMarkdownToHtml` / `renderInline` / `inlineCodeHtml`
  / `codeBlockHtml`: a zero-dependency markdown renderer with an HTML-tag allow-list,
  blockquotes, relative-image rewriting to webview-safe URLs, and highlight.js
  integration. rockDemo uses its own webview (not VS Code's built-in preview) because
  the built-in preview renders content as untrusted, disabling `command:` links and the
  message channel needed to run terminal commands.
- **Backend resolution** — `resolveNodes` / `loadBackends` / `nodesFromMap`: turn a
  scenario's `backend.imageid` (a key into `config/backends.json`) or its explicit
  `backendExtended.nodes` list into the ordered set of containers to launch.
- **Container orchestration** — `startNodes` / `startNamedContainer` / `startDockerd` /
  `updateHosts`: launch per-node containers with hostname, static IP on the `rockdemo`
  Docker network (`172.30.0.0/16`), Docker-in-Docker for `"docker": true` nodes, and
  cross-node `/etc/hosts` wiring.
- **Step scripts & gating** — `runBackground` / `runForeground` / `runVerify` /
  `pollForegroundDone`: per-step background/foreground/verify execution and the NEXT/
  FINISH gating that depends on them.
- **Player lifecycle** — `scenarioHtml` / `restartScenario` / `cleanupStaleResources`:
  the scenario-player webview, RESTART (full teardown + relaunch), and label-based
  cleanup. Every container/volume/network is stamped `rockdemo=1`; cleanup only ever
  touches labelled resources — never an unscoped `docker prune`.

## Directory map

- `src/extension.js` — everything (see above).
- `config/backends.json` — bundled default backend profiles, keyed by the `imageid`
  used in `backend.imageid`. Each mimics a Killercoda named environment.
- `config/<backend>/*.sh` — backend startup scripts referenced by a node's
  `background`/`foreground` (path is relative to `config/`).
- `docker/<image>/Dockerfile` — custom images (e.g. `docker/ubuntu` →
  `ghcr.io/rockops/rockdemo/ubuntu:24.04`), published to GHCR by
  `.github/workflows/docker-image.yml`.
- `media/` — vendored highlight.js build + light/dark themes.
- `scenarios/` — full scenario examples used for dev/testing (`simple`, kubeadm clusters).
- `scenario-examples/` — a broad gallery of feature-demonstrating scenarios (assets,
  verification, traffic, images, IDE, etc.). Good references for the `index.json` schema.
- `example/scenario.md` — a single-file (non-Docker) CodeLens demo.

## Scenario schema

The `index.json` schema (nodes, `details.steps`, `assets` globbing, `{{TRAFFIC_…}}`
links, gating) is documented exhaustively in **[README.md](README.md)** — consult it
before changing parsing or orchestration behaviour, and keep it in sync when you do.

## Release / publish

The full process lives in **[BUILD.md](BUILD.md)**. Do not run `vsce publish` by hand.
The essentials:

- **A PR/push builds; a tag publishes.** CI (`ci.yml`) only packages the `.vsix`.
  The Release workflow (`release.yml`) publishes only when a `vX.Y.Z` tag is pushed,
  and fails if the tag doesn't equal `package.json`'s `version`.
- **Channel is chosen by minor-version parity**: even minor → stable, odd minor →
  pre-release. You never pass `--pre-release` yourself.
- `main` is always releasable; all work goes through a PR with green CI.
- Prefer the **`/open-pr`** and **`/release`** skills, which encode this workflow.
