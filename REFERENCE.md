# rockDemo — technical reference

> This is the **full technical reference**. If you just want to *use* the
> extension, start with the short guide in **[README.md](README.md)**.

A VS Code extension that turns [Killercoda](https://killercoda.com)-style
markdown scenarios into live, clickable demos. It renders **CodeLens buttons**
above actionable code blocks in any markdown file, and can run full multi-step,
**Docker-backed** scenarios from an `index.json` — so you can drive a live demo
without copy-pasting commands by hand.

## What it does

rockDemo parses fenced code blocks whose **closing** fence carries an
annotation — `{{exec}}`, `{{copy}}`, or `{{open}}` — and adds buttons above the
block:

| Annotation | Buttons shown | Behaviour |
| --- | --- | --- |
| `{{exec}}` | **▶ Run in terminal** + **📋 Copy** | Sends the command to the active terminal and presses Enter |
| `{{exec interrupt}}` | **▶ Run** + **📋 Copy** | Sends **Ctrl+C** to the terminal first, then runs the command |
| `{{copy}}` | **📋 Copy** | Copies the command to the clipboard (does *not* run it) |
| `{{open}}` | **📂 Open file** | Opens the referenced file, path resolved relative to the scenario |

As in Killercoda, **`bash` / `sh` / `shell` blocks are runnable by default** —
they get the `exec` buttons even without an explicit `{{exec}}` annotation.

### Inline code (single backticks)

Inside the demo/scenario webview, **inline `` `code` `` spans are copyable by
default** (Killercoda-style). A trailing `{{…}}` annotation overrides this:

| Markdown | Result |
| --- | --- |
| `` `cmd` `` | 📋 copy icon (default) |
| `` `cmd`{{}} `` | plain text, no icon (copy disabled) |
| `` `cmd`{{exec}} `` | ▶ run + 📋 copy icons |
| `` `cmd`{{exec interrupt}} `` | ▶ run (sends Ctrl+C first) + 📋 copy |
| `` `cmd`{{copy}} `` | 📋 copy icon |

### Markdown rendering

The webview uses a small zero-dependency markdown renderer that also supports:

- **HTML passthrough** — an allow-list of inline/block tags (`<br>`, `<kbd>`,
  `<img>`, `<div>`, `<table>`, `<details>`, headings, lists, etc.) is emitted
  verbatim instead of being escaped, so author HTML renders as intended.
- **Blockquotes** — lines starting with `>` render as `<blockquote>`.
- **Images** — both markdown `![alt](src)` and raw `<img src="…">` render. A
  **relative** `src` (e.g. `./logo.png`, `../assets/logo.png`) is resolved
  against the step/document folder and rewritten to a webview-safe URL so the
  local file loads inside the sandboxed webview; `http(s):`/`data:` URLs pass
  through unchanged.
- **Syntax highlighting** — fenced code blocks are syntax-coloured with a
  **vendored** copy of [highlight.js](https://highlightjs.org/) (see
  [Third-party notices](#third-party-notices)). The theme follows the editor's
  light/dark preference. A highlight spec on the info string
  (e.g. ` ```js {2,5-6} `) shades those lines.

### Two modes

- **Edit mode** — work on the raw markdown; CodeLens buttons sit above each
  actionable block (great while authoring a scenario).
- **Demo / preview mode** — click the **▶ Run demo** button in the editor
  title bar (next to VS Code's own preview button, shown for any markdown
  file). This opens a dedicated **Webview** that renders the markdown like a
  preview, **hides the meta fences** (` ```bash ` etc.), and replaces each
  actionable block with clickable buttons. The panel auto-refreshes as you edit
  or save the source file.

  > rockDemo uses its own webview rather than VS Code's built-in markdown
  > preview on purpose: the built-in preview renders content as *untrusted*,
  > which disables `command:` links and offers no message channel back to the
  > extension — so it can't run terminal commands. A self-owned webview can.

- **▶ Run in terminal** reuses the active terminal if one exists, otherwise
  creates a terminal named `rockDemo`. The command is typed *and* executed
  (a trailing newline is sent). In scenario mode it targets the active node's
  container shell instead.
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
   **START** button. If `details.intro.text` is set, that markdown file is
   rendered into the intro (with working `{{exec}}`/`{{copy}}`/`{{open}}`
   buttons).

A small control cluster is pinned to the top-right of the player on **every**
screen (it doesn't depend on the intro):

- **🖥 DEMO MODE** — toggles **projection mode** on/off at any time. In DEMO mode
  the player and the node terminals switch to a **projector-friendly look**: a
  forced light, high-contrast theme with larger fonts, regardless of your VS Code
  theme.
- **A− / A+** — adjust the font size of the player (and, in DEMO mode, the node
  terminals) in 2px steps.

These are purely visual; the terminal-styling overrides are temporary and are
reverted when you leave DEMO mode or close the scenario. Both the mode and the
chosen font size persist across **RESTART**.
2. On open, rockDemo starts an interactive shell in a Docker container for each
   node. **Docker is a prerequisite.** `{{exec}}` commands run *inside* the
   active node's container.
   - With a single `backend.imageid`, the image id is looked up in the bundled
     default profiles (see [Backends](#backends)).
   - With `backendExtended.nodes`, **one terminal per node** is opened, each
     named after its `name`. `backendExtended` takes precedence over
     `backend` when present.
3. Clicking **START** walks through `details.steps` in order. Each step's
   markdown is rendered with the demo player and gets navigation at the bottom
   (**PREV** / **NEXT**, or **FINISH** on the last step). NEXT/FINISH may be
   **gated** — see [Gating](#step-gating-verify--foreground).
4. If `details.finish.text` is present, the end screen shows that markdown;
   otherwise it reports completion.
5. The **end screen** always has two buttons:
   - **⟲ RESTART** (green) — tears down **all** node containers, relaunches
     every one from scratch, and rebuilds the player back at the **intro
     screen** (a fully clean start, with all gates reset).
   - **✖ CLOSE** (red) — ends the scenario and tears down all containers (like
     the **STOP** title-bar button).

The player auto-rebuilds when you save the `index.json` or any step markdown.

### `index.json` shape

```json
{
  "title": "Découverte de kubectl",
  "description": "Mes premiers pas avec kubectl",
  "details": {
    "intro": {
      "text": "intro.md",
      "background": "background.sh",
      "foreground": "foreground.sh",
      "host": "host2"
    },
    "steps": [
      {
        "title": "Premieres commandes",
        "text": "step1/step1.md",
        "background": "sh background.sh",
        "foreground": "sh foreground.sh",
        "verify": "step1/verify.sh",
        "host": "host1"
      },
      { "title": "Création d'une ressource", "text": "step2/step2.md", "host": "host2" }
    ],
    "assets": {
      "host1": [
        { "file": "solution/**", "target": "/var/killercoda/solution", "chmod": "+w" }
      ]
    },
    "finish": { "text": "finish.md" }
  },
  "backend": { "imageid": "ubuntu" },
  "backendExtended": {
    "nodes": [
      { "name": "host1", "imageid": "alpine", "cmd": "sh", "ip": "172.30.1.2" },
      { "name": "host2", "imageid": "ghcr.io/rockops/rockdemo/ubuntu:24.04", "cmd": "bash", "ip": "172.30.2.2", "docker": true }
    ]
  }
}
```

#### Top-level

- `title` / `description` — shown on the intro screen.
- `backend.imageid` — a **key** into the bundled default profiles
  (see [Backends](#backends)).
- `backendExtended.nodes` — explicit multi-container **ordered list**; **takes
  precedence** over `backend` when present. Each entry's `name` is the node name
  (used as the terminal name, container hostname, and `host:` selector). The list
  order defines the implicit positional aliases `host1`/`host01`, `host2`/
  `host02`, … (a legacy `{ name: {…} }` map is still accepted, but a map has no
  guaranteed order — prefer the list).

#### Per-node fields (both `backends.json` profiles and `backendExtended`)

| Field | Meaning |
| --- | --- |
| `imageid` | Docker image to run for this node. |
| `alias` | Optional. An alternate name a scenario may use to target this node — for `details.assets` keys and a step's `host`. Lets one scenario JSON run across backends whose real node names differ (e.g. alias `node1` → real node `controlplane`). |
| `cmd` | Shell/command to run in the container (e.g. `sh` for alpine, `bash` for ubuntu). Defaults to `sh`. |
| `ip` | Static IP on the `172.30.0.0/16` subnet. When any node sets one, all nodes join the shared `rockdemo` Docker network. |
| `docker` | `true` → run the container `--privileged` and start an in-container Docker daemon (Docker-in-Docker). |
| `background` | Optional. A **script file** (path relative to the extension's `config/` folder, e.g. `ubuntu/background.sh`) run **detached and hidden** in this node's container when the env starts. Output is captured to `/var/log/rockdemo/<scenario>/<node>_backend_background.log`. |
| `foreground` | Optional. A **script file** (path relative to `config/`, e.g. `ubuntu/startup.sh`) run **visibly** in this node's terminal when the env starts. It **blocks** the player: the intro **START** button stays disabled until every node's backend foreground finishes. |

The node name becomes the container **hostname** (visible in the shell prompt).

> **Backend scripts live under `config/<backend>/`** (e.g.
> [config/ubuntu/startup.sh](config/ubuntu/startup.sh)) and the `background` /
> `foreground` value is the file's path relative to `config/`. When a node
> references one, rockDemo mounts the bundled `config/` folder read-only into the
> container and runs the script **by path** — so there's nothing to copy and the
> scripts are version-controlled with the extension.
>
> Backend `background`/`foreground` run **once per launch** (and again on
> **RESTART**), on the intro screen — the moment the env comes up — so they're
> ideal for readiness waits (e.g. blocking START until the in-container Docker
> daemon is up). They compose with an intro `foreground`: START waits for both.

#### `details.steps[]` / `details.intro`

- `text` — markdown file (path relative to `index.json`) rendered as the body.
- `background` — optional. A shell command, or a script file (e.g.
  `background.sh`), run **detached and hidden** inside a node's container (via
  `docker exec`) when the screen is entered (once per run). stdout/stderr are
  captured to `/var/log/rockdemo/<scenario>/<step>_background.log` inside the
  container.
- `foreground` — optional. A **single-line command** sent verbatim to the
  node's terminal (Killercoda-style — *not* read as a file). It runs from
  `/scenario`, **in the terminal** (output visible), and **blocks** the terminal
  until it finishes. While it runs, **START/NEXT is disabled** for that screen and
  re-enabled once it completes. Reference scripts relative to the scenario folder,
  e.g. `./foreground.sh` or `sh foreground.sh`.
- `verify` — optional (steps only). A command (resolved like `foreground`) that
  checks the step was completed. The step shows a **✓ VERIFY** button and
  **hides NEXT/FINISH until the command exits 0**. It runs hidden; output is
  captured to `/var/log/rockdemo/<scenario>/<step>_verify.log`. On failure the
  VERIFY button flashes red and a notification points to the log.
- `host` — selects the target node by name for `background`/`foreground`/
  `verify`; otherwise the first node is used. If the named host doesn't exist,
  rockDemo warns naming the missing host.

> When a step has **both** `verify` and `foreground`, NEXT is hidden+disabled
> until verify passes **and** the foreground command finishes.

> **Non-executable scripts just work.** When a `background`/`foreground`/`verify`
> value invokes a script *file* by name — `verify.sh`, `./foreground.sh`, even
> with arguments (`verify.sh --flag`) — rockDemo runs an **executable copy** of
> it: the file is copied into the ephemeral `.rockdemo-run` scratch, `chmod +x`'d
> there, and bind-mounted back over its own `/scenario` path. So it runs via its
> shebang (any interpreter) without you needing to `chmod +x` it, and **your
> source file is never modified**. (A wrapped form like `sh foreground.sh` never
> needed this.) The copy is taken at launch, so editing such a script mid-run
> takes effect on the next **RESTART**.

The **scenario folder is bind-mounted read-only at `/scenario`** in every
container, so scenario scripts are available to run (and `foreground`/`verify`
run from there with `.` on `PATH`). Read-only keeps your host files safe.

#### `details.assets`

Each key is a **node name** (must match a node / `backend` host — a node's
`alias` works too) and maps to a list of asset rules:

- `file` — glob of host **files** to stage, resolved **relative to the
  scenario's `assets/` folder** (`<scenario>/assets/`). See globbing below.
- `target` — destination **directory** inside the container (a leading `~`
  expands to `/root`). A **wildcard** pattern places each file preserving its
  **full path relative to `assets/`** — so `app1/**` → `target/app1/...` (the
  matched prefix is kept, not stripped), nested folders recreated. A **literal
  single file** (no `*`) is placed by **basename** — `app1/readme.md` →
  `target/readme.md`.
- `chmod` — `"+w"` (read-write), `"+r"` (read-only mount), or `"+x"`
  (executable).

**Globbing.** A pattern always resolves to a set of **files** (never folders),
matched against the `assets/` tree — mirroring Killercoda:

- `*` matches any run of characters **within a single path segment** (never
  crosses `/`). As the **last** segment it selects the **files** in a folder
  (not the sub-folders); as an earlier segment it selects folders to descend
  into (e.g. `app*/…`).
- `**` matches **any number of path segments** (recursive, including zero) — the
  globstar. Use it to pull a folder's whole subtree (e.g. `app1/**`).
- Wildcards may appear in **any** segment, not just the last.

Each match keeps its **full path relative to `assets/`** under `target` — the
matched prefix is never stripped. Examples, against
[scenario-examples/upload-assets](scenario-examples/upload-assets) (root `assets/`):

| `file` pattern   | matches                                  | lands under `target` as            |
| ---------------- | ---------------------------------------- | ---------------------------------- |
| `conf.yaml`      | `assets/conf.yaml`                       | `conf.yaml` (basename)             |
| `app1/readme.md` | that one file                            | `readme.md` (basename, literal)    |
| `*`              | top-level **files** only (not folders)   | `conf.yaml`, `run.sh`              |
| `**`             | every file, recursively                  | `app1/config/app.json`, …          |
| `app1/**`        | every file under `app1/`                 | `app1/config/app.json`, …          |
| `**/*.json`      | every `.json` at any depth               | `app1/config/app.json`, …          |
| `app1/**/*.json` | every `.json` under `app1/`              | `app1/config/app.json`, …          |
| `app1/*/*.json`  | `.json` exactly one folder under `app1/` | `app1/config/app.json`, …          |
| `app*/**/*.*`    | files with an extension under any `app*` | `app1/readme.md`, `app2/cnf/cnf.json`, … |

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
the demo ends**. It's gitignored (`.rockdemo-run/`).

A working example lives in [scenarios/simple/index.json](https://github.com/rockops/rockdemo/blob/main/scenarios/simple/index.json).

### Network traffic (`{{TRAFFIC_…}}` links)

To link to a service running **inside** a node, scenario markdown can use a
Killercoda-style placeholder:

```markdown
[ACCESS NGINX]({{TRAFFIC_HOST1_80}})
```

`{{TRAFFIC_<host>_<port>}}` is rewritten to a working URL,
`http://<host-machine-hostname>:<port>`, where:

- **`TRAFFIC`** is the fixed prefix.
- **`<host>`** names the node — its real name, its `alias`, or an implicit
  positional name **`hostN`** / **`host0N`** (1-based, case-insensitive): for the
  first node `host1` = `HOST1` = `host01` all work.
- **`<port>`** is any port number.
- the hostname is the machine running rockDemo (the `hostname` command), since
  that's where the port is reachable — **not** the container's hostname.

rockDemo scans the scenario's markdown up front and publishes each referenced
port from that node with `docker run -p <port>:<port>`, so the URL reaches the
service. Notes:

- The **host port equals the placeholder port** (no remapping). If that port is
  already taken on the host — or two nodes request the same one — `docker run`
  fails loudly (by design).
- Ports are published at container launch, so **adding or changing a
  `{{TRAFFIC_…}}` port takes effect on the next RESTART**, not a live save.
- A token whose `<host>` doesn't match any node is left as-is.

## Backends

When a scenario uses `backend.imageid` (no `backendExtended`), the value is
treated as a **key** into the bundled default profiles in
[config/backends.json](config/backends.json). These profiles mimic Killercoda's
named environments so the same scenario JSON runs unchanged. Each profile has
the same shape as a `backendExtended` block:

```json
{
  "ubuntu": { "nodes": [
    { "name": "node1", "imageid": "ghcr.io/rockops/rockdemo/ubuntu:24.04", "ip": "172.30.1.2", "cmd": "bash", "docker": true,
      "background": "ubuntu/background.sh", "foreground": "ubuntu/startup.sh" }
  ] },
  "alpine": { "nodes": [ { "name": "node1", "imageid": "alpine", "ip": "172.30.1.2", "cmd": "sh" } ] }
}
```

`nodes` is an **ordered list** (the order sets the implicit `host1`/`host2` …
positional aliases). A multi-node profile such as `kubernetes-kubeadm-2nodes`
just lists more entries.

A profile node may also carry `background`/`foreground` **script files** that run
automatically when the env starts (see the per-node fields table above). The
value is a path under `config/` (here
[config/ubuntu/startup.sh](config/ubuntu/startup.sh) blocks **START** until the
in-container Docker daemon is ready).

- An **unknown key** warns and launches nothing — for anything not covered by a
  default profile, use `backendExtended`.
- `config/backends.json` is bundled in the extension; it is the *default*
  configuration. To customise, use `backendExtended` in your scenario.

### Networking & `/etc/hosts`

Killercoda gives nodes static IPs. When any node declares an `ip`, rockDemo:

1. creates (idempotently) a user-defined Docker network `rockdemo` on subnet
   `172.30.0.0/16`,
2. attaches every node to it with its pinned `--ip`, and
3. appends `<ip> <hostname>` lines for all nodes to each container's
   `/etc/hosts`, so nodes can resolve one another by name.

### Custom images

Killercoda's environments come with tooling pre-installed. rockDemo ships
Dockerfiles under [docker/](docker/) (one subfolder per image). The `ubuntu`
image ([docker/ubuntu/Dockerfile](docker/ubuntu/Dockerfile)) is `ubuntu:24.04`
plus `curl`, `wget`, `telnet`, `docker.io`, and `podman`, with `WORKDIR /root`.

The image is published to the **GitHub Container Registry** by
[.github/workflows/docker-image.yml](.github/workflows/docker-image.yml) as
`ghcr.io/rockops/rockdemo/ubuntu:24.04` (and `:latest`). The workflow runs on pushes to
`main` that touch `docker/ubuntu/**`, and can also be triggered manually from the
Actions tab. It authenticates with the built-in `GITHUB_TOKEN`, so there are no
secrets to configure. Docker pulls the public image automatically the first time
a scenario references it — teammates don't need to build anything.

To build it locally instead (tag must match the `imageid` in
`config/backends.json`):

```bash
docker build -t ghcr.io/rockops/rockdemo/ubuntu:24.04 docker/ubuntu
```

> The GHCR package must be **public** for an unauthenticated `docker pull` to
> work. After the first publish, set the package's visibility to public under the
> repo/org **Packages** settings (a one-time step).

### Docker-in-Docker

A node with `"docker": true` runs `--privileged` and rockDemo starts an
in-container `dockerd` for it, so the scenario can run `docker`/`podman` *inside*
the node. The daemon takes a few seconds to come up. Its storage roots
(`/var/lib/docker`, `/var/lib/containers`) are backed by the persistent cache
described in [Persistent image cache](#persistent-image-cache), so pulled images
survive a restart.

### Persistent image cache

Privileged nodes run a **nested container runtime** — a standalone containerd
(the kubeadm backends), a Docker daemon, or podman (the `docker: true` DinD
nodes). rockDemo backs each runtime's storage root with a **persistent named
volume** instead of an ephemeral one:

| Root | Runtime |
| --- | --- |
| `/var/lib/containerd` | standalone containerd (kubeadm) |
| `/var/lib/docker` | in-container Docker daemon (DinD) |
| `/var/lib/containers` | podman |

Each volume name is keyed by **(image, node, root)**, so the cache is tied to the
**backend**, not the scenario: every scenario using a given backend shares one
warm store, while a multi-node backend gets one cache **per node** (two daemons
must never share a data root). Backends built on different images never mix
caches, even if they name a node the same. It stays safe because the container
name (`rockdemo-<node>`) is a machine-wide mutex — only one container of a given
node runs at a time — so at most one daemon writes each cache volume.

The effect: the **first** run of a node pulls the runtime images from the network
into the cache; **subsequent** runs (and **RESTART**) start from that warm store
with no pulls. For kubeadm this is why the image doesn't bake the images in (no
~1.3 GB of tarballs); for DinD/podman scenarios, images you `docker pull` /
`podman pull` in one run are still there the next.

> **Note:** `/var/lib/docker` and `/var/lib/containers` hold a runtime's *whole*
> data root — images **and** any containers, volumes or networks it creates — so
> persisting them carries that in-container state across runs too. **RESTART no
> longer wipes it**; use a **clear cache** action (below) when you want a truly
> clean slate.

These cache volumes are labelled `rockdemo-cache=1` (not `rockdemo=1`), so the
startup stale-resource sweep never deletes them and a normal **STOP** keeps them
(that's the point — the next run stays warm). Clearing is always an **explicit**
action, available three ways:

- **Command Palette** → **rockDemo: Clear image cache** — removes all cache
  volumes not currently in use, and reports how many were freed.
- **End screen** → the **🗑 CLOSE & CLEAR CACHE** button — ends the scenario and
  then clears the cache (it must close first, because a running scenario's
  containers hold their volumes).
- **STOP dropdown** (the `⋯` overflow next to the title-bar STOP) → **rockDemo:
  Stop and clear image cache**.

Under the hood any of these run `docker volume rm` on the `rockdemo-cache`
volumes; a volume bound to a still-running scenario is skipped and reported.

### Safe cleanup

Every container, volume, and network rockDemo creates is stamped with the label
`rockdemo=1`. On activation it sweeps **only** labelled stale resources (e.g.
from a VS Code window that was force-closed mid-scenario), so an unclean exit
never leaves orphans — and unrelated Docker objects are never touched. rockDemo
never runs `docker volume prune` or any unscoped delete.

The one exception is the **persistent containerd image cache** (see
[Persistent image cache](#persistent-image-cache)): those volumes carry a
**separate** `rockdemo-cache=1` label precisely so the stale-resource sweep
leaves them alone and they survive across sessions.

## Step gating (verify / foreground)

The end-of-step navigation reacts to the step's scripts:

- **`verify`** → NEXT/FINISH is **hidden** behind a **VERIFY** button until the
  verify command exits 0.
- **`foreground`** → NEXT/START is **disabled** while the foreground command runs
  and re-enabled when it finishes. Completion is detected via a marker file the
  command touches when done.
- Both compose, as noted above.

On **RESTART** the webview HTML is rebuilt from scratch so all of these gates
reset to their initial state.

## Project layout

```
rockdemo/
├── package.json           # Extension manifest (commands, activation events)
├── src/extension.js       # All the logic — parser, CodeLens, webview, Docker
├── config/backends.json   # Bundled default backend profiles (image-id keys)
├── config/<backend>/*.sh  # Backend startup scripts (background/foreground)
├── docker/<image>/Dockerfile  # Custom images (e.g. docker/ubuntu)
├── media/                 # Vendored highlight.js + light/dark themes
├── scenarios/simple/      # A full scenario example (index.json + steps)
├── example/scenario.md    # A sample single-file scenario
├── .vscode/launch.json    # "Run rockDemo Extension" debug config (F5)
├── BUILD.md               # Release / publish process
├── README.md              # Short user-facing guide
└── REFERENCE.md           # This file — full technical reference
```

The implementation lives entirely in [src/extension.js](https://github.com/rockops/rockdemo/blob/main/src/extension.js).
Notable pieces:

- `parseScenario` / `parseAnnotation` — line-based parser for actionable fenced
  blocks and their `{{…}}` annotations (incl. the `interrupt` modifier).
- `ScenarioCodeLensProvider` — turns blocks into `vscode.CodeLens` buttons.
- `renderMarkdownToHtml` / `renderInline` / `inlineCodeHtml` / `codeBlockHtml` —
  the zero-dependency markdown renderer (HTML passthrough, blockquotes, inline
  code icons, highlight.js integration).
- `resolveNodes` / `loadBackends` / `nodesFromMap` — resolve a scenario's
  backend into the list of nodes to launch.
- `startNodes` / `startNamedContainer` / `startDockerd` / `updateHosts` — launch
  the per-node containers (hostname, static IP, network, DinD) and wire them up.
- `runBackground` / `runForeground` / `runVerify` / `pollForegroundDone` — the
  per-step script execution and gating.
- `scenarioHtml` / `restartScenario` / `cleanupStaleResources` — the scenario
  player webview, restart, and safe label-based cleanup.

## Requirements

- VS Code `^1.75.0`.
- **Docker** on the extension host's PATH (for scenario mode).
- **No npm dependencies, no build step.** The `vscode` module is provided by the
  host at runtime, so there is no `npm install` and nothing to compile — the
  extension runs straight from `src/extension.js`. The only third-party code is a
  **vendored** copy of [highlight.js](https://highlightjs.org/) in
  [media/](media/) (a static asset, not an npm dependency).

## Third-party notices

This extension bundles [highlight.js](https://github.com/highlightjs/highlight.js)
(the common-languages browser build) under [media/](media/) for syntax
highlighting. highlight.js is distributed under the BSD-3-Clause license; its full
license text is kept alongside it at
[media/LICENSE-highlight.js](media/LICENSE-highlight.js).

## How to test it in VS Code

The extension is run via VS Code's built-in **Extension Development Host** — a
second VS Code window that loads rockDemo from source.

1. **Open the folder** — `File → Open Folder…` and select the `rockdemo`
   folder (open the folder itself, not its parent).
2. **Launch the dev host** — press **F5**, or open the **Run and Debug** panel
   (`Ctrl/Cmd+Shift+D`) and choose **"Run rockDemo Extension"**, then click the
   green ▶. This config is defined in [.vscode/launch.json](https://github.com/rockops/rockdemo/blob/main/.vscode/launch.json)
   and starts a new window titled **[Extension Development Host]** with rockDemo
   active.
3. **Edit / Demo mode** — open [example/scenario.md](https://github.com/rockops/rockdemo/blob/main/example/scenario.md).
   CodeLens links appear above each code block (edit mode); click **▶ Run demo**
   in the title bar to open the demo webview.
4. **Scenario mode** — open [scenarios/simple/index.json](https://github.com/rockops/rockdemo/blob/main/scenarios/simple/index.json)
   and click **▶ Run demo**. You'll see the intro (title + description +
   **START**), and a terminal per node opens running its container (needs Docker
   installed and running). Click **START** to step through with **PREV / NEXT /
   FINISH**; `{{exec}}` buttons send their commands into the active node's shell.

### Iterating on changes

After editing [src/extension.js](https://github.com/rockops/rockdemo/blob/main/src/extension.js), reload the Extension
Development Host to pick up the change: focus that window and run **Developer:
Reload Window** (`Ctrl/Cmd+R`), or stop and re-launch with F5. If CodeLens
buttons don't appear, confirm:

- the file language is **Markdown** (bottom-right status bar),
- CodeLens is enabled (`"editor.codeLens": true` in settings),
- the block has a recognised annotation or is a `bash`/`sh`/`shell` block, and
- the block body is non-empty (empty blocks are skipped).

## Building & releasing

Packaging the `.vsix` and publishing to the VS Code Marketplace (branches,
alpha/stable channels, tags, the GitHub Actions pipeline) is documented in
[BUILD.md](BUILD.md).

## Scenario format (single-file)

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
