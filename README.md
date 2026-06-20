# rockDemo

A VS Code extension that turns [Killercoda](https://killercoda.com)-style
markdown scenarios into live, clickable demos. It scans fenced code blocks in
any open markdown file and renders **CodeLens buttons** directly above each
actionable block, so you can drive a live demo without copy-pasting commands by
hand.

## What it does

rockDemo parses fenced code blocks whose **closing** fence carries an
annotation — `{{exec}}`, `{{copy}}`, or `{{open}}` — and adds buttons above the
block:

| Annotation | Buttons shown | Behaviour |
| --- | --- | --- |
| `{{exec}}` | **▶ Run in terminal** + **📋 Copy** | Sends the command to the active terminal and presses Enter |
| `{{copy}}` | **📋 Copy** | Copies the command to the clipboard (does *not* run it) |
| `{{open}}` | **📂 Open file** | Opens the referenced file, path resolved relative to the scenario |

As in Killercoda, **`bash` / `sh` / `shell` blocks are runnable by default** —
they get the `exec` buttons even without an explicit `{{exec}}` annotation.

### Two modes

- **Edit mode** — work on the raw markdown; CodeLens buttons sit above each
  actionable block (great while authoring a scenario).
- **Demo / preview mode** — click the **▶ Run demo** button in the editor
  title bar (next to VS Code's own preview button, shown for any markdown
  file). This opens a dedicated **Webview** beside the editor that renders the
  markdown like a normal preview, **hides the meta fences** (` ```bash ` etc.),
  and replaces each actionable block with clickable buttons. The panel
  auto-refreshes as you edit or save the source file.

  > rockDemo uses its own webview rather than VS Code's built-in markdown
  > preview on purpose: the built-in preview renders content as *untrusted*,
  > which disables `command:` links and offers no message channel back to the
  > extension — so it can't run terminal commands. A self-owned webview can.

- **▶ Run in terminal** reuses the active terminal if one exists, otherwise
  creates a terminal named `rockDemo`. The command is typed *and* executed
  (a trailing newline is sent).
- **📋 Copy** writes the command to the system clipboard and shows a
  confirmation notification.
- **📂 Open file** opens the referenced file in the editor. In a scenario, if
  the path is **container-absolute** (e.g. `/var/killercoda/solution/first.txt`)
  and falls under a mounted asset, rockDemo opens the **host copy** bind-mounted
  there — so what you edit is live inside the container. Otherwise the path is
  treated as relative to the scenario/step file's folder.

## Scenario mode (JSON-driven, Docker-backed)

A full scenario is described by an `index.json` (Killercoda-style). Open it and
click **▶ Run demo** in the title bar to launch the **scenario player**:

1. An **intro screen** shows the scenario `title` and `description` with a
   **START** button at the bottom. If `details.intro.text` is set, that
   markdown file is rendered into the intro (via the demo player, so its
   `{{exec}}`/`{{copy}}`/`{{open}}` buttons work).
2. On open, rockDemo starts an interactive shell in a Docker container for each
   node — effectively `docker run -it --rm <imageid> sh`. **Docker is a
   prerequisite.** `{{exec}}` commands run *inside* the active node's container.
   - With a single `backend.imageid`, one terminal named `rockDemo` is opened.
   - With `backendExtended.nodes`, **one terminal per node** is opened, each
     named after its node key (e.g. `node1`, `node2`). `backendExtended` takes
     precedence over `backend` when present.
3. Clicking **START** walks through `details.steps` in order. Each step's
   markdown (`text` file) is rendered with the same demo player (hidden meta
   fences, clickable buttons), and gets navigation at the bottom:
   - **PREV** — except on the first step,
   - **NEXT** — on every step but the last,
   - **FINISH** — on the last step (instead of NEXT).
4. If `details.finish.text` is present, FINISH shows that final screen;
   otherwise it reports completion.
5. The finish screen has a **RESTART** button: it disposes **all** node
   container shells (their `--rm` containers are removed), relaunches every one
   from scratch, and jumps back to step 1 — a clean start. Closing the player
   also tears down all of its container shells.

The player auto-rebuilds when you save the `index.json` or any step markdown.

### `index.json` shape

```json
{
  "title": "Découverte de kubectl",
  "description": "Mes premiers pas avec kubectl",
  "details": {
    "steps": [
      { "title": "Premieres commandes", "text": "step1/step1.md" },
      { "title": "Création d'une ressource", "text": "step2/step2.md" }
    ],
    "assets": {
      "node1": [
        { "file": "solution*", "target": "/var/killercoda/solution", "chmod": "+w" }
      ]
    },
    "finish": { "text": "finish.md" }
  },
  "backend": { "imageid": "alpine" },
  "backendExtended": {
    "nodes": {
      "node1": { "imageid": "alpine" },
      "node2": { "imageid": "debian" }
    }
  }
}
```

- `title` / `description` — shown on the intro screen.
- `details.steps[].title` — step heading; `details.steps[].text` — markdown
  file (path relative to `index.json`) rendered as the step body.
- `details.finish.text` — optional closing screen.
- `backend.imageid` — Docker image for a single-container scenario.
- `backendExtended.nodes` — optional multi-container map; each key is a node
  name (used as the terminal name) with its own `imageid`. When present, this
  replaces `backend`.
- `details.intro.background` / `details.steps[].background` — optional. A shell
  command, or a script file (path relative to `index.json`, e.g.
  `background.sh`), run **detached and hidden** inside a node's container (via
  `docker exec`, so nothing shows in the terminal) when the screen is entered
  (intro on open; a step when you navigate to it — once per run). Requires
  `docker` on the extension host's PATH. stdout + stderr are captured to
  `/var/log/rockdemo/<scenario>/<step>_background.log` inside the container,
  where `<scenario>` is the scenario folder name and `<step>` is `intro` or the
  1-based step number.
- `details.intro.foreground` / `details.steps[].foreground` — optional. A
  **single-line command** sent verbatim to the node's terminal (Killercoda-style
  — the value is *not* read as a file; it's the command the container shell
  runs). It runs from `/scenario` (see below), **in the terminal**, so its
  output is visible and it **blocks** the terminal until it finishes. Fires once
  per run when the screen is entered. Reference scripts relative to the scenario
  folder, e.g. `./foreground.sh` or `sh foreground.sh`.

The **scenario folder is bind-mounted read-only at `/scenario`** in every
container, so scenario scripts are available to run (and `foreground` commands
`cd /scenario` first). Read-only keeps your host files safe.
- `details.steps[].verify` — optional. A command (resolved like `foreground`,
  from `/scenario` with `.` on PATH) that checks the step was completed. When
  present, the step shows a **VERIFY** button and **hides NEXT/FINISH until the
  command exits 0**. It runs hidden (via `docker exec`, nothing in the
  terminal); its output is captured to
  `/var/log/rockdemo/<scenario>/<step_number>_verify.log` inside the container.
  On failure the VERIFY button flashes red and a notification points to the log.
- `host` (sibling key on the intro/step) selects the target node by name for
  `background`, `foreground`, and `verify`; otherwise the first node is used (or
  the single `backend`).
- `details.assets` — optional. Each key is a **node name** (must match a node /
  `backend` host) and maps to a list of asset rules:
  - `file` — glob (relative to `index.json`; `*` supported in the last path
    segment) of host files/folders to stage.
  - `target` — destination path **inside the container**.
  - `chmod` — `"+w"` (read-write) or `"+r"` (read-only).

  Assets are **live-editable**. Rather than a one-shot `docker cp`, rockDemo
  copies the matched files into a per-run scratch dir
  (`<scenario>/.rockdemo-run/<node>/…`) and **bind-mounts that copy** into the
  container. So:
  - your **original files are never touched** (only the scratch copy is),
  - editing the staged files in VS Code is reflected live inside the container
    (and vice-versa for `+w`), and
  - `+r` is enforced as a **read-only mount** (`:ro`) — still editable from the
    host, just not writable by the container.

  The scratch dir is re-created fresh on every open/RESTART and **deleted when
  the demo ends** (stop/close). It's gitignored (`.rockdemo-run/`).

A working example lives in [scenarios/simple/index.json](scenarios/simple/index.json).

## Project layout

```
rockdemo/
├── package.json           # Extension manifest (commands, activation events)
├── src/extension.js       # All the logic: parser, CodeLens provider, commands
├── example/scenario.md    # A sample scenario to try the buttons on
├── .vscode/launch.json    # "Run rockDemo Extension" debug config (F5)
└── README.md
```

The implementation lives entirely in [src/extension.js](src/extension.js):

- `parseScenario(document)` — line-based parser that walks the markdown,
  tracking fence open/close and extracting `{ openLine, action, lang, content }`
  for each actionable block.
- `ScenarioCodeLensProvider` — turns those blocks into `vscode.CodeLens`
  buttons positioned on the opening fence line.
- `renderDemoBody()` / `demoHtml()` — a small zero-dependency markdown→HTML
  renderer used for demo mode. It drops non-actionable fences, turns actionable
  blocks into `<button>`s, and serves the HTML inside a CSP-locked webview.
- `openDemoPanel()` — creates/reveals the demo webview beside the editor and
  relays button clicks back to the shared action handlers via `postMessage`.
- `activate()` — registers the CodeLens provider plus the commands
  `rockdemo.exec`, `rockdemo.copy`, `rockdemo.open`, and `rockdemo.preview`
  (the title-bar **▶ Run demo** button).

Both modes call the same `runExec` / `runCopy` / `runOpen` handlers, so edit
mode and demo mode can never drift apart.

## Requirements

- VS Code `^1.75.0`.
- **No dependencies, no build step.** The `vscode` module is provided by the
  host at runtime, so there is no `npm install` and nothing to compile — the
  extension runs straight from `src/extension.js`.

## How to test it in VS Code

The extension is run via VS Code's built-in **Extension Development Host** — a
second VS Code window that loads rockDemo from source.

1. **Open the folder** — `File → Open Folder…` and select the `rockdemo`
   folder (open the folder itself, not its parent).
2. **Launch the dev host** — press **F5**, or open the **Run and Debug** panel
   (`Ctrl/Cmd+Shift+D`) and choose **"Run rockDemo Extension"**, then click the
   green ▶. This config is defined in [.vscode/launch.json](.vscode/launch.json)
   and starts a new window titled **[Extension Development Host]** with rockDemo
   active.
3. **Open a scenario** — in the new window, open
   [example/scenario.md](example/scenario.md).
4. **Edit mode** — CodeLens links (**▶ Run in terminal / 📋 Copy /
   📂 Open file**) appear above each code block. Click them and watch:
   - **Step 1** (`bash`, no annotation) → runs in the terminal.
   - **Step 2** (`{{exec}}`) → runs in the terminal.
   - **Step 3** (`{{copy}}`) → copies only; check the clipboard.
   - **Step 4** (`{{open}}`) → tries to open `../hello/main.py` relative to the
     scenario (create that file, or change the path, to see it open).
5. **Demo mode** — click **▶ Run demo** in the editor title bar (top-right,
   next to the built-in preview icon). A "Demo: scenario.md" panel opens beside
   the editor with the markdown rendered, the ` ```bash ` fences hidden, and a
   button under each command. Click a button → it runs/copies/opens just like
   edit mode. Edit or save the source and the demo panel updates live.
6. **Scenario mode** — open [scenarios/simple/index.json](scenarios/simple/index.json)
   and click **▶ Run demo**. You'll see the intro (title + description +
   **START**), and a `rockDemo` terminal opens running
   `docker run -it --rm alpine sh` (needs Docker installed and running). Click
   **START** to step through the scenario with **PREV / NEXT / FINISH**; the
   `{{exec}}` buttons send their commands into the container shell.

### Iterating on changes

After editing [src/extension.js](src/extension.js), reload the Extension
Development Host to pick up the change: focus that window and run **Developer:
Reload Window** (`Ctrl/Cmd+R`), or stop and re-launch with F5. If CodeLens
buttons don't appear, confirm:

- the file language is **Markdown** (bottom-right status bar),
- CodeLens is enabled (`"editor.codeLens": true` in settings),
- the block has a recognised annotation or is a `bash`/`sh`/`shell` block, and
- the block body is non-empty (empty blocks are skipped).

## Scenario format

The annotation goes on the **closing** fence:

````markdown
```bash
echo "runs in the terminal by default"
```

```sh
explicit exec — gets ▶ Run + 📋 Copy
```{{exec}}

```bash
copy-only command (e.g. destructive/interactive)
```{{copy}}

```text
../path/to/file.py
```{{open}}
````

Notes:

- The `lang` after the opening fence only matters for the bash/sh/shell
  default-exec behaviour; any language works with an explicit annotation.
- `{{open}}` paths are resolved relative to the scenario file's directory.

## Roadmap / MVP scope

This is **step 1**: parse a scenario `.md` and put working buttons over the
actionable blocks. Planned next steps:

1. A Webview "presenter panel" with step-through navigation.
2. Simulated editor-typing for a more polished live-demo feel.
