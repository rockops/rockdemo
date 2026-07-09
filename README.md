# rockDemo

Run **[Killercoda](https://killercoda.com)-style** markdown scenarios as live,
clickable demos **inside VS Code**. Instead of copy-pasting commands during a
demo, rockDemo renders **Run / Copy** buttons above your code blocks and can drive
a full multi-step scenario in real Docker containers — you just click through it.

> **Killercoda-compatible.** Scenarios you already wrote for Killercoda (an
> `index.json` plus step markdown with `{{exec}}` / `{{copy}}` / `{{open}}`
> annotations) run in rockDemo unchanged. Scenario authoring syntax is documented
> by Killercoda: **https://killercoda.com/creators**.

---

## Prerequisites

- **VS Code** 1.75 or newer.
- **Docker**, installed and **running**, on your `PATH` — required for scenario
  mode (the containers that back each step). Check with `docker ps`.
- **Windows: use WSL2.** Docker-backed scenarios need a Linux container host.
  Install Docker Desktop with **WSL integration** enabled (or Docker inside your
  WSL distro), open your project in VS Code via **WSL** (`Remote - WSL`), and run
  rockDemo from there so it talks to the Linux Docker daemon.

> Plain single-file markdown demos (just the Run/Copy buttons) work without
> Docker. Docker is only needed for the JSON **scenario player**.

---

## Run a scenario (the main use case)

A scenario is a folder containing an **`index.json`** (Killercoda format) and its
step markdown files.

1. **Open the scenario's `index.json`** in VS Code.
2. Click the **▶ Run demo** button in the **editor title bar** (top-right, next to
   VS Code's own preview button). This opens the **scenario player**.
3. The player shows an **intro screen** (title + description) with a **START**
   button. rockDemo has already launched a Docker container for each node in the
   background; **START** stays disabled until the environment is ready, then
   lights up.
4. Click **START** and step through the scenario:
   - **▶ Run** on a code block sends that command into the node's terminal and
     runs it. **📋 Copy** copies it. **📂 Open** opens a referenced file.
   - **NEXT / PREV** move between steps (**NEXT** may be gated until a step's
     check passes). **FINISH** ends the last step.
5. On the **end screen**:
   - **⟲ RESTART** — tear everything down and start clean from the intro.
   - **✖ CLOSE** — end the scenario (stops and removes the containers).
   - **🗑 CLOSE & CLEAR CACHE** — end *and* wipe the image cache (see below).

**Stop any time** with the **⏹ Stop** button in the title bar.

### Presenting: DEMO mode & font size

The player has a small control cluster pinned to the **top-right** on every
screen:

- **A− / A+** — resize the player *and* terminal fonts together for readability.
- **🖥 DEMO MODE** — toggle **projection mode**: a light, high-contrast look with
  larger fonts, forced on the player, the node terminals, **and the editor**
  (it temporarily switches VS Code to your **`workbench.preferredLightColorTheme`**
  so files opened via an **Open** button read well too). It also **collapses the
  file-explorer side bar and the bottom panel**, so all that's left on screen is
  the scenario and its terminals — ideal for a projector or shared screen. Click
  again (**🖥 EXIT DEMO MODE**) to return to your normal look.

Both settings persist across **RESTART** and reloads. Exiting DEMO mode — or
stopping the scenario — restores your original color theme, terminal colors, and
font size, and re-reveals the side bar and panels.

### Panel Restoration Settings

By default, exiting DEMO mode or closing the scenario re-reveals all three UI panels (the File Explorer Sidebar, the bottom Terminal panel, and the Agent Panel / Auxiliary Bar). If you prefer some of these panels to remain hidden when exiting, you can customize this in your VS Code settings under `rockDemo`:

* `rockdemo.restoreSidebar` (default `true`): Restore the primary sidebar (Explorer) when exiting demo mode or ending a scenario.
* `rockdemo.restorePanel` (default `true`): Restore the bottom panel (Terminal) when exiting demo mode or ending a scenario.
* `rockdemo.restoreAgentPanel` (default `true`): Restore the agent panel (Auxiliary Bar/Secondary Sidebar) when exiting demo mode or ending a scenario.

### Extra terminals on a node

Need a second shell on a node — e.g. to tail logs while you type commands in the
first? While a scenario is running you can open more terminals attached to any
node's container:

- **Terminal panel `+` dropdown** → **rockDemo: Node Shell**, or
- **Command Palette** → **rockDemo: New terminal on node**.

With a single node the terminal opens on it immediately; with several, you pick
which node. Each opens a fresh shell on the running container using that node's
configured shell (falling back to `sh`), and closes automatically when the
scenario ends.

### Terminal placement

By default node terminals open in the **editor area, to the right of the
instructions** — the scenario stays visible in its own column, and each node
gets its own pane. A node's **`split`** controls how its pane is placed:
`"right"` (or `true`) puts it **beside** the previous node, `"down"` **stacks it
below** — so you can build side-by-side or grid layouts. The layout reverts
automatically when the scenario ends.

### Try it

The repo ships runnable examples — open one and click **▶ Run demo**:

- [scenarios/simple/index.json](scenarios/simple/index.json) — a minimal scenario.
- [scenario-examples/](scenario-examples/) — a gallery covering assets, multi-node
  Kubernetes, step verification, and more.

---

## Run a single markdown file (no Docker)

Open any markdown file with fenced code blocks. rockDemo adds **Run / Copy**
buttons (CodeLens) above the actionable ones — great while writing or giving a
quick walkthrough. Click **▶ Run demo** in the title bar to see the rendered,
button-driven preview. `bash` / `sh` / `shell` blocks are runnable by default;
add `{{exec}}`, `{{copy}}`, or `{{open}}` on a block's closing fence to control
the buttons (Killercoda syntax).

---

## Authoring scenarios

rockDemo follows the Killercoda scenario format, so the authoring guide lives
there: **https://killercoda.com/creators**. In short, a scenario folder has an
`index.json` describing the environment (`backend` / nodes) and an ordered list of
steps (`details.steps`), each pointing at a markdown file. Annotate commands in
that markdown with `{{exec}}` (run), `{{copy}}`, or `{{open}}`.

### Multi-node environments (`backendExtended`)

Killercoda scenarios select an environment with a single `backend.imageid`.
rockDemo adds an optional **`backendExtended`** block for richer, multi-container
setups — an ordered list of nodes, each with its own image, shell (`cmd`), static
IP, Docker-in-Docker, systemd, startup scripts, and terminal layout (stacked tabs
or a side-by-side split via `layout` / per-node `split`):

```jsonc
"backendExtended": {
  "layout": "split",                 // "stacked" (default) | "split"
  "nodes": [
    { "name": "controlplane", "imageid": "…", "cmd": "bash", "ip": "172.30.1.2" },
    { "name": "node01",       "imageid": "…", "cmd": "bash", "ip": "172.30.1.3" }
  ]
}
```

> **⚠️ Not Killercoda-compatible.** `backendExtended` is a **rockDemo-only**
> extension — Killercoda does not understand it and will ignore it, so a scenario
> that depends on it won't reproduce the same environment there. If you need your
> scenario to run on Killercoda too, stick to `backend.imageid`; reach for
> `backendExtended` when you specifically want rockDemo's multi-node features.

The full node schema (all fields, networking, layout, backend startup scripts)
is in the **[technical reference](REFERENCE.md)**.

For rockDemo-specific behavior and the exact `index.json` fields it supports
(backends, multi-node networking, assets, step gating, traffic links), see the
**[technical reference (REFERENCE.md)](REFERENCE.md)**.

---

## Image cache (fast restarts)

Bringing up a container environment — especially a Kubernetes cluster — means
pulling container images, which is the slow part of starting a demo. rockDemo
keeps a **persistent image cache** so you only pay that cost once:

- The **first** run of a backend pulls its images from the network.
- **Every run after that** (including **RESTART**) starts from the warm cache — no
  re-pull. A normal **Stop** keeps the cache on purpose.

The cache is per-backend, so different scenarios that use the same environment
share it automatically.

### Clearing the cache

Clearing is always deliberate — do it to reclaim disk or force a fresh pull:

- **Command Palette** → **rockDemo: Clear image cache** (removes all cached
  images not currently in use, and reports how much was freed).
- **End screen** → **🗑 CLOSE & CLEAR CACHE** (ends the scenario, then clears).
- **Stop dropdown** (the `⋯` next to the title-bar Stop) → **Stop and clear image
  cache**.

> **Note:** the cache also preserves state created *inside* Docker/podman nodes
> (containers, volumes) between runs, so RESTART isn't a fully clean slate for
> those scenarios — clear the cache when you want a pristine start.

---

## Learn more

- **[REFERENCE.md](REFERENCE.md)** — full technical reference: annotations, the
  `index.json` schema, backends, networking, assets, step gating, traffic links,
  bundled Docker images, and the cache internals.
- **[BUILD.md](BUILD.md)** — how rockDemo is built, versioned, and published.

## License

Apache-2.0. Bundles [highlight.js](https://highlightjs.org/) (BSD-3-Clause) for
syntax highlighting — see [media/LICENSE-highlight.js](media/LICENSE-highlight.js).
