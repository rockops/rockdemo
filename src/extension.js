const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const execFile = require("util").promisify(require("child_process").execFile);

// Extension install location, set in activate(). Used to resolve vendored
// webview assets (media/) such as the bundled syntax highlighter.
let extensionUri = null;

/**
 * Parse the text inside a `{{ ... }}` annotation into an action + modifiers.
 * The annotation may carry a modifier after the action, e.g. `{{exec interrupt}}`.
 *
 *   undefined      -> no annotation present at all
 *   ""  ({{}})     -> present, but no action (explicitly disabled)
 *   "exec"         -> action "exec"
 *   "exec interrupt" -> action "exec", interrupt true
 *
 * @returns {{ present: boolean, action: string|undefined, interrupt: boolean }}
 */
function parseAnnotation(raw) {
  if (raw === undefined) return { present: false, action: undefined, interrupt: false };
  const parts = raw.trim().split(/\s+/).filter(Boolean);
  return { present: true, action: parts[0], interrupt: parts.includes("interrupt") };
}

/**
 * Parse a markdown document into a list of actionable scenario blocks.
 *
 * Recognises Killercoda-style fenced code blocks where the *closing* fence
 * carries an annotation, e.g.
 *
 *   ```bash
 *   npm run dev
 *   ```{{exec}}
 *
 * Supported annotations: {{exec}}, {{copy}}, {{open}}, plus the {{exec interrupt}}
 * modifier. As in Killercoda, bash/sh/shell blocks default to {{exec}} when no
 * explicit annotation is present.
 *
 * @returns {{ openLine: number, action: string, lang: string, content: string, interrupt: boolean }[]}
 */
function parseScenario(document) {
  const lines = document.getText().split(/\r?\n/);
  const blocks = [];

  let inFence = false;
  let openLine = 0;
  let lang = "";
  let content = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inFence) {
      const open = line.match(/^```(\w*)/);
      if (open) {
        inFence = true;
        openLine = i;
        lang = open[1].toLowerCase();
        content = [];
      }
      continue;
    }

    // We are inside a fence — look for the closing fence (+ optional annotation).
    const close = line.match(/^```\s*(?:\{\{([^}]*)\}\})?\s*$/);
    if (close) {
      inFence = false;

      const ann = parseAnnotation(close[1]);
      let action = ann.action; // exec | copy | open | undefined ({{}} disables)
      if (!ann.present && ["bash", "sh", "shell"].includes(lang)) {
        action = "exec";
      }

      const body = content.join("\n");
      if (action && body.trim().length > 0) {
        blocks.push({ openLine, action, lang, content: body, interrupt: ann.interrupt });
      }
      continue;
    }

    content.push(line);
  }

  return blocks;
}

// ---------------------------------------------------------------------------
// Shared action handlers — used by BOTH the CodeLens commands (edit mode) and
// the demo webview (preview mode), so behaviour stays identical.
// ---------------------------------------------------------------------------

// Ctrl+C as a control character — sent (without a newline) to interrupt a
// running foreground process before issuing the next command ({{exec interrupt}}).
const CTRL_C = "\x03"; // ETX (Ctrl+C)

/** Send Ctrl+C to interrupt whatever is running, then the command. */
function sendInterruptThen(term, cmd) {
  term.sendText(CTRL_C, false);
  term.sendText(cmd, true);
}

function runExec(cmd, opts) {
  const term =
    vscode.window.activeTerminal || vscode.window.createTerminal("rockDemo");
  term.show();
  if (opts && opts.interrupt) sendInterruptThen(term, cmd);
  // `true` appends a newline — i.e. types the command AND presses Enter.
  else term.sendText(cmd, true);
}

async function runCopy(cmd) {
  await vscode.env.clipboard.writeText(cmd);
  vscode.window.showInformationMessage("rockDemo: copied to clipboard");
}

/** Open a file resolved against an explicit *base directory* URI. */
async function runOpenBase(file, baseUri) {
  const base =
    baseUri ||
    (vscode.workspace.workspaceFolders &&
      vscode.workspace.workspaceFolders[0].uri);
  if (!base) {
    vscode.window.showErrorMessage(
      "rockDemo: no folder to resolve file against"
    );
    return;
  }
  try {
    const target = vscode.Uri.joinPath(base, file);
    const doc = await vscode.workspace.openTextDocument(target);
    await vscode.window.showTextDocument(doc);
  } catch (err) {
    vscode.window.showErrorMessage(`rockDemo: could not open ${file} (${err})`);
  }
}

/** CodeLens variant: resolve against the *scenario file's* directory. */
function runOpen(file, docUri) {
  return runOpenBase(file, docUri ? vscode.Uri.joinPath(docUri, "..") : null);
}

/** Open an absolute host filesystem path directly in the editor. */
async function openFsPath(fsPath) {
  try {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(fsPath));
    await vscode.window.showTextDocument(doc);
  } catch (err) {
    vscode.window.showErrorMessage(`rockDemo: could not open ${fsPath} (${err})`);
  }
}

/** Docker-safe container name derived from a node name. */
function containerNameFor(nodeName) {
  return "rockdemo-" + nodeName.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/**
 * Valid Docker hostname derived from a node name. Hostnames (unlike container
 * names) may not contain underscores, so disallowed characters become hyphens.
 */
function hostnameFor(nodeName) {
  return nodeName.replace(/[^a-zA-Z0-9.-]/g, "-");
}

// Static-IP network for inter-node communication. Killercoda-style nodes get
// fixed addresses on this subnet; `--ip` requires a user-defined network with a
// declared subnet, so we create one (idempotently) when any node has an `ip`.
const NET_NAME = "rockdemo";
const NET_SUBNET = "172.30.0.0/16";
// Label stamped on every container/volume/network rockDemo creates, so stale
// resources from a previous (e.g. force-closed) session can be swept safely at
// startup without touching unrelated Docker objects.
const ROCKDEMO_LABEL = "rockdemo=1";

/** Shell snippet that ensures the rockdemo network exists (idempotent). */
function ensureNetworkCmd() {
  return (
    `docker network inspect ${NET_NAME} >/dev/null 2>&1 || ` +
    `docker network create --label ${ROCKDEMO_LABEL} --subnet ${NET_SUBNET} ${NET_NAME} >/dev/null 2>&1; `
  );
}

/**
 * Start an interactive shell inside a named Docker container, in a terminal
 * named after the node. Docker is a prerequisite. `--name` lets us target the
 * container; `--rm` cleans up when the shell exits. `mounts` is a list of
 * docker `-v` values (e.g. "host/path:/container/path[:ro]") bind-mounting the
 * staged asset copies. `cmd` is the shell/command to run in the container
 * (defaults to `sh`). When `useNet` is set the container joins the rockdemo
 * network (so nodes can talk), with a static `--ip` if `ip` is given. When
 * `privileged` is set the container runs `--privileged` (needed for the
 * Docker-in-Docker daemon started later). Returns a record:
 * { name, terminal, containerName }.
 */
function startNamedContainer(name, imageid, mounts, cmd, ip, useNet, privileged) {
  const containerName = containerNameFor(name);
  const hostname = hostnameFor(name);
  const shell = cmd || "sh";
  const term = vscode.window.createTerminal(name);
  term.show();
  const vol = (mounts || [])
    .map((m) => `-v "${m.host}:${m.container}${m.ro ? ":ro" : ""}"`)
    .join(" ");
  // Join the shared network so nodes can reach each other; pin the static IP
  // when one is declared.
  const netEnsure = useNet ? ensureNetworkCmd() : "";
  const netArgs = useNet
    ? `--network ${NET_NAME} ${ip ? `--ip ${ip} ` : ""}`
    : "";
  // Nested container runtimes need --privileged, plus volumes for their storage
  // roots (/var/lib/docker for docker, /var/lib/containers for podman) so the
  // inner overlay sits on a real filesystem — stacking overlay-on-overlay
  // otherwise fails. The volumes are anonymous (auto-removed by --rm) but
  // labelled, so any orphans can be swept by label. `--cgroupns=host` lets
  // podman/conmon create cgroups in the full host hierarchy (avoids the
  // cgroup-v2 "no internal processes" warning).
  const priv = privileged
    ? `--privileged --cgroupns=host ` +
      `--mount type=volume,dst=/var/lib/docker,volume-label=${ROCKDEMO_LABEL} ` +
      `--mount type=volume,dst=/var/lib/containers,volume-label=${ROCKDEMO_LABEL} `
    : "";
  // Drop any stale container with this name first (e.g. after a hard restart),
  // then run a fresh one with the configured command (defaults to `sh`).
  // `--hostname` makes the node name show up in the shell prompt; `--label`
  // marks it for the startup sweep.
  term.sendText(
    (
      netEnsure +
      `docker rm -f ${containerName} >/dev/null 2>&1; ` +
      `docker run -it --rm --label ${ROCKDEMO_LABEL} --name ${containerName} --hostname ${hostname} ${priv}${netArgs}${vol} ${imageid} ${shell}`
    ).replace(/\s+/g, " "),
    true
  );
  // Once the container shell is ready it reads this and clears the screen,
  // hiding the docker command and any image-pull noise. It runs before the
  // foreground command (same terminal input buffer, FIFO order).
  term.sendText("clear", true);
  return { name, terminal: term, containerName, mounts: mounts || [] };
}

// Default backend profiles bundled with the extension (config/backends.json):
// a map of Killercoda-style `backend.imageid` keys -> a backendExtended-shaped
// { nodes: { name: { imageid } } }. Loaded once and cached.
let backendsCache = null;
function loadBackends() {
  if (backendsCache) return backendsCache;
  try {
    const p = path.join(extensionUri.fsPath, "config", "backends.json");
    backendsCache = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    backendsCache = {};
  }
  return backendsCache;
}

/** Turn a `{ name: { imageid, cmd, ip, docker } }` nodes map into a node list. */
function nodesFromMap(nodes) {
  return Object.keys(nodes).map((name) => ({
    name,
    imageid: nodes[name].imageid,
    cmd: nodes[name].cmd,
    ip: nodes[name].ip,
    docker: !!nodes[name].docker,
  }));
}

/**
 * Resolve a scenario's backend into a flat list of nodes to launch.
 * - `backendExtended.nodes` (when present) wins — each node becomes its own
 *   named terminal/container.
 * - Otherwise `backend.imageid` is treated as a *key* into the bundled default
 *   profiles (config/backends.json); the matching profile's nodes are used.
 * - An unknown key warns and launches nothing (custom backends must use
 *   `backendExtended`).
 */
function resolveNodes(scenario) {
  const ext = scenario.backendExtended;
  if (ext && ext.nodes) return nodesFromMap(ext.nodes);

  const key = scenario.backend && scenario.backend.imageid;
  if (key) {
    const backends = loadBackends();
    const profile = backends[key];
    if (profile && profile.nodes) return nodesFromMap(profile.nodes);
    vscode.window.showWarningMessage(
      `rockDemo: unknown backend "${key}" — not a default profile ` +
        `(${Object.keys(backends).join(", ") || "none"}). ` +
        `Define it in backendExtended for a custom backend.`
    );
  }
  return [];
}

/** Launch a container terminal for every node, storing the records on entry. */
function startNodes(entry) {
  // Fresh scratch copies for this run: wipe, then stage per node and mount.
  entry.bgDone = new Set(); // re-arm background scripts for this run
  entry.fgDone = new Set(); // re-arm foreground scripts for this run
  if (entry.baseFsPath) wipeRunDir(entry.baseFsPath);
  // If any node declares a static IP, every node joins the shared rockdemo
  // network so they can communicate (those with an `ip` get pinned addresses).
  const useNet = entry.nodes.some((n) => n.ip);
  entry.terminals = entry.nodes
    .filter((n) => n.imageid)
    .map((n) => {
      const mounts = entry.baseFsPath ? stageNodeAssets(entry, n) : [];
      // Mount the scenario folder read-only at /scenario so foreground commands
      // can find their scripts (they run from there). Read-only is important:
      // it keeps the host files safe from any container writes.
      if (entry.baseFsPath) {
        mounts.unshift({ host: entry.baseFsPath, container: "/scenario", ro: true });
      }
      return startNamedContainer(n.name, n.imageid, mounts, n.cmd, n.ip, useNet, n.docker);
    });
  // VS Code makes the most-recently-created terminal the active one, and that
  // selection is applied asynchronously — so a synchronous show() of the first
  // node loses the race. Defer it to the next tick to win and select node1.
  if (entry.terminals.length) {
    const first = entry.terminals[0];
    setTimeout(() => first.terminal.show(), 0);
  }
  // Once the containers are up, point every node's /etc/hosts at the others and
  // start the in-container Docker daemon for nodes that requested it.
  updateHosts(entry);
  startDockerd(entry);
}

/**
 * Start an in-container Docker daemon (Docker-in-Docker) for every node whose
 * config sets `"docker": true`. The node runs `--privileged` (see
 * startNamedContainer); here we launch `dockerd` detached via `docker exec -d`,
 * retrying until the container is up. Output goes to /var/log/dockerd.log
 * inside the container. The daemon takes a few seconds to accept connections.
 */
async function startDockerd(entry) {
  const dindNodes = (entry.nodes || []).filter((n) => n.docker);
  if (!dindNodes.length) return;
  for (const node of dindNodes) {
    const rec = (entry.terminals || []).find((r) => r.name === node.name);
    if (!rec) continue;
    for (let i = 0; i < 120; i++) {
      if (entry.disposed) return;
      try {
        await execFile("docker", [
          "exec",
          "-d",
          rec.containerName,
          "sh",
          "-c",
          "dockerd > /var/log/dockerd.log 2>&1",
        ]);
        break;
      } catch (err) {
        await delay(1000);
      }
    }
  }
}

/**
 * Append `<ip> <hostname>` for every IP'd node to each container's /etc/hosts,
 * so nodes can resolve one another by name. Runs hidden via `docker exec`,
 * retrying until each container is up (its terminal may still be pulling the
 * image). A node's own entry is already added by Docker; duplicating it is
 * harmless.
 */
async function updateHosts(entry) {
  const ipNodes = (entry.nodes || []).filter((n) => n.ip);
  if (!ipNodes.length) return;
  // Append one line per node, guarded so a re-run doesn't duplicate entries.
  const script =
    `grep -q "# rockdemo hosts" /etc/hosts 2>/dev/null || ` +
    `printf '%s\\n' "# rockdemo hosts" ${ipNodes
      .map((n) => `"${n.ip} ${hostnameFor(n.name)}"`)
      .join(" ")} >> /etc/hosts`;
  for (const rec of entry.terminals || []) {
    for (let i = 0; i < 120; i++) {
      if (entry.disposed) return;
      try {
        await execFile("docker", ["exec", rec.containerName, "sh", "-c", script]);
        break;
      } catch (err) {
        await delay(1000);
      }
    }
  }
}

/**
 * Dispose every terminal owned by a panel entry AND force-remove its container.
 * Killing the terminal alone doesn't reliably stop `docker run`, so the
 * container can linger — `docker rm -f` guarantees it's stopped and deleted.
 */
function disposeEntryTerminals(entry) {
  if (entry.terminals) {
    for (const rec of entry.terminals) {
      rec.terminal.dispose();
      if (rec.containerName) {
        execFile("docker", ["rm", "-f", "-v", rec.containerName]).catch(() => {
          /* already gone — ignore */
        });
      }
    }
  }
  entry.terminals = [];
  // Delete the staged asset copies — they're scratch, no post-mortem needed.
  if (entry.baseFsPath) wipeRunDir(entry.baseFsPath);
}

// ---------------------------------------------------------------------------
// Assets: stage a *copy* of host files into a gitignored scratch dir, then
// bind-mount that copy into the container. This keeps the originals untouched
// while letting the files be edited live from VS Code (host) and the container.
// ---------------------------------------------------------------------------

// The rockDemo webview panel (demo or scenario) currently focused, if any.
// Drives the title-bar Stop button for the markdown demo and rockdemo.stop.
let activeDemoPanel = null;

// The running scenario player, if any. Only one scenario may run at a time:
// while set, the `rockdemo.scenarioRunning` context key is true, which hides
// PLAY and shows STOP on every editor title bar regardless of focus.
let runningScenarioPanel = null;

function setScenarioRunning(panel) {
  runningScenarioPanel = panel;
  vscode.commands.executeCommand(
    "setContext",
    "rockdemo.scenarioRunning",
    !!panel
  );
}

/** Track a panel as the active demo window, clearing the ref when it closes. */
function trackActivePanel(panel) {
  activeDemoPanel = panel;
  panel.onDidChangeViewState((e) => {
    if (e.webviewPanel.active) activeDemoPanel = e.webviewPanel;
    else if (activeDemoPanel === e.webviewPanel) activeDemoPanel = null;
  });
  panel.onDidDispose(() => {
    if (activeDemoPanel === panel) activeDemoPanel = null;
  });
}

const RUN_DIR = ".rockdemo-run"; // gitignored scratch root inside a scenario

/** Remove a scenario's entire scratch dir (best-effort). */
function wipeRunDir(baseFsPath) {
  try {
    fs.rmSync(path.join(baseFsPath, RUN_DIR), { recursive: true, force: true });
  } catch (err) {
    /* nothing to clean — ignore */
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Expand an asset `file` pattern (relative to the index.json directory) into a
 * list of absolute host paths. `*` is supported in the final path segment.
 */
function expandGlob(baseDir, pattern) {
  const dirPart = path.dirname(pattern);
  const filePart = path.basename(pattern);
  const absDir = path.resolve(baseDir, dirPart);
  let names;
  try {
    names = fs.readdirSync(absDir);
  } catch (err) {
    return [];
  }
  const rx = new RegExp(
    "^" + filePart.split("*").map(escapeRegExp).join(".*") + "$"
  );
  return names.filter((n) => rx.test(n)).map((n) => path.join(absDir, n));
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch (err) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Background scripts: each intro/step may declare a `background` command (or
// script file) run in the background inside a node's container, with
// stdout+stderr captured to /var/log/rockdemo/<scenario>/<step>_background.log.
// We run it detached via `docker exec` (not in the terminal) so the execution
// is completely hidden, retrying until the container — started in its terminal —
// is up.
// ---------------------------------------------------------------------------

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A `background`/`foreground` value may be a script file (path relative to
 * index.json) whose contents are run, or a literal shell command. Returns the
 * script to execute.
 */
function resolveScript(baseFsPath, value) {
  try {
    const abs = path.resolve(baseFsPath, value);
    if (fs.statSync(abs).isFile()) return fs.readFileSync(abs, "utf8");
  } catch (err) {
    /* not a file — treat as a literal command */
  }
  return value;
}

/**
 * Pick the target node terminal record for a background command: the named
 * `host` if given, otherwise the first node (works for both backendExtended
 * and the single `backend`).
 */
function pickHost(entry, host) {
  const recs = entry.terminals || [];
  if (host) return recs.find((r) => r.name === host) || null;
  return recs[0] || null;
}

/**
 * Run the background command for an intro/step (once per run) detached in its
 * target node's container, logging to
 * /var/log/rockdemo/<scenario>/<step>_background.log inside the container.
 * `stepId` is "intro" or a 0-based step index; the log uses "intro" or the
 * 1-based step number. Runs via `docker exec -d` so nothing shows in the
 * terminal; retries until the container is up (its terminal may still be
 * pulling the image).
 */
async function runBackground(entry, stepId) {
  const details = (entry.scenario && entry.scenario.details) || {};
  const cfg =
    stepId === "intro" ? details.intro : (details.steps || [])[Number(stepId)];
  if (!cfg || !cfg.background) return;

  if (!entry.bgDone) entry.bgDone = new Set();
  if (entry.bgDone.has(stepId)) return; // already launched this run
  entry.bgDone.add(stepId);

  const rec = pickHost(entry, cfg.host);
  if (!rec) {
    vscode.window.showWarningMessage(
      cfg.host
        ? `rockDemo: cannot run background script — host "${cfg.host}" does not exist`
        : `rockDemo: cannot run background script — no node available`
    );
    return;
  }

  const script = resolveScript(entry.baseFsPath, cfg.background);
  const scenarioName = path.basename(entry.baseFsPath);
  const label = stepId === "intro" ? "intro" : String(Number(stepId) + 1);
  const logDir = `/var/log/rockdemo/${scenarioName}`;
  const logFile = `${logDir}/${label}_background.log`;
  // A subshell groups the (possibly multi-line) script; redirection captures
  // its output to the log file inside the container. `docker exec -d` detaches.
  const wrapped = `mkdir -p ${logDir}; ( ${script}\n) > ${logFile} 2>&1`;

  // The container is launched in its terminal and may still be pulling its
  // image, so retry the exec until it succeeds (or give up after ~2 min).
  for (let i = 0; i < 120; i++) {
    if (entry.disposed) return; // panel closed while we were waiting
    try {
      await execFile("docker", ["exec", "-d", rec.containerName, "sh", "-c", wrapped]);
      return;
    } catch (err) {
      await delay(1000);
    }
  }
  vscode.window.showErrorMessage(
    `rockDemo: could not start background for "${stepId}" (is Docker running?)`
  );
}

/**
 * Run the foreground command for an intro/step (once per run) in its target
 * node's terminal. The `foreground` value is sent verbatim as a SINGLE line
 * (Killercoda-style) — we do NOT read a script file's contents; the container
 * shell runs the command itself. It runs in the foreground, so its output is
 * visible and it blocks the terminal until it finishes. `stepId` is "intro" or
 * a 0-based step index.
 */
function runForeground(entry, stepId) {
  const details = (entry.scenario && entry.scenario.details) || {};
  const cfg =
    stepId === "intro" ? details.intro : (details.steps || [])[Number(stepId)];
  if (!cfg || !cfg.foreground) return;

  const rec = pickHost(entry, cfg.host);
  if (!rec) {
    vscode.window.showWarningMessage(
      cfg.host
        ? `rockDemo: cannot run foreground command — host "${cfg.host}" does not exist`
        : `rockDemo: cannot run foreground command — no node available`
    );
    // Un-gate START/NEXT so the screen isn't stuck waiting on a command that
    // can't run.
    postForegroundDone(entry, stepId);
    return;
  }

  // The command runs visibly in the terminal and blocks it until done, but the
  // terminal gives us no completion signal — so the command `touch`es a marker
  // when it finishes, which we poll for to un-gate NEXT.
  const marker = `/tmp/.rockdemo-fg-${stepId}`;
  if (!entry.fgDone) entry.fgDone = new Set();
  if (!entry.fgDone.has(stepId)) {
    entry.fgDone.add(stepId);
    // Reveal the node's terminal (without stealing focus) and send the command
    // as one line. The subshell scopes `cd /scenario` (the read-only scenario
    // mount where scripts live) and the "." on PATH to this run; the marker is
    // written after it regardless of the command's exit status.
    rec.terminal.show(true);
    rec.terminal.sendText(
      `rm -f ${marker}; ( cd /scenario && export PATH=".:$PATH"; ${cfg.foreground} ); touch ${marker}`,
      true
    );
  }
  // The intro gates START and steps gate NEXT until the marker appears. Safe to
  // (re)poll on every enter — e.g. after a save rebuilds the webview.
  pollForegroundDone(entry, rec, marker, stepId);
}

/** Tell the webview a step's foreground command has finished (enables NEXT). */
function postForegroundDone(entry, stepId) {
  if (!entry.disposed && entry.panel) {
    entry.panel.webview.postMessage({ type: "foregroundDone", step: stepId });
  }
}

/**
 * Poll (hidden, via `docker exec`) for the foreground completion marker and,
 * once present, tell the webview to enable NEXT. Fails open: if the container
 * has no name, or after a long timeout, NEXT is enabled anyway so the user is
 * never permanently stuck.
 */
async function pollForegroundDone(entry, rec, marker, stepId) {
  if (!rec.containerName) return postForegroundDone(entry, stepId);
  for (let i = 0; i < 600; i++) {
    if (entry.disposed) return;
    try {
      await execFile("docker", ["exec", rec.containerName, "test", "-f", marker]);
      return postForegroundDone(entry, stepId); // marker exists → finished
    } catch (err) {
      await delay(1000); // not yet — keep waiting
    }
  }
  postForegroundDone(entry, stepId); // safety un-gate after timeout
}

/**
 * Run a step's `verify` command hidden (via `docker exec`, nothing in the
 * terminal), capturing output to /var/log/rockdemo/<scenario>/<N>_verify.log.
 * The command's exit code is the result: 0 = pass. Posts a `verifyResult`
 * message back to the webview (which reveals NEXT or flashes VERIFY red), and
 * notifies with the log location on failure.
 */
async function runVerify(entry, stepId) {
  const details = (entry.scenario && entry.scenario.details) || {};
  const cfg = (details.steps || [])[Number(stepId)];
  const post = (ok) => {
    if (!entry.disposed) {
      entry.panel.webview.postMessage({ type: "verifyResult", step: stepId, ok });
    }
  };
  if (!cfg || !cfg.verify) return post(true);

  const rec = pickHost(entry, cfg.host);
  if (!rec) {
    vscode.window.showWarningMessage(
      cfg.host
        ? `rockDemo: cannot run verify command — host "${cfg.host}" does not exist`
        : `rockDemo: cannot run verify command — no node available`
    );
    return post(false);
  }

  const scenarioName = path.basename(entry.baseFsPath);
  const label = String(Number(stepId) + 1);
  const logDir = `/var/log/rockdemo/${scenarioName}`;
  const logFile = `${logDir}/${label}_verify.log`;
  // Run from /scenario with "." on PATH (like foreground), output captured to
  // the log; the verify command's exit status is the overall exit status.
  const wrapped =
    `mkdir -p ${logDir}; cd /scenario && export PATH=".:$PATH"; ` +
    `${cfg.verify} > ${logFile} 2>&1`;

  let ok = false;
  try {
    await execFile("docker", ["exec", rec.containerName, "sh", "-c", wrapped]);
    ok = true; // exited 0
  } catch (err) {
    ok = false; // non-zero exit (verify failed) or exec error
  }
  post(ok);
  if (!ok) {
    vscode.window.showErrorMessage(
      `rockDemo: step ${label} verification failed — see ${logFile} on node "${rec.name}"`
    );
  }
}

/**
 * Stage one asset rule into the scratch dir and return a mount descriptor
 * { host, container, ro }, or null if nothing matched. The copy lives under
 * <scenario>/.rockdemo-run/<node>/<idx>/ and is what gets bind-mounted — the
 * originals are never touched, and `+r` becomes a read-only (`:ro`) mount.
 * `container` is the mount point inside the container, used both to mount and
 * to reverse-map container paths back to the host copy for {{open}}.
 */
function stageRule(baseDir, nodeName, idx, rule) {
  const matches = expandGlob(baseDir, rule.file);
  if (!matches.length) {
    vscode.window.showWarningMessage(
      `rockDemo: no files match "${rule.file}" for node "${nodeName}"`
    );
    return null;
  }
  const safeNode = nodeName.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const scratchDir = path.join(baseDir, RUN_DIR, safeNode, String(idx));
  fs.mkdirSync(scratchDir, { recursive: true });
  const ro = rule.chmod === "+r";

  if (matches.length === 1 && isDirectory(matches[0])) {
    // Single folder → its contents become the mounted target directory.
    fs.cpSync(matches[0], scratchDir, { recursive: true });
    return { host: scratchDir, container: rule.target, ro };
  }
  if (matches.length === 1) {
    // Single file → mount the directory holding it (mounting a lone file
    // breaks when an editor saves via atomic rename), with the file named to
    // match the target's basename.
    fs.copyFileSync(matches[0], path.join(scratchDir, path.basename(rule.target)));
    return { host: scratchDir, container: path.posix.dirname(rule.target), ro };
  }
  // Multiple matches → copy each into the scratch dir (the mounted target).
  for (const m of matches) {
    fs.cpSync(m, path.join(scratchDir, path.basename(m)), { recursive: true });
  }
  return { host: scratchDir, container: rule.target, ro };
}

/** Stage every asset rule for a node, returning its list of mount descriptors. */
function stageNodeAssets(entry, node) {
  const rules = (entry.assets && entry.assets[node.name]) || [];
  const mounts = [];
  rules.forEach((rule, i) => {
    const m = stageRule(entry.baseFsPath, node.name, i, rule);
    if (m) mounts.push(m);
  });
  return mounts;
}

/**
 * Reverse-map a container-absolute path to the host copy mounted there, by
 * matching the longest mount `container` prefix across the entry's nodes
 * (preferring the active node's terminal on ties). Returns null if unmapped.
 */
function mapContainerPath(entry, containerPath) {
  if (!containerPath || !containerPath.startsWith("/")) return null;
  const active = vscode.window.activeTerminal;
  let best = null;
  for (const rec of entry.terminals || []) {
    for (const m of rec.mounts || []) {
      const c = m.container.replace(/\/+$/, "");
      if (containerPath === c || containerPath.startsWith(c + "/")) {
        const score = c.length * 2 + (rec.terminal === active ? 1 : 0);
        if (!best || score > best.score) {
          best = { score, hostPath: path.join(m.host, containerPath.slice(c.length)) };
        }
      }
    }
  }
  return best ? best.hostPath : null;
}

/**
 * Restart a scenario from scratch: dispose all node terminals (force-removing
 * their containers and wiping the scratch dir), relaunch — startNodes re-stages
 * assets fresh — and rebuild the webview HTML so every gate (verify-hidden NEXT,
 * foreground-disabled NEXT/START) resets to its initial state, exactly like a
 * fresh open. (The DOM persists across navigation, so without this the gates
 * would keep whatever state the previous run left them in.)
 */
function restartScenario(entry) {
  disposeEntryTerminals(entry);
  startNodes(entry);
  buildScenario(entry.doc).then((data) => {
    if (!entry.disposed) {
      // VS Code ignores `webview.html = x` when `x` is byte-identical to the
      // current html — so a plain re-render of the same scenario would NOT
      // reload the webview, leaving the DOM stuck on the finish screen. Append
      // a unique marker so the string differs and the webview actually reloads
      // to a fresh DOM (resetting every gate back to its initial state).
      entry.gen = (entry.gen || 0) + 1;
      entry.panel.webview.html =
        scenarioHtml(data, entry.panel.webview) +
        `\n<!-- restart ${entry.gen} -->`;
    }
  });
}

// ---------------------------------------------------------------------------
// Edit mode: CodeLens buttons above actionable blocks.
// ---------------------------------------------------------------------------

class ScenarioCodeLensProvider {
  provideCodeLenses(document) {
    const lenses = [];
    for (const block of parseScenario(document)) {
      const range = new vscode.Range(block.openLine, 0, block.openLine, 0);

      if (block.action === "exec") {
        lenses.push(
          new vscode.CodeLens(range, {
            title: block.interrupt ? "▶ Run (Ctrl+C first)" : "▶ Run in terminal",
            command: "rockdemo.exec",
            arguments: [block.content, { interrupt: !!block.interrupt }],
          })
        );
        lenses.push(
          new vscode.CodeLens(range, {
            title: "📋 Copy",
            command: "rockdemo.copy",
            arguments: [block.content],
          })
        );
      } else if (block.action === "copy") {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "📋 Copy",
            command: "rockdemo.copy",
            arguments: [block.content],
          })
        );
      } else if (block.action === "open") {
        lenses.push(
          new vscode.CodeLens(range, {
            title: "📂 Open file",
            command: "rockdemo.open",
            arguments: [block.content.trim(), document.uri],
          })
        );
      }
    }
    return lenses;
  }
}

// ---------------------------------------------------------------------------
// Preview mode: a self-rendered "demo" webview that hides the meta fences and
// turns actionable blocks into clickable buttons.
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// HTML tags allowed to pass through verbatim (Killercoda-compatible raw-HTML
// support). The webview CSP already blocks script execution and external loads,
// so this is purely about not escaping author-written markup. script/style/
// iframe/object are deliberately omitted.
const HTML_PASSTHROUGH_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "center", "code", "dd", "del",
  "details", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2",
  "h3", "h4", "h5", "h6", "hr", "i", "img", "kbd", "li", "mark", "ol", "p",
  "pre", "s", "small", "span", "strong", "sub", "summary", "sup", "table",
  "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);

// Matches a single HTML tag (open / close / self-closing) with optional
// attributes. Attributes may not contain raw < or >.
const HTML_TAG_RE = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?\/?>/g;

/** Is `name` an HTML tag we let through unescaped? */
function isPassthroughTag(name) {
  return HTML_PASSTHROUGH_TAGS.has(name.toLowerCase());
}

/** Does the (trimmed) line consist of a single allow-listed HTML tag? */
function isHtmlBlockLine(line) {
  const m = line.match(
    /^<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?\/?>$/
  );
  return !!m && isPassthroughTag(m[1]);
}

/**
 * Render an inline `code` span plus its action icon(s). Single-backtick spans
 * are copyable by default (Killercoda-style); a trailing annotation overrides:
 *   `cmd`            -> copy icon (default)
 *   `cmd`{{}}        -> no icon (copy disabled)
 *   `cmd`{{exec}}    -> run + copy icons
 *   `cmd`{{exec interrupt}} -> run sends Ctrl+C first, + copy
 *   `cmd`{{copy}}    -> copy icon
 */
function inlineCodeHtml(code, anno) {
  const ann = parseAnnotation(anno);
  const action = ann.present ? ann.action : "copy"; // default: copyable
  const codeHtml = `<code>${escapeHtml(code)}</code>`;
  const cmd = encodeURIComponent(code);
  if (action === "exec") {
    const intr = ann.interrupt ? ` data-interrupt="1"` : "";
    const title = ann.interrupt ? "Run (Ctrl+C first)" : "Run in terminal";
    return (
      codeHtml +
      `<button class="inline-act" title="${title}" data-action="exec" data-cmd="${cmd}"${intr}>▶</button>` +
      `<button class="inline-act" title="Copy" data-action="copy" data-cmd="${cmd}">📋</button>`
    );
  }
  if (action === "copy") {
    return (
      codeHtml +
      `<button class="inline-act" title="Copy" data-action="copy" data-cmd="${cmd}">📋</button>`
    );
  }
  // {{}} (disabled) or any other annotation → plain code, no icon.
  return codeHtml;
}

/** Render a single line of inline markdown (code, bold, italic, links, HTML). */
function renderInline(text) {
  // Stash spans that must survive escaping/markdown rules untouched, swapping in
  // a placeholder containing no markdown/HTML metacharacters.
  const tokens = [];
  const stash = (html) => {
    tokens.push(html);
    return "%%RD" + (tokens.length - 1) + "%%";
  };

  // Inline code (+ optional {{...}} annotation): contents stay escaped and are
  // never treated as HTML; the span renders with its copy/run icon(s).
  let s = text.replace(
    /`([^`]+)`(?:\{\{([^}]*)\}\})?/g,
    (_m, c, anno) => stash(inlineCodeHtml(c, anno))
  );

  // Allow-listed raw HTML tags pass through verbatim (e.g. <br>, <kbd>, <img>).
  s = s.replace(HTML_TAG_RE, (m, name) => (isPassthroughTag(name) ? stash(m) : m));

  // Escape everything that remains (stray <, >, &, quotes in prose).
  s = escapeHtml(s);

  // Inline markdown on the escaped text.
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  s = s.replace(/\b_([^_]+)_\b/g, "<em>$1</em>");
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, label, href) => `<a href="${href}">${label}</a>`
  );

  // Restore stashed code spans / HTML tags.
  return s.replace(/%%RD(\d+)%%/g, (_m, i) => tokens[i]);
}

/**
 * Build the action buttons for one actionable block (returned as HTML).
 * `baseStr` is the directory (a serialized URI) against which {{open}} paths
 * are resolved — it travels with the click back to the extension.
 */
function blockButtons(block, baseStr) {
  const cmd = encodeURIComponent(block.content);
  if (block.action === "exec") {
    const intr = block.interrupt ? ` data-interrupt="1"` : "";
    const runLabel = block.interrupt ? "▶ Run (Ctrl+C first)" : "▶ Run in terminal";
    return (
      `<pre class="demo-cmd"><code>${escapeHtml(block.content)}</code></pre>` +
      `<div class="demo-actions">` +
      `<button data-action="exec" data-cmd="${cmd}"${intr}>${runLabel}</button>` +
      `<button data-action="copy" data-cmd="${cmd}">📋 Copy</button>` +
      `</div>`
    );
  }
  if (block.action === "copy") {
    return (
      `<pre class="demo-cmd"><code>${escapeHtml(block.content)}</code></pre>` +
      `<div class="demo-actions">` +
      `<button data-action="copy" data-cmd="${cmd}">📋 Copy</button>` +
      `</div>`
    );
  }
  // open
  const file = encodeURIComponent(block.content.trim());
  const base = encodeURIComponent(baseStr || "");
  return (
    `<div class="demo-actions">` +
    `<button data-action="open" data-file="${file}" data-base="${base}">📂 Open ${escapeHtml(
      block.content.trim()
    )}</button>` +
    `</div>`
  );
}

/**
 * Expand a Killercoda line-highlight directive into a Set of 1-based line
 * numbers. Accepts the brace form ("{2,5,6}", "{6-9}") or the bare inner text,
 * with comma-separated singletons and `a-b` ranges.
 */
function parseHighlightSpec(spec) {
  const set = new Set();
  if (!spec) return set;
  const inner = spec.replace(/^\{/, "").replace(/\}$/, "");
  for (const part of inner.split(",")) {
    const p = part.trim();
    const range = p.match(/^(\d+)-(\d+)$/);
    if (range) {
      for (let i = +range[1]; i <= +range[2]; i++) set.add(i);
    } else if (/^\d+$/.test(p)) {
      set.add(+p);
    }
  }
  return set;
}

/**
 * Render a non-actionable fenced block as a displayed (read-only) code block.
 * `lang` adds a `language-*` class (a hook for future syntax highlighting; the
 * `text` language opts out); `highlight` is the optional `{...}` directive whose
 * listed lines get a highlight background. Lines are only span-wrapped when a
 * highlight directive is present, to keep ordinary blocks clean.
 */
function codeBlockHtml(content, lang, highlight) {
  const hl = parseHighlightSpec(highlight);
  // `text` opts out of highlighting; a named language pins it; no language lets
  // the highlighter auto-detect. The class drives the client-side highlighter.
  let langClass = "";
  if (lang === "text" || lang === "plaintext" || lang === "nohighlight") {
    langClass = ` class="nohighlight"`;
  } else if (lang) {
    langClass = ` class="language-${escapeHtml(lang)}"`;
  }
  let body;
  if (hl.size) {
    body = content
      .split("\n")
      .map((ln, i) => {
        const esc = escapeHtml(ln) || "​"; // keep blank highlighted lines tall
        return hl.has(i + 1)
          ? `<span class="code-line hl">${esc}</span>`
          : `<span class="code-line">${esc}</span>`;
      })
      .join("");
  } else {
    body = escapeHtml(content);
  }
  return `<pre class="code-snippet"><code${langClass}>${body}</code></pre>`;
}

/**
 * Render the document body to HTML for the demo webview: regular markdown is
 * rendered, fenced code blocks are dropped, and actionable {{...}} blocks are
 * replaced by their buttons. Re-uses the exact same parsing rules as
 * parseScenario / the CodeLens provider so the two modes never disagree.
 */
function renderMarkdownToHtml(text, baseStr) {
  const lines = text.split(/\r?\n/);
  const out = [];

  let inFence = false;
  let lang = "";
  let highlight = "";
  let content = [];

  // Simple list grouping.
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };

  let paragraph = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };

  // Blockquote grouping: consecutive `>` lines become one <blockquote>.
  let quote = [];
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${renderInline(quote.join(" "))}</blockquote>`);
      quote = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inFence) {
      // Opening fence: capture language and an optional line-highlight directive
      // (e.g. ```yaml{2,5,6} or ```json{6-9}).
      const open = line.match(/^```([\w-]*)\s*(\{[^}]*\})?/);
      if (open) {
        flushParagraph();
        flushQuote();
        closeList();
        inFence = true;
        lang = open[1].toLowerCase();
        highlight = open[2] || "";
        content = [];
        continue;
      }
    } else {
      const close = line.match(/^```\s*(?:\{\{([^}]*)\}\})?\s*$/);
      if (close) {
        inFence = false;
        const ann = parseAnnotation(close[1]);
        let action = ann.action;
        if (!ann.present && ["bash", "sh", "shell"].includes(lang)) {
          action = "exec";
        }
        const body = content.join("\n");
        if (action && body.trim().length > 0) {
          // Actionable block → buttons.
          out.push(
            blockButtons({ action, lang, content: body, interrupt: ann.interrupt }, baseStr)
          );
        } else if (body.trim().length > 0) {
          // Non-actionable fence → display it as a (optionally highlighted) code
          // block (Killercoda renders code snippets, it doesn't hide them).
          out.push(codeBlockHtml(body, lang, highlight));
        }
        continue;
      }
      content.push(line);
      continue;
    }

    // --- Regular markdown line (outside any fence) ---
    if (line.trim() === "") {
      flushParagraph();
      flushQuote();
      closeList();
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      flushQuote();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      flushParagraph();
      flushQuote();
      closeList();
      out.push("<hr/>");
      continue;
    }

    // Blockquote: a line beginning with `>` (one optional space stripped).
    // Consecutive such lines accumulate into a single <blockquote>.
    const quoteLine = line.match(/^\s*>\s?(.*)$/);
    if (quoteLine) {
      flushParagraph();
      closeList();
      quote.push(quoteLine[1]);
      continue;
    }

    const li = line.match(/^\s*[-*]\s+(.*)$/);
    if (li) {
      flushParagraph();
      flushQuote();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${renderInline(li[1])}</li>`);
      continue;
    }

    const oli = line.match(/^\s*\d+\.\s+(.*)$/);
    if (oli) {
      flushParagraph();
      flushQuote();
      closeList();
      out.push(`<ul><li>${renderInline(oli[1])}</li></ul>`);
      continue;
    }

    // A line that is a single allow-listed HTML tag (e.g. <br>, <div ...>,
    // </table>) is emitted raw — no <p> wrapper — so author HTML blocks render
    // as intended instead of being mangled by paragraph/list handling.
    if (isHtmlBlockLine(line.trim())) {
      flushParagraph();
      flushQuote();
      closeList();
      out.push(line.trim());
      continue;
    }

    // Otherwise: accumulate into a paragraph (ending any pending blockquote).
    flushQuote();
    paragraph.push(line.trim());
  }

  flushParagraph();
  flushQuote();
  closeList();
  return out.join("\n");
}

// Shared client-side script: relays action-button clicks to the extension and
// drives step navigation (sections toggle their `active` class). Harmless in
// single-document demo mode, which simply has one always-active section.
const CLIENT_SCRIPT = `
  const vscode = acquireVsCodeApi();
  const sections = Array.from(document.querySelectorAll("section[data-step]"));
  function enter(id) {
    if (id) vscode.postMessage({ nav: "enter", step: id });
  }
  function show(id) {
    sections.forEach((s) => s.classList.toggle("active", s.dataset.step === id));
    window.scrollTo(0, 0);
    enter(id); // let the extension run this step's background script
  }
  // Fire for the initially-active section (the intro) on load.
  const initial = sections.find((s) => s.classList.contains("active"));
  if (initial) enter(initial.dataset.step);
  document.addEventListener("click", (e) => {
    const nav = e.target.closest("button[data-target],button[data-nav]");
    if (nav) {
      if (nav.dataset.nav === "finish") {
        if (document.querySelector('section[data-step="finish"]')) show("finish");
        else vscode.postMessage({ nav: "finish" });
      } else if (nav.dataset.nav === "restart") {
        // The extension relaunches the containers and rebuilds the webview HTML
        // from scratch (resetting every gate), so we don't navigate here.
        vscode.postMessage({ nav: "restart" });
      } else if (nav.dataset.nav === "close") {
        vscode.postMessage({ nav: "close" });
      } else if (nav.dataset.nav === "verify") {
        nav.disabled = true;
        nav.classList.add("checking");
        vscode.postMessage({ nav: "verify", step: nav.dataset.step });
      } else if (nav.dataset.target) {
        show(nav.dataset.target);
      }
      return;
    }
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    vscode.postMessage({
      action: btn.dataset.action,
      cmd: btn.dataset.cmd ? decodeURIComponent(btn.dataset.cmd) : undefined,
      file: btn.dataset.file ? decodeURIComponent(btn.dataset.file) : undefined,
      base: btn.dataset.base ? decodeURIComponent(btn.dataset.base) : undefined,
      interrupt: btn.dataset.interrupt === "1",
    });
  });
  // Verification result from the extension: reveal NEXT on success, or flash
  // the VERIFY button red for ~1s on failure.
  window.addEventListener("message", (e) => {
    const m = e.data || {};
    // A step's foreground command finished → enable its (disabled) NEXT button.
    if (m.type === "foregroundDone") {
      const sec = sections.find((s) => s.dataset.step === String(m.step));
      const btn = sec && sec.querySelector("button[data-fg-gated]");
      if (btn) {
        btn.disabled = false;
        btn.removeAttribute("data-fg-gated");
      }
      return;
    }
    if (m.type !== "verifyResult") return;
    const section = sections.find((s) => s.dataset.step === String(m.step));
    if (!section) return;
    const vbtn = section.querySelector('button[data-nav="verify"]');
    if (vbtn) {
      vbtn.disabled = false;
      vbtn.classList.remove("checking");
    }
    if (m.ok) {
      const next = section.querySelector(".next-gated");
      if (next) next.style.display = "";
      if (vbtn) {
        vbtn.classList.add("verified");
        vbtn.disabled = true;
        vbtn.textContent = "✓ VERIFIED";
      }
    } else if (vbtn) {
      vbtn.classList.add("verify-fail");
      setTimeout(() => vbtn.classList.remove("verify-fail"), 1000);
    }
  });

  // Syntax highlighting via the vendored highlight.js. Token-colour read-only
  // code snippets; for line-highlighted blocks, colour each line in place so
  // the {2,5,6}-style line backgrounds survive. No-ops if hljs failed to load.
  function highlightSnippets() {
    if (!window.hljs) return;
    document.querySelectorAll("pre.code-snippet > code").forEach(function (code) {
      if (code.dataset.hl === "done") return;
      code.dataset.hl = "done";
      if (code.classList.contains("nohighlight")) return;
      var m = code.className.match(/language-(\\S+)/);
      var lang = m && hljs.getLanguage(m[1]) ? m[1] : null;
      var lines = code.querySelectorAll(".code-line");
      if (lines.length) {
        // Per-line colouring keeps the {2,5,6} line backgrounds. Add the hljs
        // class so the block gets the theme's matching background + base colour.
        code.classList.add("hljs");
        lines.forEach(function (ln) {
          var txt = ln.textContent.replace(/\\u200b/g, "");
          try {
            ln.innerHTML = lang
              ? hljs.highlight(txt, { language: lang }).value
              : hljs.highlightAuto(txt).value;
          } catch (e) {}
        });
      } else {
        try { hljs.highlightElement(code); } catch (e) {}
      }
    });
  }
  highlightSnippets();
`;

/** localResourceRoots entry for the vendored media/ assets (or [] pre-activate). */
function mediaRoots() {
  return extensionUri ? [vscode.Uri.joinPath(extensionUri, "media")] : [];
}

/** Webview URI for a vendored asset under media/, or "" if unavailable. */
function mediaUri(webview, file) {
  if (!extensionUri) return "";
  return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", file)).toString();
}

/** Wrap rendered body HTML in the full themed, CSP-locked webview page. */
function pageHtml(webview, title, body) {
  const nonce = "n" + body.length + "x" + title.length;
  // Vendored syntax highlighter (highlight.js) + its themes, loaded from media/.
  const hljsJs = mediaUri(webview, "highlight.min.js");
  const hljsDark = mediaUri(webview, "highlight-dark.css");
  const hljsLight = mediaUri(webview, "highlight-light.css");
  const hljsHead = hljsJs
    ? `<link rel="stylesheet" href="${hljsDark}" media="(prefers-color-scheme: dark)" />` +
      `<link rel="stylesheet" href="${hljsLight}" media="(prefers-color-scheme: light)" />`
    : "";
  const hljsScript = hljsJs ? `<script nonce="${nonce}" src="${hljsJs}"></script>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource};" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
${hljsHead}
<style>
  body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 0 2rem 4rem;
    line-height: 1.5;
    max-width: 900px;
  }
  h1, h2, h3 { border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: .3em; }
  code {
    font-family: var(--vscode-editor-font-family, monospace);
    background: var(--vscode-textCodeBlock-background);
    padding: .1em .3em;
    border-radius: 3px;
  }
  a { color: var(--vscode-textLink-foreground); }
  blockquote {
    margin: 1em 0;
    padding: .4em 1em;
    border-left: 4px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border));
    background: var(--vscode-textBlockQuote-background, rgba(127, 127, 127, .1));
  }
  blockquote > :first-child { margin-top: 0; }
  blockquote > :last-child { margin-bottom: 0; }
  .lead { font-size: 1.1em; opacity: .85; }
  .crumb { font-size: .8em; text-transform: uppercase; letter-spacing: .05em; opacity: .6; margin: 0; }
  section[data-step] { display: none; }
  section[data-step].active { display: block; }
  .demo-cmd {
    background: var(--vscode-textCodeBlock-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px 6px 0 0;
    padding: .8em 1em;
    margin: 1em 0 0;
    overflow-x: auto;
  }
  .demo-cmd code { background: none; padding: 0; }
  /* Read-only code snippets (non-actionable fenced blocks). */
  /* The padding/background live on the code element, not the pre: when
     highlight.js adds its hljs class it brings a matching background+colour from
     the theme (so the two never mismatch). Non-highlighted blocks fall back to
     the VS Code code-block colours. */
  .code-snippet {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    margin: 1em 0;
    overflow: hidden;
  }
  .code-snippet code {
    display: block;
    padding: .8em 1em;
    overflow-x: auto;
  }
  .code-snippet code:not(.hljs) {
    background: var(--vscode-textCodeBlock-background);
    color: var(--vscode-foreground);
  }
  /* In light themes, replace highlight.js's stark white with a soft light grey
     (GitHub's own code grey). Dark themes keep the highlighter's dark background. */
  @media (prefers-color-scheme: light) {
    .code-snippet code.hljs {
      background: #cfe2f3;
    }
  }
  .code-snippet .code-line { display: block; }
  /* Highlighted lines from a {2,5,6}/{6-9} directive — full-bleed background. */
  .code-snippet .code-line.hl {
    background: #acadaf;
    margin: 0 -1em;
    padding: 0 calc(1em - 3px);
    border-left: 3px solid var(--vscode-editorLineNumber-activeForeground, #c8a000);
  }
  /* Inline copy/run icons rendered right after a single-backtick code span. */
  .inline-act {
    font-size: 11px;
    line-height: 1;
    cursor: pointer;
    border: none;
    border-radius: 3px;
    padding: .1em .35em;
    margin-left: .25em;
    vertical-align: baseline;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  .inline-act:hover { filter: brightness(1.2); }
  .demo-actions {
    display: flex;
    gap: .5rem;
    margin: 0 0 1.4em;
  }
  .demo-actions button {
    font-size: 13px;
    cursor: pointer;
    border: none;
    border-radius: 0 0 6px 6px;
    padding: .45em .9em;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  .demo-actions button:hover { background: var(--vscode-button-hoverBackground); }
  .demo-actions button[data-action="copy"],
  .demo-actions button[data-action="open"] {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
    border-radius: 6px;
  }
  .nav {
    display: flex;
    justify-content: space-between;
    gap: .5rem;
    margin-top: 2.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--vscode-panel-border);
  }
  .nav button {
    font-size: 14px;
    cursor: pointer;
    border: none;
    border-radius: 6px;
    padding: .55em 1.4em;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  .nav button.primary {
    margin-left: auto;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  /* margin-left:auto on the first primary pushes the group right; a sibling
     primary should sit right next to it, not add another gap. */
  .nav button.primary ~ button.primary { margin-left: 0; }
  .nav button:hover { filter: brightness(1.1); }
  /* Gated NEXT (waiting on a foreground command) looks inactive. */
  .nav button:disabled { opacity: .5; cursor: not-allowed; filter: none; }
  /* Verify button states. The background transition makes the failure flash
     animate to red and back over ~1s. */
  .nav button.verify-btn { transition: background .3s ease, color .3s ease; }
  .nav button.checking { opacity: .7; cursor: progress; }
  .nav button.verify-fail {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    color: var(--vscode-inputValidation-errorForeground, #fff);
  }
  .nav button.verified {
    background: var(--vscode-testing-iconPassed, #388a34);
    color: #fff;
    cursor: default;
  }
  /* End-screen actions: RESTART green, CLOSE red. */
  .nav button[data-nav="restart"] {
    background: var(--vscode-testing-iconPassed, #388a34);
    color: #fff;
  }
  .nav button[data-nav="close"] {
    background: var(--vscode-inputValidation-errorBackground, #a1260d);
    color: var(--vscode-inputValidation-errorForeground, #fff);
  }
</style>
</head>
<body>
${body}
${hljsScript}
<script nonce="${nonce}">${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

/** Single markdown document → demo HTML (one always-visible section). */
function demoHtml(document, webview) {
  const baseStr = vscode.Uri.joinPath(document.uri, "..").toString();
  const body =
    `<section class="step active" data-step="0">` +
    renderMarkdownToHtml(document.getText(), baseStr) +
    `</section>`;
  const title = document.uri.path.split("/").pop() || "rockDemo";
  return pageHtml(webview, "rockDemo — " + title, body);
}

/**
 * Send a command to the panel's terminal. With multiple node terminals, it
 * targets whichever node terminal is currently active (so clicking into a node
 * directs subsequent commands there), else the first node. Demo mode creates a
 * single terminal lazily on first use.
 */
function sendToEntryTerminal(entry, cmd, interrupt) {
  if (!entry.terminals || entry.terminals.length === 0) {
    entry.terminals = [
      { name: "rockDemo", terminal: vscode.window.createTerminal("rockDemo"), containerName: null },
    ];
  }
  const active = vscode.window.activeTerminal;
  const rec =
    entry.terminals.find((r) => r.terminal === active) || entry.terminals[0];
  rec.terminal.show();
  // With {{exec interrupt}}, Ctrl+C first to stop any running foreground process.
  if (interrupt) sendInterruptThen(rec.terminal, cmd);
  // `true` appends a newline — i.e. types the command AND presses Enter.
  else rec.terminal.sendText(cmd, true);
}

/**
 * Build the webview → extension message handler bound to one panel `entry`, so
 * each "execution window" runs commands in (and owns) its own terminal.
 */
function makeMessageHandler(entry) {
  return (msg) => {
    if (msg.action === "exec") sendToEntryTerminal(entry, msg.cmd, msg.interrupt);
    else if (msg.action === "copy") runCopy(msg.cmd);
    else if (msg.action === "open") {
      // A container-absolute path opens the host copy bind-mounted there;
      // otherwise fall back to resolving relative to the step/document.
      const hostPath = mapContainerPath(entry, msg.file);
      if (hostPath) openFsPath(hostPath);
      else runOpenBase(msg.file, msg.base ? vscode.Uri.parse(msg.base) : null);
    } else if (msg.nav === "enter") {
      runBackground(entry, msg.step);
      runForeground(entry, msg.step);
    }
    else if (msg.nav === "verify") runVerify(entry, msg.step);
    else if (msg.nav === "restart") restartScenario(entry);
    else if (msg.nav === "close" || msg.nav === "finish") {
      // CLOSE (from the end screen) ends the scenario: disposing the panel tears
      // down all node terminals/containers via onDidDispose, exactly like the
      // title-bar STOP button. `finish` is a fallback for any code path that
      // posts it directly; normally FINISH just navigates to the end screen.
      if (entry.panel) entry.panel.dispose();
    }
  };
}

/** Open (or reveal) the demo preview panel for the given markdown document. */
function openDemoPanel(document, panels) {
  const key = document.uri.toString();
  let entry = panels.get(key);

  if (entry) {
    entry.panel.reveal(vscode.ViewColumn.Beside, true);
  } else {
    const panel = vscode.window.createWebviewPanel(
      "rockdemo.demo",
      "Demo: " + (document.uri.path.split("/").pop() || "scenario"),
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: mediaRoots(),
      }
    );
    entry = { panel, terminals: [] };
    panels.set(key, entry);
    trackActivePanel(panel);
    panel.webview.onDidReceiveMessage(makeMessageHandler(entry));
    // Closing the execution window also disposes its terminal(s).
    panel.onDidDispose(() => {
      disposeEntryTerminals(entry);
      panels.delete(key);
    });
  }

  entry.panel.webview.html = demoHtml(document, entry.panel.webview);
  return entry.panel;
}

// ---------------------------------------------------------------------------
// Scenario mode: an index.json describing an intro + ordered steps, played as
// a step-through wizard in a webview, backed by a Docker container shell.
// ---------------------------------------------------------------------------

const utf8 = new TextDecoder();

async function readText(uri) {
  return utf8.decode(await vscode.workspace.fs.readFile(uri));
}

/** Load index.json + every step's markdown, relative to the json file. */
async function buildScenario(jsonDoc) {
  const dir = vscode.Uri.joinPath(jsonDoc.uri, "..");
  const scenario = JSON.parse(jsonDoc.getText());
  const details = scenario.details || {};
  const stepDefs = details.steps || [];

  const steps = [];
  for (const sd of stepDefs) {
    const fileUri = vscode.Uri.joinPath(dir, sd.text);
    const stepDir = vscode.Uri.joinPath(fileUri, "..");
    let md;
    try {
      md = await readText(fileUri);
    } catch (err) {
      md = `_rockDemo: could not load ${sd.text}_`;
    }
    steps.push({
      title: sd.title,
      md,
      baseStr: stepDir.toString(),
      verify: sd.verify || null,
      foreground: !!sd.foreground,
    });
  }

  let intro = null;
  if (details.intro && details.intro.text) {
    const introUri = vscode.Uri.joinPath(dir, details.intro.text);
    try {
      intro = {
        md: await readText(introUri),
        baseStr: vscode.Uri.joinPath(introUri, "..").toString(),
      };
    } catch (err) {
      intro = null;
    }
  }

  let finish = null;
  if (details.finish && details.finish.text) {
    try {
      finish = await readText(vscode.Uri.joinPath(dir, details.finish.text));
    } catch (err) {
      finish = null;
    }
  }

  return { scenario, steps, intro, finish, dirStr: dir.toString() };
}

/** Render the whole scenario (intro + steps + optional finish) to HTML. */
function scenarioHtml(data, webview) {
  const { scenario, steps, intro, finish } = data;
  const last = steps.length - 1;
  const sections = [];

  // If the intro has a foreground command, START is disabled until it finishes
  // (foregroundDone), mirroring NEXT gating on steps.
  const introFg = !!(
    scenario.details &&
    scenario.details.intro &&
    scenario.details.intro.foreground
  );
  sections.push(
    `<section class="step active" data-step="intro">` +
      `<h1>${escapeHtml(scenario.title || "Scenario")}</h1>` +
      `<p class="lead">${escapeHtml(scenario.description || "")}</p>` +
      // Optional intro markdown, rendered with the demo player (buttons work).
      (intro ? renderMarkdownToHtml(intro.md, intro.baseStr) : "") +
      `<div class="nav"><button class="primary" data-target="0"${
        introFg ? ' disabled data-fg-gated="1"' : ""
      }>START ▶</button></div>` +
      `</section>`
  );

  steps.forEach((s, i) => {
    const prev =
      i > 0 ? `<button data-target="${i - 1}">◀ PREV</button>` : "";
    const nextLabel = i < last ? "NEXT ▶" : "✔ FINISH";
    const nextAttr = i < last ? `data-target="${i + 1}"` : `data-nav="finish"`;
    // When a step has `verify`, NEXT/FINISH is gated: hidden until the VERIFY
    // command exits 0, at which point the client reveals it. When a step has a
    // `foreground` command, NEXT starts disabled and is enabled once that
    // command finishes (foregroundDone). The two gates are independent and
    // compose: a step with both is hidden+disabled until verify passes AND the
    // foreground finishes.
    const gated = !!s.verify;
    const fgGated = !!s.foreground;
    const next = `<button class="primary next-gated" ${nextAttr}${
      gated ? ' style="display:none"' : ""
    }${fgGated ? ' disabled data-fg-gated="1"' : ""}>${nextLabel}</button>`;
    const verify = gated
      ? `<button class="primary verify-btn" data-nav="verify" data-step="${i}">✓ VERIFY</button>`
      : "";
    sections.push(
      `<section class="step" data-step="${i}">` +
        `<p class="crumb">Step ${i + 1} / ${steps.length}</p>` +
        `<h2>${escapeHtml(s.title || "Step " + (i + 1))}</h2>` +
        renderMarkdownToHtml(s.md, s.baseStr) +
        `<div class="nav">${prev}${verify}${next}</div>` +
        `</section>`
    );
  });

  // End screen — always present. Uses the scenario's finish.md when defined,
  // otherwise a built-in completion message. RESTART rebuilds from scratch;
  // CLOSE ends the scenario (tears down all containers/terminals, like STOP).
  const finishBody = finish
    ? renderMarkdownToHtml(finish, data.dirStr)
    : `<h1>🎉 ${escapeHtml(scenario.title || "Scenario")} complete</h1>` +
      `<p class="lead">You've reached the end of this scenario.</p>`;
  sections.push(
    `<section class="step" data-step="finish">` +
      finishBody +
      `<div class="nav">` +
      `<button data-target="${last}">◀ PREV</button>` +
      `<button class="primary" data-nav="restart">⟲ RESTART</button>` +
      `<button class="primary" data-nav="close">✖ CLOSE</button>` +
      `</div>` +
      `</section>`
  );

  return pageHtml(webview, scenario.title || "Scenario", sections.join("\n"));
}

/** Open (or reveal) the scenario player for an index.json document. */
async function openScenarioPanel(jsonDoc, scenarioPanels) {
  const key = jsonDoc.uri.toString();
  let entry = scenarioPanels.get(key);

  if (entry) {
    entry.panel.reveal(vscode.ViewColumn.Active);
  } else {
    // Only one scenario at a time — reveal the running one instead of starting
    // a second (this command is also hidden from the UI while one runs).
    if (runningScenarioPanel) {
      vscode.window.showWarningMessage(
        "rockDemo: a scenario is already running — stop it first"
      );
      runningScenarioPanel.reveal(vscode.ViewColumn.Active);
      return;
    }

    let scenario;
    try {
      scenario = JSON.parse(jsonDoc.getText());
    } catch (err) {
      vscode.window.showErrorMessage(`rockDemo: invalid scenario JSON (${err})`);
      return;
    }

    // Open as a new tab in the active editor group (not a side-by-side split).
    const panel = vscode.window.createWebviewPanel(
      "rockdemo.scenario",
      "Demo: " + (scenario.title || "scenario"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: mediaRoots(),
      }
    );
    const nodes = resolveNodes(scenario);
    const assets = (scenario.details && scenario.details.assets) || null;
    const baseFsPath = vscode.Uri.joinPath(jsonDoc.uri, "..").fsPath;
    entry = {
      panel,
      doc: jsonDoc,
      scenario,
      nodes,
      assets,
      baseFsPath,
      terminals: [],
      bgDone: new Set(),
      fgDone: new Set(),
    };
    scenarioPanels.set(key, entry);
    trackActivePanel(panel);
    setScenarioRunning(panel); // hides PLAY / shows STOP everywhere

    panel.webview.onDidReceiveMessage(makeMessageHandler(entry));

    // Closing the player tears down all of its container shells too.
    panel.onDidDispose(() => {
      entry.disposed = true; // stop any in-flight background retry loops
      disposeEntryTerminals(entry);
      scenarioPanels.delete(key);
      if (runningScenarioPanel === panel) setScenarioRunning(null);
    });

    // Spin up one container shell per node (staging + mounting their assets)
    // so the terminals are ready while the user reads the intro and clicks
    // START.
    if (nodes.length) {
      startNodes(entry);
    } else {
      vscode.window.showWarningMessage(
        "rockDemo: scenario has no backend / backendExtended.nodes — no container started"
      );
    }
  }

  const data = await buildScenario(entry.doc);
  entry.panel.webview.html = scenarioHtml(data, entry.panel.webview);
}

/** Is this document a rockDemo scenario index.json? */
function isScenarioDoc(doc) {
  return (doc.uri.path.split("/").pop() || "") === "index.json";
}

/**
 * Sweep stale rockDemo Docker resources left by a previous session (e.g. VS Code
 * was closed without stopping the scenario). Scoped strictly to the rockdemo
 * label, so unrelated containers/volumes/networks are never touched. IDs are
 * snapshotted before removal, so a scenario started right now (a different ID)
 * is never caught. Best-effort: any docker error is ignored.
 */
async function cleanupStaleResources() {
  const sweep = async (listArgs, rmArgs) => {
    try {
      const { stdout } = await execFile("docker", listArgs);
      const ids = stdout.split(/\s+/).filter(Boolean);
      if (ids.length) await execFile("docker", [...rmArgs, ...ids]);
    } catch (err) {
      /* docker missing or nothing to remove — ignore */
    }
  };
  const f = ["--filter", "label=rockdemo"];
  // Containers first (frees their volumes/network), then volumes, then network.
  await sweep(["ps", "-aq", ...f], ["rm", "-f", "-v"]);
  await sweep(["volume", "ls", "-q", ...f], ["volume", "rm"]);
  await sweep(["network", "ls", "-q", ...f], ["network", "rm"]);
}

function activate(context) {
  // Remember the install location so webviews can load vendored assets
  // (the bundled syntax highlighter) via webview.asWebviewUri.
  extensionUri = context.extensionUri;

  // Sweep any leftovers from a previous session that didn't shut down cleanly.
  cleanupStaleResources();

  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider(
      { language: "markdown" },
      new ScenarioCodeLensProvider()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("rockdemo.exec", runExec)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("rockdemo.copy", runCopy)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("rockdemo.open", runOpen)
  );

  // Stop button: closes the demo window, which disposes all its associated
  // terminals via onDidDispose. A running scenario takes priority and is
  // stopped even when it isn't the focused tab; otherwise stop the active
  // (markdown demo) panel.
  context.subscriptions.push(
    vscode.commands.registerCommand("rockdemo.stop", () => {
      const target = runningScenarioPanel || activeDemoPanel;
      if (target) target.dispose();
    })
  );

  // Preview ("run demo") mode — markdown demos and JSON scenarios.
  const panels = new Map(); // markdown demo panels
  const scenarioPanels = new Map(); // scenario player panels

  context.subscriptions.push(
    vscode.commands.registerCommand("rockdemo.preview", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("rockDemo: open a scenario first");
        return;
      }
      const doc = editor.document;
      if (isScenarioDoc(doc)) {
        openScenarioPanel(doc, scenarioPanels);
      } else if (doc.languageId === "markdown") {
        openDemoPanel(doc, panels);
      } else {
        vscode.window.showErrorMessage(
          "rockDemo: open a markdown demo or an index.json scenario"
        );
      }
    })
  );

  // Keep open panels in sync as their sources change.
  const refreshDemo = (doc) => {
    const entry = panels.get(doc.uri.toString());
    if (entry) entry.panel.webview.html = demoHtml(doc, entry.panel.webview);
  };
  const refresh = (doc) => {
    refreshDemo(doc);
    // Any save can affect a scenario (its index.json or any step markdown):
    // rebuild every open scenario player.
    for (const entry of scenarioPanels.values()) {
      buildScenario(entry.doc).then((data) => {
        entry.panel.webview.html = scenarioHtml(data, entry.panel.webview);
      });
    }
  };
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(refresh)
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => refreshDemo(e.document))
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
