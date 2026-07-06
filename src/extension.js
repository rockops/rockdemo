const vscode = require("vscode");
const fs = require("fs");
const os = require("os");
const path = require("path");
const execFile = require("util").promisify(require("child_process").execFile);
const { execFileSync } = require("child_process");

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

// The nested-runtime storage roots given a PERSISTENT per-(image,node) cache
// volume, so images pulled by an in-container containerd (kubeadm), Docker
// daemon (DinD) or podman survive teardown and a second run starts warm. The
// suffix keeps the three roots in separate volumes (they're separate data
// stores — never mount one over another).
const NESTED_CACHE_ROOTS = [
  { path: "/var/lib/containerd", tag: "containerd" }, // standalone containerd (kubeadm)
  { path: "/var/lib/docker", tag: "docker" }, // dockerd (Docker-in-Docker)
  { path: "/var/lib/containers", tag: "containers" }, // podman
];

/**
 * Name of a PERSISTENT nested-runtime cache volume for a node. Keyed by
 * (imageid, nodeName, root) so the cache is tied to the BACKEND, not the
 * scenario:
 * - Same image → same cache, so every scenario using a given backend shares one
 *   warm store (the whole point — pull once, reuse forever).
 * - Different images with a colliding node name (e.g. the `ubuntu` and
 *   `ubuntu-systemd` backends both name a node `node1`) get SEPARATE caches, so
 *   their image stores never mix.
 * - The node name keeps a multi-node backend's nodes apart: a 2-node kubeadm
 *   runs two containers off the SAME image at once, and two daemons must never
 *   share one data root (it corrupts the store) — so N nodes → N caches.
 * - `root` (containerd/docker/containers) keeps each runtime's store in its own
 *   volume.
 * Safe because the volume name always contains the node name, and the container
 * name (`rockdemo-<node>`) is a machine-wide mutex — Docker won't run two
 * containers with that name at once (the launch force-removes a stale one) — so
 * at most one daemon ever writes a given cache volume. The volume survives
 * teardown (see startNamedContainer), so a second run starts warm.
 */
function nestedCacheVolumeFor(nodeName, imageid, tag) {
  const safe = (s) => String(s).replace(/[^a-zA-Z0-9_.-]/g, "_");
  return `rockdemo-cache-${safe(imageid)}-${safe(nodeName)}-${tag}`;
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
// Label for the PERSISTENT containerd image-cache volumes. Deliberately a
// DIFFERENT label key (`rockdemo-cache`, not `rockdemo`) so these volumes are
// NOT caught by cleanupStaleResources' `label=rockdemo` sweep — they must
// survive across sessions. The distinct key still lets a future "clear cache"
// command target only these volumes.
const ROCKDEMO_CACHE_LABEL = "rockdemo-cache=1";

// Where the extension's bundled config/ folder is mounted (read-only) inside a
// node that references backend-level scripts, so they run by path in-container.
const CONFIG_MOUNT = "/var/rockdemo/config";

/** Host path of the extension's bundled config/ folder. */
function backendScriptRoot() {
  return path.join(extensionUri.fsPath, "config");
}

/**
 * Resolve a backend script reference (a path relative to config/, e.g.
 * "ubuntu/startup.sh") to its host path and the path it is mounted at inside the
 * container. Returns null if the file is missing on the host.
 */
function resolveBackendScript(ref) {
  if (!ref) return null;
  const hostPath = path.join(backendScriptRoot(), ref);
  try {
    if (!fs.statSync(hostPath).isFile()) return null;
  } catch (err) {
    return null;
  }
  return { hostPath, containerPath: `${CONFIG_MOUNT}/${ref}` };
}

/** Shell snippet that ensures the rockdemo network exists (idempotent). */
function ensureNetworkCmd() {
  return (
    `docker network inspect ${NET_NAME} >/dev/null 2>&1 || ` +
    `docker network create --label ${ROCKDEMO_LABEL} --subnet ${NET_SUBNET} ${NET_NAME} >/dev/null 2>&1; `
  );
}

// Monotonic suffix so concurrent readiness probes never collide on a marker path.
let readyProbeSeq = 0;

/**
 * Send commands to a terminal, but only ONCE its (host) shell is actually reading
 * input. A slow `~/.bashrc` can swallow the first line typed into a freshly
 * created terminal ("eaten input"), so the `docker run` / `docker exec` that
 * launches a node's container is lost and the terminal never starts.
 *
 * The node terminals run their shell on the HOST (the docker CLI is typed into a
 * host shell), and the extension shares that filesystem — so we confirm the shell
 * is live by asking it to create a marker file and polling for it with
 * `fs.existsSync` (no terminal-output reading needed). We probe repeatedly (each
 * probe is a harmless no-op that just truncates the marker) until it round-trips,
 * then send the real commands in order. Best-effort: after a timeout we send
 * anyway, so a shell whose filesystem we can't see is no worse off than before.
 *
 * Fire-and-forget: callers don't await it (the terminal record is returned
 * synchronously; the container-up retry loops elsewhere tolerate the delay).
 */
async function sendAfterReady(term, cmds) {
  const marker = path.join(
    os.tmpdir(),
    `rockdemo-ready-${process.pid}-${readyProbeSeq++}`
  );
  const probe = `: > "${marker}" 2>/dev/null`;
  try {
    // Poll every 200ms (snappy once the shell wakes), but only (re)send the probe
    // every ~2s: the PTY buffers a probe typed during ~/.bashrc and runs it as
    // soon as the prompt is live, so one usually suffices — the resend is just a
    // safety net for input dropped before the shell process even attached. ~20s
    // ceiling, then we fall through and send anyway (best-effort).
    for (let i = 0; i < 100; i++) {
      if (i % 10 === 0) term.sendText(probe, true);
      await delay(200);
      if (fs.existsSync(marker)) break; // shell is live and consuming input
    }
  } catch (err) {
    return; // terminal disposed mid-probe — nothing to send
  }
  try {
    fs.rmSync(marker, { force: true });
  } catch (err) {
    /* best-effort cleanup */
  }
  try {
    for (const c of cmds) term.sendText(c, true);
  } catch (err) {
    /* terminal disposed between the probe and the send — ignore */
  }
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
 * Docker-in-Docker daemon started later). When `systemd` is set the container
 * boots `/sbin/init` as PID 1 (detached) and the interactive shell is attached
 * via `docker exec` — so `systemctl` works inside, matching a real host. When
 * `systemd` is unset the shell itself is PID 1 (lighter: no init, instant
 * start), which is the default for simple scenarios. `location` (optional) is a
 * VS Code terminal `location` — pass `{ parentTerminal }` to split this node's
 * terminal beside another's instead of opening a new tab (see startNodes).
 * Returns a record: { name, terminal, containerName }.
 */
function startNamedContainer(name, imageid, mounts, cmd, ip, useNet, privileged, systemd, ports, location, proxyArgs) {
  const containerName = containerNameFor(name);
  const hostname = hostnameFor(name);
  const shell = cmd || "sh";
  // `location: { parentTerminal }` splits this terminal into the parent's panel
  // group (side-by-side); no location = a new stacked tab (the default).
  const term = vscode.window.createTerminal(
    location ? { name, location } : name
  );
  term.show();
  const vol = (mounts || [])
    .map((m) => `-v "${m.host}:${m.container}${m.ro ? ":ro" : ""}"`)
    .join(" ");
  // Publish each {{TRAFFIC_*}} port to the same host port (-p <port>:<port>) so
  // the placeholder's URL (http://<host>:<port>) reaches the service. A port
  // already taken on the host — or two nodes wanting the same one — makes
  // `docker run` fail loudly, which is the intended, visible behaviour.
  const pub = (ports || []).map((p) => `-p ${p}:${p}`).join(" ");
  // Join the shared network so nodes can reach each other; pin the static IP
  // when one is declared.
  const netEnsure = useNet ? ensureNetworkCmd() : "";
  const netArgs = useNet
    ? `--network ${NET_NAME} ${ip ? `--ip ${ip} ` : ""}`
    : "";
  // Nested container runtimes need --privileged, plus volumes for their storage
  // roots (/var/lib/docker for docker, /var/lib/containers for podman,
  // /var/lib/containerd for a standalone containerd as used by kubeadm) so the
  // inner overlay sits on a real filesystem — stacking overlay-on-overlay
  // otherwise fails with "mount overlay ... invalid argument" and no pod
  // sandbox can ever start. All three are NAMED, PERSISTENT cache volumes
  // (nestedCacheVolumeFor) that survive teardown: --rm and `docker rm -v` only
  // drop ANONYMOUS volumes, so a named one lives on. Each is keyed by (imageid,
  // node, root) so it's shared per BACKEND across scenarios but distinct per node
  // and per runtime — see nestedCacheVolumeFor for why that's correct and safe.
  // So a second run of the same backend starts from a warm image cache whether it
  // uses containerd, Docker or podman. They carry the separate `rockdemo-cache`
  // label so the stale-resource sweep leaves them alone (and the "clear cache"
  // actions target exactly that label). NOTE: /var/lib/{docker,containers} hold a
  // runtime's WHOLE data root — images AND any containers/volumes it creates — so
  // persisting them also carries in-container state across runs; RESTART no
  // longer wipes it (use "clear cache" for a truly clean slate).
  // `--cgroupns=private` gives
  // each node its OWN cgroup namespace, so its kubelet's systemd-driver
  // `kubepods.slice` is scoped under the container instead of at the shared host
  // cgroup root. This is REQUIRED for multi-node kubeadm: with `=host`, every
  // node's kubelet manages the same top-level /sys/fs/cgroup/kubepods.slice, so
  // when a second node joins its kubelet's cgroup reconciliation wipes the first
  // node's pod cgroups (runc then fails with "cgroup.controllers: no such file
  // or directory") and the control plane's pods are torn down and can't restart.
  // Private per-node cgroups is exactly how kind/k3d isolate their nodes.
  // `/lib/modules` is bind-mounted read-only so `modprobe` inside the container
  // finds the host kernel's modules (br_netfilter, overlay, ...) — the modules
  // are global to the shared kernel, this just hands the container the matching
  // .ko files + dep metadata so the raw CNCF kubeadm procedure runs unmodified.
  const priv = privileged
    ? `--privileged --cgroupns=private ` +
      NESTED_CACHE_ROOTS.map(
        (r) =>
          `--mount type=volume,src=${nestedCacheVolumeFor(name, imageid, r.tag)},dst=${r.path},volume-label=${ROCKDEMO_CACHE_LABEL} `
      ).join("") +
      `-v /lib/modules:/lib/modules:ro `
    : "";
  // Drop any stale container with this name first (e.g. after a hard restart),
  // then run a fresh one with the configured command (defaults to `sh`).
  // `--hostname` makes the node name show up in the shell prompt; `--label`
  // marks it for the startup sweep.
  //
  // systemd mode: PID 1 must be `/sbin/init`, so we can't attach the shell to
  // `docker run`. Instead run the container detached booting systemd, then
  // attach the interactive shell with `docker exec`. On exit the container
  // keeps running (systemd is PID 1); teardown's `docker rm -f` cleans it up.
  // `--tmpfs /run /run/lock` give systemd writable runtime dirs without
  // persisting them. Non-systemd mode is unchanged: the shell is PID 1.
  // Forward the host's HTTP(S)_PROXY / NO_PROXY into the container (empty when
  // no proxy is set on the host) so image pulls and in-scenario network calls
  // work behind a corporate proxy. See proxyEnvArgs.
  const proxy = proxyArgs ? `${proxyArgs} ` : "";
  const runArgs =
    `--label ${ROCKDEMO_LABEL} --name ${containerName} --hostname ${hostname} ` +
    `${priv}${netArgs}${pub ? pub + " " : ""}${proxy}${vol} ${imageid}`;
  const launch = systemd
    ? `docker run -d --rm --tmpfs /run --tmpfs /run/lock ${runArgs} /sbin/init >/dev/null 2>&1 && ` +
      `docker exec -it ${containerName} ${shell}`
    : `docker run -it --rm ${runArgs} ${shell}`;
  // Pull the node image up-front and VISIBLY, so a long first-time pull shows its
  // progress in the terminal instead of the user staring at a blank screen (the
  // detached systemd run hides it entirely, and the interactive run's pull gets
  // wiped by the `clear` below). `docker image inspect` short-circuits when the
  // image is already cached, so warm restarts still start instantly and offline
  // — only a genuinely missing image hits the network. On failure we still fall
  // through to `docker run`, which surfaces the same error.
  const ensureImage =
    `docker image inspect ${imageid} >/dev/null 2>&1 || docker pull ${imageid}; `;
  const launchLine = (
    netEnsure +
    // `-v` drops the container's ANONYMOUS volumes on removal, so a stale
    // container left by a previous session doesn't orphan any. The NAMED
    // nested-runtime cache volumes (/var/lib/{containerd,docker,containers})
    // are deliberately NOT dropped by `-v` (named volumes survive it) — they
    // persist as the warm image cache across runs.
    `docker rm -f -v ${containerName} >/dev/null 2>&1; ` +
    ensureImage +
    launch
  ).replace(/\s+/g, " ");
  // Wait for the host shell to be ready before typing the launch (a slow
  // ~/.bashrc otherwise swallows it — see sendAfterReady), then send it followed
  // by `clear`. The image pull above runs (and is watched) BEFORE the container
  // shell comes up; the buffered `clear` is only read once that shell is ready,
  // so it tidies the screen after startup without hiding the pull progress. The
  // returned `ready` promise resolves once the launch line has been typed, so
  // startup commands that share this terminal (the intro/backend foreground)
  // can wait and never get typed AHEAD of the launch on a slow-shell machine.
  const rec = { name, terminal: term, containerName, mounts: mounts || [] };
  rec.ready = sendAfterReady(term, [launchLine, "clear"]);
  return rec;
}

// Default backend profiles bundled with the extension (config/backends.json):
// a map of Killercoda-style `backend.imageid` keys -> a backendExtended-shaped
// { nodes: [ { name, imageid, ... } ] } (ordered list). Loaded once and cached.
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

/**
 * Normalize a backend's `nodes` into an ordered node list. The canonical form is
 * an **ordered list** of `{ name, ... }` — order matters because it defines the
 * implicit positional aliases `host1`/`host01`, `host2`/`host02`, … A legacy
 * `{ name: {...} }` **map** is still accepted (its key becomes `name`), but a map
 * has no guaranteed order, so the list form is preferred.
 */
function nodesFromConfig(nodes, layout) {
  const list = Array.isArray(nodes)
    ? nodes
    : Object.keys(nodes || {}).map((name) => ({ name, ...nodes[name] }));
  return list.map((n, i) => ({
    name: n.name,
    alias: n.alias || null,
    imageid: n.imageid,
    cmd: n.cmd,
    ip: n.ip,
    docker: !!n.docker,
    systemd: !!n.systemd,
    background: n.background || null,
    foreground: n.foreground || null,
    // Terminal layout: "split" opens this node's terminal side-by-side with the
    // previous node's (in the same panel group) instead of as its own stacked
    // tab (the default). The `layout: "split"` shorthand sets it on every node
    // after the first; otherwise honour the per-node `split` flag. The first
    // node can never split — there's nothing before it to split beside.
    split: i > 0 && (layout === "split" || !!n.split),
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
  if (ext && ext.nodes) return nodesFromConfig(ext.nodes, ext.layout);

  const key = scenario.backend && scenario.backend.imageid;
  if (key) {
    const backends = loadBackends();
    const profile = backends[key];
    if (profile && profile.nodes) return nodesFromConfig(profile.nodes, profile.layout);
    vscode.window.showWarningMessage(
      `rockDemo: unknown backend "${key}" — not a default profile ` +
        `(${Object.keys(backends).join(", ") || "none"}). ` +
        `Define it in backendExtended for a custom backend.`
    );
  }
  return [];
}

/** Normalize a `noProxy` config value (array or comma-string) to a clean array. */
function noProxyList(v) {
  if (!v) return [];
  const parts = Array.isArray(v) ? v : String(v).split(",");
  return parts.map((s) => String(s).trim()).filter(Boolean);
}

/**
 * Resolve the extra `noProxy` entries (IPs/CIDRs/hostnames) for a scenario's
 * backend — the destinations that should bypass the host proxy inside the
 * containers. Read from `backendExtended.noProxy` for a custom backend, or the
 * matching bundled profile's `noProxy` for a `backend.imageid` key. The
 * Kubernetes profiles carry the pod and service CIDRs here so cluster-internal
 * traffic never goes through the proxy. See proxyEnvArgs.
 */
function resolveNoProxy(scenario) {
  const ext = scenario.backendExtended;
  if (ext && ext.nodes) return noProxyList(ext.noProxy);
  const key = scenario.backend && scenario.backend.imageid;
  if (key) {
    const profile = loadBackends()[key];
    if (profile) return noProxyList(profile.noProxy);
  }
  return [];
}

/**
 * Build `docker run` env args that forward the host's HTTP(S) proxy settings into
 * a container. Reads HTTP_PROXY / HTTPS_PROXY / NO_PROXY (and their lowercase
 * variants) from the host environment and re-exports BOTH the upper- and
 * lowercase forms, so tools that only honour one convention still see the proxy.
 * `noProxyExtra` (from the backend config — e.g. a Kubernetes backend's pod and
 * service CIDRs) is merged into NO_PROXY so intra-cluster traffic bypasses the
 * proxy. Returns a string of `-e` args (or "" when the host has no proxy set).
 */
function proxyEnvArgs(noProxyExtra) {
  const env = process.env;
  const http = env.HTTP_PROXY || env.http_proxy;
  const https = env.HTTPS_PROXY || env.https_proxy;
  // Nothing to forward when the host has no proxy configured.
  if (!http && !https) return "";
  // Start from the host's existing NO_PROXY, then APPEND the backend config's
  // entries after it (never replacing the host value); de-dup while preserving
  // that order so a value set on both sides isn't listed twice.
  const noProxy = [
    ...noProxyList(env.NO_PROXY || env.no_proxy),
    ...(noProxyExtra || []).flatMap((v) => noProxyList(v)),
  ]
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(",");
  const pairs = [];
  if (http) pairs.push(["HTTP_PROXY", http], ["http_proxy", http]);
  if (https) pairs.push(["HTTPS_PROXY", https], ["https_proxy", https]);
  if (noProxy) pairs.push(["NO_PROXY", noProxy], ["no_proxy", noProxy]);
  return pairs.map(([k, v]) => `-e ${k}="${v}"`).join(" ");
}

/** Launch a container terminal for every node, storing the records on entry. */
function startNodes(entry) {
  // Fresh scratch copies for this run: wipe, then stage per node and mount.
  entry.bgDone = new Set(); // re-arm background scripts for this run
  entry.fgDone = new Set(); // re-arm foreground scripts for this run
  entry.fgPending = new Map(); // re-arm the per-screen foreground gates
  // Which ports each node must publish to the host, from {{TRAFFIC_*}} tokens.
  entry.trafficPorts = collectTrafficPorts(entry);
  // Which script files each node invokes by name (need an executable overlay).
  entry.scriptFiles = collectScriptFiles(entry);
  if (entry.baseFsPath) wipeRunDir(entry.baseFsPath, firstNodeImage(entry));
  // Warn about asset blocks keyed to a node that doesn't exist — otherwise the
  // assets silently never stage (a recurring "no files in the container" trap,
  // e.g. an "host01" key when the backend node is "node1").
  if (entry.assets) {
    // A key is valid if it matches a node's real name OR its alias.
    const orphans = Object.keys(entry.assets).filter(
      (k) => !entry.nodes.some((n, idx) => nodeMatches(n, idx, k))
    );
    if (orphans.length) {
      const available = entry.nodes
        .map((n) => (n.alias ? `${n.name} (alias ${n.alias})` : n.name))
        .join(", ");
      vscode.window.showWarningMessage(
        `rockDemo: assets for ${orphans.map((o) => `"${o}"`).join(", ")} ` +
          `won't be copied — no such node. Available nodes: ` +
          `${available || "none"}.`
      );
    }
  }
  // If any node declares a static IP, every node joins the shared rockdemo
  // network so they can communicate (those with an `ip` get pinned addresses).
  const useNet = entry.nodes.some((n) => n.ip);
  // Forward any host proxy into every node, merging the backend's `noProxy`
  // (e.g. Kubernetes pod/service CIDRs) so cluster-internal traffic bypasses it.
  const proxyArgs = proxyEnvArgs(entry.noProxy);
  // Terminal grouping: a node with `split` opens beside the current group's
  // anchor terminal (side-by-side); a node without one starts a fresh group and
  // becomes the new anchor. Tracked across the ordered launch below.
  let groupAnchor = null;
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
      // When the node references backend-level scripts (background/foreground),
      // mount the extension's bundled config/ folder read-only so those scripts
      // are available in the container at CONFIG_MOUNT and run by path.
      if (n.background || n.foreground) {
        mounts.unshift({ host: backendScriptRoot(), container: CONFIG_MOUNT, ro: true });
      }
      // Overlay executable copies of any scripts this node invokes by name, so a
      // non-executable source script still runs (without touching the source).
      mounts.push(...stageNodeScripts(entry, n));
      const ports = entry.trafficPorts.get(n.name) || [];
      // Split beside the current anchor only if there is one; otherwise this
      // node opens a new tab and becomes the anchor for any following splits.
      const split = n.split && groupAnchor;
      const location = split ? { parentTerminal: groupAnchor } : undefined;
      const rec = startNamedContainer(
        n.name, n.imageid, mounts, n.cmd, n.ip, useNet, n.docker, n.systemd, ports, location, proxyArgs
      );
      if (!split) groupAnchor = rec.terminal;
      return rec;
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
  // systemd nodes manage dockerd via their own docker.service — hand-starting a
  // second daemon here would race the same socket, so skip them.
  const dindNodes = (entry.nodes || []).filter((n) => n.docker && !n.systemd);
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
  // Fire-and-forget: onDidDispose callers don't await teardown.
  removeEntryContainers(entry);
}

/**
 * Dispose the entry's terminals and force-remove their containers, returning a
 * promise that resolves once every `docker rm` has settled. Callers that need to
 * act *after* the containers are gone — notably clearing the persistent cache
 * volumes, which stay in use until their container is removed — await this.
 */
function removeEntryContainers(entry) {
  const removals = [];
  if (entry.terminals) {
    for (const rec of entry.terminals) {
      rec.terminal.dispose();
      if (rec.containerName) {
        // Force-remove the container. A "No such container" error means it was
        // already gone (fine) — but ANY other failure (docker not on the
        // extension-host PATH, daemon unreachable, permission denied) would
        // otherwise be swallowed and leave the container running after Stop, so
        // surface those loudly instead of hiding them.
        removals.push(
          execFile("docker", ["rm", "-f", "-v", rec.containerName]).catch((err) => {
            const msg = String((err && err.stderr) || (err && err.message) || err);
            if (/No such container/i.test(msg)) return; // already gone — expected
            console.error(`rockDemo: failed to remove ${rec.containerName}:`, msg);
            vscode.window.showErrorMessage(
              `rockDemo: could not remove container ${rec.containerName} — ` +
                `it may still be running. ${msg}`
            );
          })
        );
      }
    }
  }
  entry.terminals = [];
  // Delete the staged asset copies — they're scratch, no post-mortem needed.
  if (entry.baseFsPath) wipeRunDir(entry.baseFsPath, firstNodeImage(entry));
  return Promise.all(removals);
}

/** The first node's image (cached, so the cleanup container needs no pull). */
function firstNodeImage(entry) {
  const n = (entry.nodes || []).find((x) => x.imageid);
  return n ? n.imageid : null;
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

// The running scenario's panel entry (nodes + terminals), so the "new terminal
// on node" action can target its containers. Set/cleared with the panel below.
let runningScenarioEntry = null;

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

/**
 * Remove a scenario's entire scratch dir (best-effort). A privileged container
 * runs as root and may have written **root-owned** files into the bind-mounted
 * scratch copy (e.g. /root/.kube, /root/.ssh), which the host user can't delete
 * — so a plain rmSync leaves `.rockdemo-run` behind. When that happens, fall
 * back to deleting it from inside a throwaway container, where the process is
 * root (the Docker daemon runs as root). Reuses the node's own image so there's
 * nothing extra to pull; `image` is optional and defaults to alpine.
 */
function wipeRunDir(baseFsPath, image) {
  const runDir = path.join(baseFsPath, RUN_DIR);
  try {
    fs.rmSync(runDir, { recursive: true, force: true });
  } catch (err) {
    /* likely root-owned files — handled by the container fallback below */
  }
  if (!fs.existsSync(runDir)) return; // gone — host could delete it
  try {
    // Run `rm -rf` as root in a container, with the scenario dir bind-mounted.
    execFileSync(
      "docker",
      [
        "run", "--rm", "--label", ROCKDEMO_LABEL,
        "-v", `${baseFsPath}:/scratch`,
        image || "alpine",
        "rm", "-rf", `/scratch/${RUN_DIR}`,
      ],
      { stdio: "ignore", timeout: 60000 }
    );
  } catch (err) {
    /* docker missing / offline — leave the dir rather than fail teardown */
  }
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compile one path segment to a regex body: `*` → any run of non-slash. */
function segToRegExp(seg) {
  return seg.split("*").map(escapeRegExp).join("[^/]*");
}

/**
 * Compile an asset glob to an anchored regex matched against paths relative to
 * the assets root. `*` matches within a single segment; a `**` segment matches
 * any number of segments (recursive, including zero).
 */
function globToRegExp(pattern) {
  const segs = pattern.split("/");
  let re = "^";
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === "**") {
      // Trailing globstar matches everything below; an interior globstar
      // matches zero or more directory levels.
      re += last ? ".*" : "(?:[^/]*/)*";
    } else {
      re += segToRegExp(seg);
      if (!last) re += "/";
    }
  });
  return new RegExp(re + "$");
}

/**
 * Normalize an asset `target` to an absolute container path. Docker requires
 * the mount destination to be absolute, so a leading `~` (the example's `~/`)
 * is expanded to root's home (`/root` — the user these images run as).
 */
function normalizeContainerPath(target) {
  if (target === "~" || target === "~/") return "/root";
  if (target.startsWith("~/")) return "/root/" + target.slice(2);
  return target;
}

/** Recursively list every file under `dirAbs`, as paths relative to it. */
function listFiles(dirAbs) {
  const out = [];
  const walk = (d, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch (err) {
      return;
    }
    for (const e of entries) {
      const r = rel ? rel + "/" + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else out.push(r);
    }
  };
  walk(dirAbs, "");
  return out;
}

/**
 * Expand an asset `file` pattern into matching **file** paths (never folders)
 * relative to `rootDir` (the scenario's assets/ dir). Supports `*` (one
 * segment) and `**` (recursive). Matching only files mirrors Killercoda: a
 * final `*` means "the files here" — folders are crossed by earlier path
 * segments (like an "app*" segment) or by a globstar, never copied as a unit.
 */
function expandGlob(rootDir, pattern) {
  const clean = pattern.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  if (!clean) return [];
  const rx = globToRegExp(clean);
  return listFiles(rootDir)
    .filter((rel) => rx.test(rel))
    .sort();
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

/** First whitespace-separated token of a command, with a leading "./" stripped. */
function firstScriptToken(value) {
  return String(value || "").trim().split(/\s+/)[0].replace(/^\.\//, "");
}

/** Absolute path of `rel` if it resolves to a file inside the scenario, else null. */
function fileWithin(baseFsPath, rel) {
  if (!baseFsPath || !rel) return null;
  let abs;
  try {
    abs = path.resolve(baseFsPath, rel);
  } catch (err) {
    return null;
  }
  const root = path.resolve(baseFsPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null; // stay inside
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch (err) {
    return null;
  }
}

/**
 * A foreground/background/verify value may invoke a script *file* by name
 * (possibly with arguments, e.g. "verify.sh --flag"), so its execute bit
 * matters — but authors often forget `chmod +x`, and the scenario is mounted
 * read-only so the container can't fix it. We must not touch the source file
 * either. Returns the script's path relative to the scenario for such values,
 * or null when the first token isn't a scenario file (e.g. "sh x.sh" or
 * "kubectl get pods" — nothing to make executable). Used to stage an executable
 * copy of the script and bind-mount it back over /scenario (see stageNodeScripts).
 */
function invokedScriptRel(baseFsPath, value) {
  const tok = firstScriptToken(value);
  return fileWithin(baseFsPath, tok) ? tok : null;
}

/**
 * Every name a node answers to, lowercased for case-insensitive matching:
 *  - its real name (e.g. "controlplane"),
 *  - its optional `alias` (e.g. "node1"),
 *  - the implicit Killercoda-style positional aliases `hostN` and `host0N`,
 *    where N is the node's 1-based position among the backend's nodes.
 * So the same scenario JSON targets a node across backends with different node
 * names — `host1`, `HOST01`, an alias, or the real name all resolve.
 */
function nodeRefs(node, index) {
  const n = index + 1;
  const refs = [node.name];
  if (node.alias) refs.push(node.alias);
  refs.push(`host${n}`, `host${String(n).padStart(2, "0")}`);
  return refs.map((r) => String(r).toLowerCase());
}

/** Does node #index answer to `ref` (name / alias / implicit hostN / host0N)? */
function nodeMatches(node, index, ref) {
  return nodeRefs(node, index).includes(String(ref).toLowerCase());
}

/** Find the node a scenario reference points to (or null). */
function findNode(entry, ref) {
  const nodes = entry.nodes || [];
  const i = nodes.findIndex((n, idx) => nodeMatches(n, idx, ref));
  return i === -1 ? null : nodes[i];
}

/**
 * Pick the target node terminal record for a background command: the named
 * `host` if given (matched by name / alias / implicit hostN), otherwise the
 * first node (works for both backendExtended and the single `backend`).
 */
function pickHost(entry, host) {
  const recs = entry.terminals || [];
  if (host) {
    const node = findNode(entry, host);
    return node ? recs.find((r) => r.name === node.name) || null : null;
  }
  return recs[0] || null;
}

// Killercoda-style traffic placeholder: `{{TRAFFIC_<host>_<port>}}` in scenario
// markdown becomes a URL that reaches <port> on the named node. <host> is a node
// ref (name / alias / implicit hostN); <port> is any port number. The host token
// excludes `{`/`}`/`_` so adjacent placeholders on a line never merge.
const TRAFFIC_RE = /\{\{TRAFFIC_([A-Za-z0-9.-]+)_(\d+)\}\}/g;

/**
 * Scan a scenario's intro/step/finish markdown for `{{TRAFFIC_<host>_<port>}}`
 * placeholders and return a map of node name -> sorted unique port list, so each
 * node's container can publish exactly the ports its scenario references. Reads
 * the markdown straight off disk (sync) — this runs before the containers launch.
 */
function collectTrafficPorts(entry) {
  const byNode = new Map();
  if (!entry.baseFsPath) return byNode;
  const details = (entry.scenario && entry.scenario.details) || {};
  const rels = [];
  if (details.intro && details.intro.text) rels.push(details.intro.text);
  for (const s of details.steps || []) if (s.text) rels.push(s.text);
  if (details.finish && details.finish.text) rels.push(details.finish.text);

  for (const rel of rels) {
    let text;
    try {
      text = fs.readFileSync(path.join(entry.baseFsPath, rel), "utf8");
    } catch (err) {
      continue; // missing step file — buildScenario already surfaces that
    }
    let m;
    TRAFFIC_RE.lastIndex = 0;
    while ((m = TRAFFIC_RE.exec(text))) {
      const node = findNode(entry, m[1]);
      const port = Number(m[2]);
      if (!node || !port) continue;
      if (!byNode.has(node.name)) byNode.set(node.name, new Set());
      byNode.get(node.name).add(port);
    }
  }
  // Freeze each node's set into a sorted number array.
  const out = new Map();
  for (const [name, set] of byNode) out.set(name, [...set].sort((a, b) => a - b));
  return out;
}

/** Resolve a step's `host` to a node (by name/alias/implicit), else the first node. */
function nodeForHost(entry, host) {
  if (host) return findNode(entry, host);
  return (entry.nodes || [])[0] || null;
}

/**
 * Pre-scan the scenario's intro/step commands for script *files* invoked by name
 * (so they need an executable overlay — see stageNodeScripts) and map each to its
 * target node. foreground/verify always invoke by name; `background` only does so
 * in the "script.sh args" form (a bare file is run by inlining its contents, so
 * it needs no execute bit). Returns Map<nodeName, relpath[]> (deduped).
 */
function collectScriptFiles(entry) {
  const byNode = new Map();
  if (!entry.baseFsPath) return byNode;
  const base = entry.baseFsPath;
  const details = (entry.scenario && entry.scenario.details) || {};
  const screens = [];
  if (details.intro) screens.push(details.intro);
  for (const s of details.steps || []) screens.push(s);

  const add = (name, rel) => {
    if (!byNode.has(name)) byNode.set(name, new Set());
    byNode.get(name).add(rel);
  };
  for (const cfg of screens) {
    const node = nodeForHost(entry, cfg.host);
    if (!node) continue;
    for (const field of ["foreground", "verify"]) {
      const rel = invokedScriptRel(base, cfg[field]);
      if (rel) add(node.name, rel);
    }
    // background: a bare file is inlined (no exec bit needed); only "file args"
    // is invoked by name.
    if (cfg.background && !fileWithin(base, String(cfg.background).trim())) {
      const rel = invokedScriptRel(base, cfg.background);
      if (rel) add(node.name, rel);
    }
  }
  const out = new Map();
  for (const [name, set] of byNode) out.set(name, [...set]);
  return out;
}

/**
 * Replace `{{TRAFFIC_<host>_<port>}}` placeholders in a markdown body with a
 * working URL: `http://<host machine hostname>:<port>`. The hostname is the
 * host running rockDemo (os.hostname(), i.e. the `hostname` command) — not the
 * container — because the published port is reachable there. Each referenced
 * port is published from the node with `-p <port>:<port>` (see startNodes), so
 * the host port equals the placeholder's port. Tokens whose host doesn't resolve
 * to a node are left untouched.
 */
function substituteTraffic(md, entry) {
  const hostname = os.hostname();
  return md.replace(TRAFFIC_RE, (whole, ref, port) => {
    const node = findNode(entry, ref);
    return node ? `http://${hostname}:${port}` : whole;
  });
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

  const scenarioName = path.basename(entry.baseFsPath);
  const label = stepId === "intro" ? "intro" : String(Number(stepId) + 1);
  const logDir = `/var/log/rockdemo/${scenarioName}`;
  const logFile = `${logDir}/${label}_background.log`;
  // A subshell groups the script; redirection captures its output to the log
  // file inside the container. `docker exec -d` detaches.
  const wholeFile = fileWithin(entry.baseFsPath, String(cfg.background).trim());
  let body;
  if (wholeFile) {
    // The whole value is a script file: inline its contents, so it runs even
    // without a shebang or an execute bit (the long-standing behaviour).
    body = `( ${fs.readFileSync(wholeFile, "utf8")}\n)`;
  } else if (fileWithin(entry.baseFsPath, firstScriptToken(cfg.background))) {
    // "script.sh args": run from /scenario (with "." on PATH) so the script —
    // now executable — is found and run via its shebang.
    body = `( cd /scenario && export PATH=".:$PATH"; ${cfg.background} )`;
  } else {
    // A plain shell command.
    body = `( ${cfg.background}\n)`;
  }
  const wrapped = `mkdir -p ${logDir}; ${body} > ${logFile} 2>&1`;

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
async function runForeground(entry, stepId) {
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
    fgUngate(entry, stepId, "self");
    return;
  }

  // The command runs visibly in the terminal and blocks it until done, but the
  // terminal gives us no completion signal — so the command `touch`es a marker
  // when it finishes, which we poll for to un-gate NEXT.
  const marker = `/tmp/.rockdemo-fg-${stepId}`;
  if (!entry.fgDone) entry.fgDone = new Set();
  if (!entry.fgDone.has(stepId)) {
    entry.fgDone.add(stepId);
    fgGate(entry, stepId, "self");
    // Wait until the node's launch line has been typed (see startNamedContainer)
    // so this command lands in the CONTAINER shell, never ahead of `docker run`
    // in the host shell on a slow-startup machine.
    if (rec.ready) await rec.ready;
    if (entry.disposed) return;
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
  pollForegroundDone(entry, rec, marker, stepId, "self");
}

/**
 * Run each node's backend-level `background` script (from a backends.json
 * profile or `backendExtended`) detached in that node's own container, once per
 * run. Like the intro/step background, but the command and target node come
 * from the node config itself — so it fires automatically when the env starts.
 */
async function runBackendBackground(entry) {
  for (const node of entry.nodes || []) {
    if (!node.background) continue;
    const key = "backend:" + node.name;
    if (!entry.bgDone) entry.bgDone = new Set();
    if (entry.bgDone.has(key)) continue; // already launched this run
    entry.bgDone.add(key);

    const rec = (entry.terminals || []).find((r) => r.name === node.name);
    if (!rec) continue;

    const script = resolveBackendScript(node.background);
    if (!script) {
      vscode.window.showWarningMessage(
        `rockDemo: backend background script not found: config/${node.background}`
      );
      continue;
    }
    const scenarioName = entry.baseFsPath ? path.basename(entry.baseFsPath) : "scenario";
    const logDir = `/var/log/rockdemo/${scenarioName}`;
    const logFile = `${logDir}/${node.name}_backend_background.log`;
    // The script is mounted read-only at CONFIG_MOUNT — run it by path, logging
    // its output to a file inside the container.
    const wrapped = `mkdir -p ${logDir}; sh ${script.containerPath} > ${logFile} 2>&1`;
    // Retry until the container is up (its terminal may still be pulling).
    for (let i = 0; i < 120; i++) {
      if (entry.disposed) return;
      try {
        await execFile("docker", ["exec", "-d", rec.containerName, "sh", "-c", wrapped]);
        break;
      } catch (err) {
        await delay(1000);
      }
    }
  }
}

/**
 * Run each node's backend-level `foreground` script in that node's terminal
 * (once per run), visible and blocking like the intro/step foreground, and gate
 * the intro START button until every one finishes. The script is mounted
 * read-only at CONFIG_MOUNT and run by path; a marker file signals completion,
 * polled hidden via `docker exec`.
 */
async function runBackendForeground(entry) {
  for (const node of entry.nodes || []) {
    if (!node.foreground) continue;
    const rec = (entry.terminals || []).find((r) => r.name === node.name);
    if (!rec) continue;

    const script = resolveBackendScript(node.foreground);
    const marker = `/tmp/.rockdemo-fg-backend-${node.name}`;
    const sendKey = "backend:" + node.name;
    const token = "node:" + node.name;
    if (!entry.fgDone) entry.fgDone = new Set();

    // A missing script must still release the START gate (the rendered button is
    // gated whenever a node declares a foreground), or START stays stuck. Warn
    // once, then un-gate on every enter so a save-rebuild can't re-stick it.
    if (!script) {
      if (!entry.fgDone.has(sendKey)) {
        entry.fgDone.add(sendKey);
        vscode.window.showWarningMessage(
          `rockDemo: backend foreground script not found: config/${node.foreground}`
        );
      }
      fgUngate(entry, "intro", token);
      continue;
    }

    if (!entry.fgDone.has(sendKey)) {
      entry.fgDone.add(sendKey);
      fgGate(entry, "intro", token);
      // Wait for the launch line to be typed first (see startNamedContainer), so
      // this script runs in the container shell rather than ahead of `docker run`
      // in the host shell on a slow-startup machine.
      if (rec.ready) await rec.ready;
      if (entry.disposed) return;
      rec.terminal.show(true);
      rec.terminal.sendText(
        `rm -f ${marker}; ( sh ${script.containerPath} ); touch ${marker}`,
        true
      );
    }
    // Safe to (re)poll on every intro enter (e.g. after a save rebuild).
    pollForegroundDone(entry, rec, marker, "intro", token);
  }
}

/**
 * Register a pending foreground for a screen ("intro" or a step index). A screen
 * may be gated by several foregrounds at once — its own intro/step command and
 * any backend node commands — so each is tracked by a distinct token and the
 * button is only un-gated once they all complete.
 */
function fgGate(entry, screen, token) {
  if (!entry.fgPending) entry.fgPending = new Map();
  let set = entry.fgPending.get(screen);
  if (!set) {
    set = new Set();
    entry.fgPending.set(screen, set);
  }
  set.add(token);
}

/** Mark one pending foreground done; un-gate the screen once none remain. */
function fgUngate(entry, screen, token) {
  const set = entry.fgPending && entry.fgPending.get(screen);
  if (set) set.delete(token);
  if (!set || set.size === 0) postForegroundDone(entry, screen);
}

/** Tell the webview a screen's foreground commands have finished (enables NEXT). */
function postForegroundDone(entry, stepId) {
  if (!entry.disposed && entry.panel) {
    entry.panel.webview.postMessage({ type: "foregroundDone", step: stepId });
  }
}

/**
 * Poll (hidden, via `docker exec`) for the foreground completion marker and,
 * once present, mark this foreground's `token` done on its `screen`. Fails open:
 * if the container has no name, or after a long timeout, the token is released
 * anyway so the user is never permanently stuck.
 */
async function pollForegroundDone(entry, rec, marker, screen, token) {
  if (!rec.containerName) return fgUngate(entry, screen, token);
  for (let i = 0; i < 600; i++) {
    if (entry.disposed) return;
    try {
      await execFile("docker", ["exec", rec.containerName, "test", "-f", marker]);
      return fgUngate(entry, screen, token); // marker exists → finished
    } catch (err) {
      await delay(1000); // not yet — keep waiting
    }
  }
  fgUngate(entry, screen, token); // safety un-gate after timeout
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
 * Stage one asset rule's matched files into `scratchDir`. A **wildcard** pattern
 * keeps each file's full path relative to the assets root (Killercoda keeps the
 * whole matched path under `target`, e.g. `app1/**` → `target/app1/...`). A
 * **literal single-file** pattern (no `*`) drops the directory and uses just the
 * basename (e.g. `app1/readme.md` → `target/readme.md`). `expandGlob` only ever
 * returns files. Returns the number staged (0 if nothing matched). `+x` marks
 * the staged copy executable; originals are never touched.
 */
function stageRuleInto(assetsRoot, scratchDir, nodeName, rule) {
  const files = expandGlob(assetsRoot, rule.file);
  if (!files.length) {
    vscode.window.showWarningMessage(
      `rockDemo: no files match "${rule.file}" for node "${nodeName}"`
    );
    return 0;
  }
  const literal = !rule.file.includes("*");
  let n = 0;
  for (const rel of files) {
    const destRel = literal ? path.basename(rel) : rel;
    const dst = path.join(scratchDir, destRel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(assetsRoot, rel), dst);
    if (rule.chmod === "+x") {
      try {
        fs.chmodSync(dst, 0o755);
      } catch (err) {
        /* best-effort — ignore */
      }
    }
    n++;
  }
  return n;
}

/**
 * Stage every asset rule for a node, returning its list of mount descriptors
 * { host, container, ro }. Rules are grouped by `target` so several rules can
 * populate one mounted directory (otherwise same-target mounts would shadow
 * each other). Each group's copy lives under <scenario>/.rockdemo-run/<node>/
 * <idx>/ and is bind-mounted at `target`; the originals are never touched, and
 * a group whose every rule is `+r` becomes a read-only (`:ro`) mount. The
 * `container` (mount point) is also used to reverse-map container paths back to
 * the host copy for {{open}}.
 */
function stageNodeAssets(entry, node) {
  // Assets may be keyed by the node's real name, its alias, or an implicit
  // positional name (host1/host01) — e.g. a scenario targets "node1" while this
  // backend's node is "controlplane".
  const nodeIdx = (entry.nodes || []).indexOf(node);
  let rules = [];
  if (entry.assets) {
    const key = Object.keys(entry.assets).find((k) => nodeMatches(node, nodeIdx, k));
    if (key) rules = entry.assets[key];
  }
  const assetsRoot = path.join(entry.baseFsPath, "assets");
  const safeNode = node.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
  // Group rules by target, preserving first-seen order.
  const byTarget = new Map();
  for (const rule of rules) {
    if (!byTarget.has(rule.target)) byTarget.set(rule.target, []);
    byTarget.get(rule.target).push(rule);
  }
  const mounts = [];
  let idx = 0;
  for (const [target, group] of byTarget) {
    const scratchDir = path.join(entry.baseFsPath, RUN_DIR, safeNode, String(idx++));
    fs.mkdirSync(scratchDir, { recursive: true });
    let staged = 0;
    for (const rule of group) {
      staged += stageRuleInto(assetsRoot, scratchDir, node.name, rule);
    }
    if (!staged) continue;
    const ro = group.every((r) => r.chmod === "+r");
    mounts.push({ host: scratchDir, container: normalizeContainerPath(target), ro });
  }
  return mounts;
}

/**
 * Stage executable copies of the script files a node's intro/step
 * background/foreground/verify commands invoke by name, and bind-mount each copy
 * **back over its own /scenario path**. The scenario itself is mounted read-only
 * and we must not modify the author's source, so we can't just `chmod +x` the
 * original — instead we copy it into the ephemeral .rockdemo-run scratch, mark
 * the *copy* executable, and overlay it. The command still runs from /scenario
 * with the same relative path, now executable, via its own shebang (any
 * interpreter). Returns the overlay mount descriptors.
 */
function stageNodeScripts(entry, node) {
  const rels = (entry.scriptFiles && entry.scriptFiles.get(node.name)) || [];
  if (!rels.length) return [];
  const safeNode = node.name.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const scriptsRoot = path.join(entry.baseFsPath, RUN_DIR, safeNode, "scripts");
  const mounts = [];
  for (const rel of rels) {
    const src = fileWithin(entry.baseFsPath, rel);
    if (!src) continue;
    const dst = path.join(scriptsRoot, rel);
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, fs.statSync(dst).mode | 0o111); // +x on the copy only
    } catch (err) {
      continue; // best-effort — fall back to the read-only original
    }
    // Overlay the executable copy at the script's own path inside /scenario.
    mounts.push({ host: dst, container: `/scenario/${rel}`, ro: true });
  }
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
  buildScenario(entry.doc, entry.nodes).then((data) => {
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

/**
 * Resolve an image `src` for the sandboxed webview. Absolute URLs (http/https/
 * data) and already-webview URIs pass through untouched; a relative/local path
 * is resolved against the rendering base directory (a serialized URI) and
 * converted to a `webview.asWebviewUri` URL so the webview can actually load the
 * file (subject to the img-src CSP + the panel's localResourceRoots). Without
 * this, a `<img src="./foo.png">` points at a path the webview can't reach and
 * renders broken.
 */
function resolveImgSrc(src, baseStr, webview) {
  const s = String(src || "").trim();
  if (!s) return s;
  if (/^(https?:|data:|vscode-webview-resource:|vscode-resource:)/i.test(s)) return s;
  if (!baseStr || !webview) return s;
  try {
    // joinPath normalizes ".."/"." segments, so ../assets/logo.png resolves.
    const target = vscode.Uri.joinPath(vscode.Uri.parse(baseStr), s);
    return webview.asWebviewUri(target).toString();
  } catch (err) {
    return s;
  }
}

/** Rewrite an <img> tag's src attribute to a webview-safe URL (leaves the rest). */
function rewriteImgTag(tag, baseStr, webview) {
  return tag.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)(["'])(.*?)\2/i,
    (_m, pre, q, src) => `${pre}${q}${resolveImgSrc(src, baseStr, webview)}${q}`
  );
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

/**
 * Render a single line of inline markdown (code, bold, italic, links, images,
 * HTML). `baseStr`/`webview` (both optional) let relative image `src` paths be
 * resolved to webview-safe URLs — see resolveImgSrc.
 */
function renderInline(text, baseStr, webview) {
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

  // Markdown images: ![alt](src) → <img>. Stashed so the tag survives escaping,
  // and matched BEFORE links so the trailing [alt](src) isn't taken as a link.
  s = s.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_m, alt, src) =>
      stash(`<img src="${resolveImgSrc(src, baseStr, webview)}" alt="${escapeHtml(alt)}" />`)
  );

  // Allow-listed raw HTML tags pass through verbatim (e.g. <br>, <kbd>, <img>).
  // An <img> has its relative src rewritten to a webview-safe URL first.
  s = s.replace(HTML_TAG_RE, (m, name) => {
    if (!isPassthroughTag(name)) return m;
    return stash(name.toLowerCase() === "img" ? rewriteImgTag(m, baseStr, webview) : m);
  });

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
function renderMarkdownToHtml(text, baseStr, webview) {
  const lines = text.split(/\r?\n/);
  const out = [];
  // Inline renderer bound to this render's base dir + webview, so relative
  // image srcs resolve to webview-safe URLs.
  const ri = (t) => renderInline(t, baseStr, webview);

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
      out.push(`<p>${ri(paragraph.join(" "))}</p>`);
      paragraph = [];
    }
  };

  // Blockquote grouping: consecutive `>` lines become one <blockquote>.
  let quote = [];
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${ri(quote.join(" "))}</blockquote>`);
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
      out.push(`<h${level}>${ri(heading[2])}</h${level}>`);
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
      out.push(`<li>${ri(li[1])}</li>`);
      continue;
    }

    const oli = line.match(/^\s*\d+\.\s+(.*)$/);
    if (oli) {
      flushParagraph();
      flushQuote();
      closeList();
      out.push(`<ul><li>${ri(oli[1])}</li></ul>`);
      continue;
    }

    // A line that is a single allow-listed HTML tag (e.g. <br>, <div ...>,
    // </table>) is emitted raw — no <p> wrapper — so author HTML blocks render
    // as intended instead of being mangled by paragraph/list handling.
    if (isHtmlBlockLine(line.trim())) {
      flushParagraph();
      flushQuote();
      closeList();
      const raw = line.trim();
      // A standalone <img> line bypasses renderInline, so rewrite its relative
      // src to a webview-safe URL here too.
      out.push(/^<img\b/i.test(raw) ? rewriteImgTag(raw, baseStr, webview) : raw);
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
  // DEMO (projection) mode: force the vendored highlight.js light theme (so code
  // blocks stay light even when the presenter's OS/VS Code is dark) by dropping
  // the prefers-color-scheme media guard on the light sheet and muting the dark.
  function forceHljsTheme(light) {
    const dark = document.getElementById("hljs-dark");
    const lite = document.getElementById("hljs-light");
    if (dark) dark.media = light ? "not all" : "(prefers-color-scheme: dark)";
    if (lite) lite.media = light ? "all" : "(prefers-color-scheme: light)";
  }
  const savedState = vscode.getState() || {};
  // Player/terminal font size in px, adjusted by the A− / A+ buttons and kept in
  // webview state. null = leave the stylesheet default (so NORMAL mode is only
  // resized once the user actually asks). The terminal runs ~2px smaller.
  let fontPx = typeof savedState.fontPx === "number" ? savedState.fontPx : null;
  function termFont() { return fontPx == null ? undefined : fontPx - 2; }
  function applyFont() {
    document.body.style.fontSize = fontPx == null ? "" : fontPx + "px";
  }
  function bumpFont(delta) {
    // Anchor the first bump to the mode's default size, then clamp to a sane range.
    const base =
      fontPx == null
        ? document.documentElement.classList.contains("demo") ? 20 : 14
        : fontPx;
    fontPx = Math.max(12, Math.min(44, base + delta));
    applyFont();
    vscode.setState(Object.assign({}, vscode.getState(), { fontPx: fontPx }));
    vscode.postMessage({ nav: "fontSize", termFont: termFont() });
  }
  // Toggle demo styling on the webview, remember it in webview state (so RESTART/
  // reload keep it), and tell the extension to (un)style the terminals to match.
  function setDemo(on) {
    document.documentElement.classList.toggle("demo", on);
    forceHljsTheme(on);
    const toggle = document.getElementById("demo-toggle");
    if (toggle) toggle.textContent = on ? "🖥 EXIT DEMO MODE" : "🖥 DEMO MODE";
    vscode.setState(Object.assign({}, vscode.getState(), { demo: on }));
    vscode.postMessage({ nav: "demoMode", on: on, termFont: termFont() });
  }
  // Restore persisted font + demo state after a reload/RESTART (fresh HTML).
  applyFont();
  if (savedState.demo) setDemo(true);
  // Fire for the initially-active section (the intro) on load.
  const initial = sections.find((s) => s.classList.contains("active"));
  if (initial) enter(initial.dataset.step);
  document.addEventListener("click", (e) => {
    const fontBtn = e.target.closest("button[data-demo-font]");
    if (fontBtn) {
      bumpFont(parseInt(fontBtn.dataset.demoFont, 10) * 2); // 2px per click
      return;
    }
    const demoBtn = e.target.closest("button[data-demo-toggle]");
    if (demoBtn) {
      setDemo(!document.documentElement.classList.contains("demo"));
      return;
    }
    const nav = e.target.closest("button[data-target],button[data-nav]");
    if (nav) {
      if (nav.dataset.nav === "finish") {
        if (document.querySelector('section[data-step="finish"]')) show("finish");
        else vscode.postMessage({ nav: "finish" });
      } else if (nav.dataset.nav === "restart") {
        // The extension relaunches the containers and rebuilds the webview HTML
        // from scratch (resetting every gate), so we don't navigate here.
        vscode.postMessage({ nav: "restart" });
      } else if (nav.dataset.nav === "close" || nav.dataset.nav === "closeClear") {
        vscode.postMessage({ nav: nav.dataset.nav });
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
      // A screen can carry more than one gated button (the intro has both START
      // and DEMO MODE), so un-gate every one — not just the first.
      if (sec) {
        sec.querySelectorAll("button[data-fg-gated]").forEach((btn) => {
          btn.disabled = false;
          btn.removeAttribute("data-fg-gated");
        });
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

/**
 * localResourceRoots for a demo/scenario panel: the vendored media/ folder, the
 * open workspace folders, and the source document's folder plus a few ancestors.
 * The webview may only load local files that live under one of these roots, so a
 * scenario's images — referenced relatively (`./img.png`, `../assets/img.png`,
 * even `../../assets/img.png` from a nested step) — need their containing dirs
 * whitelisted here, or they render broken. Ancestors cover files opened outside
 * any workspace folder.
 */
function resourceRoots(docUri) {
  const roots = mediaRoots();
  for (const f of vscode.workspace.workspaceFolders || []) roots.push(f.uri);
  if (docUri) {
    let dir = vscode.Uri.joinPath(docUri, "..");
    for (let i = 0; i < 4; i++) {
      roots.push(dir);
      dir = vscode.Uri.joinPath(dir, "..");
    }
  }
  return roots;
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
    ? `<link id="hljs-dark" rel="stylesheet" href="${hljsDark}" media="(prefers-color-scheme: dark)" />` +
      `<link id="hljs-light" rel="stylesheet" href="${hljsLight}" media="(prefers-color-scheme: light)" />`
    : "";
  const hljsScript = hljsJs ? `<script nonce="${nonce}" src="${hljsJs}"></script>` : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}'; font-src ${webview.cspSource};" />
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
  /* DEMO (projection) mode. The DEMO MODE button toggles the "demo" class on
     <html> (persisted in webview state so it survives reload/RESTART). It forces
     a light, high-contrast, larger-font look regardless of the user's VS Code
     theme, so a scenario reads well on a projector. Colours are hard-coded (not
     var(--vscode-*)) precisely because a presenter's editor is usually dark. */
  html.demo { background: #e8eaed; }
  html.demo body { color: #1a1a1a; font-size: 20px; line-height: 1.6; max-width: 1100px; }
  html.demo h1, html.demo h2, html.demo h3 { border-bottom-color: #d0d7de; }
  html.demo a { color: #0a58ca; }
  html.demo .lead { color: #333; opacity: 1; }
  html.demo .crumb { color: #57606a; opacity: 1; }
  html.demo code { background: #eff1f4; color: #1a1a1a; }
  html.demo blockquote {
    background: #f0f3f7;
    border-left-color: #c0c8d0;
  }
  html.demo .demo-cmd,
  html.demo .code-snippet { background: #f6f8fa; border-color: #d0d7de; }
  html.demo .code-snippet code:not(.hljs),
  html.demo .code-snippet code.hljs { background: #f6f8fa; color: #1a1a1a; }
  html.demo .code-snippet .code-line.hl { background: #dbe5f0; }
  /* Persistent player controls (font A−/A+ and the DEMO-mode toggle), pinned to
     the top-right of the player on every screen so they work at any time. */
  #demo-controls {
    position: fixed;
    top: .5rem;
    right: .7rem;
    z-index: 10;
    display: flex;
    gap: .3rem;
  }
  #demo-controls button {
    font-size: 12px;
    cursor: pointer;
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: .35em .7em;
    opacity: .85;
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  #demo-controls button[data-demo-font] { font-weight: 600; padding: .35em .55em; }
  #demo-controls button:hover { opacity: 1; }
  html.demo #demo-controls button {
    color: #1a1a1a;
    background: #c3cbd4;
    border-color: #9aa4b0;
    opacity: 1;
  }
  /* Secondary nav buttons (PREV, CLOSE & CLEAR CACHE) — the theme's secondary
     button colours wash out on the light page. Give them a visible grey with a
     border. The coloured buttons (primary, RESTART, CLOSE) are excluded so they
     keep their own styling. */
  html.demo .nav button:not(.primary):not([data-nav="restart"]):not([data-nav="close"]) {
    color: #1a1a1a;
    background: #c3cbd4;
    border: 1px solid #9aa4b0;
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
    renderMarkdownToHtml(document.getText(), baseStr, webview) +
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

// Terminal appearance forced while a scenario runs in DEMO (projection) mode.
// VS Code has no per-terminal theme API, so we temporarily override the relevant
// workspace settings (live-applied to the already-open node terminals) and put
// them back on exit. A light, high-contrast palette + larger font reads on a
// projector, matching the webview's demo styling.
const DEMO_TERMINAL_FONT_SIZE = 18;
const DEMO_TERMINAL_COLORS = {
  "terminal.background": "#e8eaed",
  "terminal.foreground": "#1a1a1a",
  "terminalCursor.foreground": "#1a1a1a",
  "terminal.selectionBackground": "#c8dcf0",
};

/**
 * Apply the DEMO-mode terminal styling, remembering the previous workspace-level
 * values on `entry` so restoreDemoTerminalStyle can put them back exactly (an
 * absent previous value is restored by clearing the override). Idempotent.
 */
async function applyDemoTerminalStyle(entry) {
  if (entry.demoTermApplied) return;
  const cfg = vscode.workspace.getConfiguration();
  const T = vscode.ConfigurationTarget.Workspace;
  try {
    const colorsInsp = cfg.inspect("workbench.colorCustomizations");
    entry.prevColorCustomizations = colorsInsp && colorsInsp.workspaceValue;
    entry.prevTerminalFontSize = (cfg.inspect("terminal.integrated.fontSize") || {})
      .workspaceValue;
    const merged = Object.assign(
      {},
      entry.prevColorCustomizations || {},
      DEMO_TERMINAL_COLORS
    );
    await cfg.update("workbench.colorCustomizations", merged, T);
    const fontSize = entry.demoTermFontSize || DEMO_TERMINAL_FONT_SIZE;
    await cfg.update("terminal.integrated.fontSize", fontSize, T);
    entry.demoTermApplied = true;
  } catch (err) {
    vscode.window.showWarningMessage(
      `rockDemo: could not apply DEMO terminal styling (${err})`
    );
  }
}

/**
 * Live-set the DEMO terminal font size (from the webview's A− / A+ buttons).
 * Remembered on `entry` so it's reused if DEMO styling is re-applied (e.g. after
 * RESTART); the workspace setting is only touched while DEMO styling is active.
 */
async function setDemoTerminalFontSize(entry, px) {
  if (typeof px !== "number") return;
  entry.demoTermFontSize = px;
  if (!entry.demoTermApplied) return;
  try {
    await vscode.workspace
      .getConfiguration()
      .update(
        "terminal.integrated.fontSize",
        px,
        vscode.ConfigurationTarget.Workspace
      );
  } catch (err) {
    /* non-fatal: the webview font still changed */
  }
}

/** Undo applyDemoTerminalStyle, restoring the exact previous workspace values. */
async function restoreDemoTerminalStyle(entry) {
  if (!entry.demoTermApplied) return;
  const cfg = vscode.workspace.getConfiguration();
  const T = vscode.ConfigurationTarget.Workspace;
  entry.demoTermApplied = false; // clear first so a failed restore can't loop
  try {
    await cfg.update("workbench.colorCustomizations", entry.prevColorCustomizations, T);
    await cfg.update("terminal.integrated.fontSize", entry.prevTerminalFontSize, T);
  } catch (err) {
    vscode.window.showWarningMessage(
      `rockDemo: could not restore terminal styling after DEMO (${err})`
    );
  }
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
      // Backend-level scripts are env setup — they must run FIRST, before any
      // intro/step background/foreground. The intro is the "env start" screen,
      // so kick them off here (once per run; both are guarded) ahead of the
      // intro's own scripts. Steps come later (their own enter), and START is
      // gated until the backend foreground finishes, so step scripts can never
      // run before the backend init.
      if (msg.step === "intro") {
        runBackendBackground(entry);
        runBackendForeground(entry);
      }
      runBackground(entry, msg.step);
      runForeground(entry, msg.step);
    }
    else if (msg.nav === "demoMode") {
      if (msg.on) {
        if (typeof msg.termFont === "number") entry.demoTermFontSize = msg.termFont;
        applyDemoTerminalStyle(entry);
      } else restoreDemoTerminalStyle(entry);
    }
    else if (msg.nav === "fontSize") setDemoTerminalFontSize(entry, msg.termFont);
    else if (msg.nav === "verify") runVerify(entry, msg.step);
    else if (msg.nav === "restart") restartScenario(entry);
    else if (msg.nav === "closeClear") endAndClearCache(entry);
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
        localResourceRoots: resourceRoots(document.uri),
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
async function buildScenario(jsonDoc, nodes) {
  const dir = vscode.Uri.joinPath(jsonDoc.uri, "..");
  const scenario = JSON.parse(jsonDoc.getText());
  const details = scenario.details || {};
  // Any node carrying a backend-level foreground gates the intro START button
  // until it finishes (same as an intro foreground does).
  const backendFg = (nodes || []).some((n) => n.foreground);
  // Pseudo-entry for {{TRAFFIC_*}} resolution (findNode only needs `nodes`).
  const ti = { nodes: nodes || [] };
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
      md: substituteTraffic(md, ti),
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
        md: substituteTraffic(await readText(introUri), ti),
        baseStr: vscode.Uri.joinPath(introUri, "..").toString(),
      };
    } catch (err) {
      intro = null;
    }
  }

  let finish = null;
  if (details.finish && details.finish.text) {
    try {
      finish = substituteTraffic(await readText(vscode.Uri.joinPath(dir, details.finish.text)), ti);
    } catch (err) {
      finish = null;
    }
  }

  return { scenario, steps, intro, finish, backendFg, dirStr: dir.toString() };
}

/** Render the whole scenario (intro + steps + optional finish) to HTML. */
function scenarioHtml(data, webview) {
  const { scenario, steps, intro, finish } = data;
  const last = steps.length - 1;
  const sections = [];

  // A scenario may have an intro but no steps (just a "start" screen). Then the
  // intro itself is the terminal screen: it carries the end-screen actions
  // (RESTART / CLOSE) instead of START, and there is no separate finish section
  // to navigate to.
  const noSteps = steps.length === 0;

  // The terminal-screen actions, reused by the end screen and — when there are
  // no steps — by the intro. RESTART rebuilds from scratch; CLOSE ends the
  // scenario (tears down all containers/terminals, like STOP).
  const endActions =
    `<button data-nav="closeClear" title="End the scenario and delete the persistent image cache (next run re-pulls images)">🗑 CLOSE &amp; CLEAR CACHE</button>` +
    `<button class="primary" data-nav="restart">⟲ RESTART</button>` +
    `<button class="primary" data-nav="close">✖ CLOSE</button>`;

  // If the intro has a foreground command, START is disabled until it finishes
  // (foregroundDone), mirroring NEXT gating on steps.
  const introFg =
    !!data.backendFg ||
    !!(
      scenario.details &&
      scenario.details.intro &&
      scenario.details.intro.foreground
    );
  const introNav = noSteps
    ? `<div class="nav">${endActions}</div>`
    : `<div class="nav"><button class="primary" data-target="0"${
        introFg ? ' disabled data-fg-gated="1"' : ""
      }>START ▶</button></div>`;
  sections.push(
    `<section class="step active" data-step="intro">` +
      `<h1>${escapeHtml(scenario.title || "Scenario")}</h1>` +
      `<p class="lead">${escapeHtml(scenario.description || "")}</p>` +
      // Optional intro markdown, rendered with the demo player (buttons work).
      (intro ? renderMarkdownToHtml(intro.md, intro.baseStr, webview) : "") +
      introNav +
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
        renderMarkdownToHtml(s.md, s.baseStr, webview) +
        `<div class="nav">${prev}${verify}${next}</div>` +
        `</section>`
    );
  });

  // End screen — present whenever there are steps to finish. (With no steps the
  // intro is already the terminal screen, carrying the same actions, so there's
  // nothing to navigate to here.) Uses the scenario's finish.md when defined,
  // otherwise a built-in completion message.
  if (!noSteps) {
    const finishBody = finish
      ? renderMarkdownToHtml(finish, data.dirStr, webview)
      : `<h1>🎉 ${escapeHtml(scenario.title || "Scenario")} complete</h1>` +
        `<p class="lead">You've reached the end of this scenario.</p>`;
    sections.push(
      `<section class="step" data-step="finish">` +
        finishBody +
        `<div class="nav">` +
        `<button data-target="${last}">◀ PREV</button>` +
        endActions +
        `</div>` +
        `</section>`
    );
  }

  // Persistent, always-visible controls (fixed in the corner, outside every
  // section) so they work on any screen — not just the intro. A− / A+ adjust the
  // font size (player + terminals); the toggle flips DEMO (projection) mode. The
  // client script drives them and reflects state in their labels.
  const demoControls =
    `<div id="demo-controls">` +
    `<button data-demo-font="-1" title="Decrease font size">A−</button>` +
    `<button data-demo-font="1" title="Increase font size">A+</button>` +
    `<button id="demo-toggle" data-demo-toggle="1"` +
    ` title="Toggle DEMO (projection) mode — light theme + larger fonts for the player and terminals">` +
    `🖥 DEMO MODE</button>` +
    `</div>`;
  return pageHtml(
    webview,
    scenario.title || "Scenario",
    demoControls + sections.join("\n")
  );
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
        localResourceRoots: resourceRoots(jsonDoc.uri),
      }
    );
    const nodes = resolveNodes(scenario);
    const noProxy = resolveNoProxy(scenario);
    const assets = (scenario.details && scenario.details.assets) || null;
    const baseFsPath = vscode.Uri.joinPath(jsonDoc.uri, "..").fsPath;
    entry = {
      panel,
      doc: jsonDoc,
      scenario,
      nodes,
      noProxy,
      assets,
      baseFsPath,
      terminals: [],
      bgDone: new Set(),
      fgDone: new Set(),
    };
    scenarioPanels.set(key, entry);
    trackActivePanel(panel);
    runningScenarioEntry = entry; // target for "new terminal on node"
    setScenarioRunning(panel); // hides PLAY / shows STOP everywhere

    panel.webview.onDidReceiveMessage(makeMessageHandler(entry));

    // Closing the player tears down all of its container shells too.
    panel.onDidDispose(() => {
      entry.disposed = true; // stop any in-flight background retry loops
      restoreDemoTerminalStyle(entry); // put back any DEMO-mode setting overrides
      disposeEntryTerminals(entry);
      scenarioPanels.delete(key);
      if (runningScenarioEntry === entry) runningScenarioEntry = null;
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

  const data = await buildScenario(entry.doc, entry.nodes);
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

/**
 * Remove every persistent containerd image-cache volume (label `rockdemo-cache`).
 * These deliberately survive the normal stale sweep and teardown — this is the
 * ONLY thing that deletes them, so it's always an explicit user action. A volume
 * still bound to a running container can't be removed; those are counted as
 * `inUse` and left alone. When `retries` > 0 the still-in-use ones are retried
 * (with a 1s pause), which lets a caller fire an async container teardown and
 * then clear the volumes it frees. Returns { removed, inUse }.
 */
async function clearCacheVolumes({ retries = 0 } = {}) {
  const list = async () => {
    try {
      const { stdout } = await execFile("docker", [
        "volume", "ls", "-q", "--filter", "label=rockdemo-cache",
      ]);
      return stdout.split(/\s+/).filter(Boolean);
    } catch (err) {
      return []; // docker missing/unreachable — nothing we can do
    }
  };
  let removed = 0;
  let inUse = 0;
  for (let attempt = 0; ; attempt++) {
    const vols = await list();
    if (!vols.length) break;
    inUse = 0;
    for (const v of vols) {
      try {
        await execFile("docker", ["volume", "rm", v]);
        removed++;
      } catch (err) {
        const msg = String((err && err.stderr) || (err && err.message) || err);
        if (/in use|being used/i.test(msg)) inUse++;
        // other errors (already gone, etc.): skip quietly
      }
    }
    if (inUse === 0 || attempt >= retries) break;
    await delay(1000); // give an in-flight `docker rm -f` time to release them
  }
  return { removed, inUse };
}

/**
 * End the scenario AND clear the image cache (the end-screen "CLOSE & CLEAR
 * CACHE" action). The scenario's own containers still hold their cache volumes,
 * so remove the containers FIRST (awaited) before deleting the now-free volumes.
 */
async function endAndClearCache(entry) {
  await removeEntryContainers(entry); // frees the volumes this scenario holds
  if (entry.panel) entry.panel.dispose(); // map cleanup + reset scenarioRunning
  notifyCacheCleared(await clearCacheVolumes());
}

/** Report a clearCacheVolumes() result to the user. */
function notifyCacheCleared({ removed, inUse }) {
  if (!removed && !inUse) {
    vscode.window.showInformationMessage("rockDemo: no image cache to clear.");
    return;
  }
  let m = `rockDemo: cleared ${removed} image cache volume${removed === 1 ? "" : "s"}.`;
  if (inUse) {
    m += ` ${inUse} still in use — stop the scenario using them, then clear again.`;
  }
  vscode.window.showInformationMessage(m);
}

// ---------------------------------------------------------------------------
// Ad-hoc node terminals: while a scenario runs, open EXTRA shells attached to a
// node's already-running container via `docker exec`. Exposed both as a Command
// Palette action and as a terminal-profile entry in the terminal view's `+`
// dropdown. (VS Code terminal profiles are static package.json contributions —
// there's no API to list one entry per live node — so a single entry picks the
// node, auto-selecting when the scenario has just one.)
// ---------------------------------------------------------------------------

/**
 * VS Code terminal options for a new shell on a node. We deliberately do NOT set
 * `shellPath: "docker"`: that would make `docker exec` the terminal's own
 * PROCESS, and when the scenario ends (container removed / terminal disposed) it
 * exits non-zero, so VS Code pops its "process terminated with exit code" alert.
 * Instead we keep the ordinary host shell as the process and run `docker exec`
 * as a command inside it (see trackNodeTerminal) — exactly like a node's own
 * terminal — so teardown is clean and no alert appears. The env marker lets
 * onDidOpenTerminal recognise our terminals from BOTH entry points (the command
 * and the `+` dropdown profile, whose provider gives us no terminal handle).
 */
function nodeTerminalOptions(node) {
  return { name: node.name, env: { ROCKDEMO_NODE_TERMINAL: node.name } };
}

/**
 * Pick a node of the running scenario to open a new terminal on: auto-selects
 * the only node, prompts with a QuickPick when there's more than one. Returns
 * null (after a warning) when no scenario is running.
 */
async function pickRunningNode() {
  const entry = runningScenarioEntry;
  const nodes = ((entry && !entry.disposed && entry.nodes) || []).filter(
    (n) => n.imageid
  );
  if (!nodes.length) {
    vscode.window.showWarningMessage(
      "rockDemo: no running scenario node — start a scenario first."
    );
    return null;
  }
  if (nodes.length === 1) return nodes[0];
  const pick = await vscode.window.showQuickPick(
    nodes.map((n) => ({
      label: n.name,
      description: `docker exec … ${n.cmd || "sh"}`,
      node: n,
    })),
    { placeHolder: "rockDemo: open a new terminal on which node?" }
  );
  return pick ? pick.node : null;
}

/**
 * Register a just-opened node terminal on the running scenario entry so it's
 * torn down with the scenario, then attach the shell. Only matches the terminals
 * this feature creates (by the env marker set in nodeTerminalOptions), never the
 * node's own terminal. `containerName` is left null: the container is owned — and
 * removed — by the node's own terminal record, so this extra shell only needs its
 * terminal disposed. Copies the node's mounts so {{open}} still reverse-maps
 * container paths when this terminal is the active one.
 */
function trackNodeTerminal(term) {
  const opts = term.creationOptions || {};
  const nodeName = opts.env && opts.env.ROCKDEMO_NODE_TERMINAL;
  if (!nodeName) return;
  const entry = runningScenarioEntry;
  if (!entry || entry.disposed || !entry.terminals) return;
  const node = (entry.nodes || []).find((n) => n.name === nodeName);
  if (!node) return;
  const src = entry.terminals.find((r) => r.name === node.name && r.containerName);
  entry.terminals.push({
    name: node.name,
    terminal: term,
    containerName: null, // the node's own record owns the container removal
    mounts: (src && src.mounts) || [],
  });
  // Attach a fresh shell to the RUNNING container as a command in the host shell
  // (NOT as the terminal's process — see nodeTerminalOptions), then `clear` to
  // hide the exec line. `cmd` from the node config (fallback `sh`) matches the
  // shell the node's own terminal launched with. sendAfterReady waits for the
  // host shell to be live first, so a slow ~/.bashrc can't swallow the exec.
  sendAfterReady(term, [
    `docker exec -it ${containerNameFor(node.name)} ${node.cmd || "sh"}`,
    "clear",
  ]);
  // Reveal AND focus the new terminal (show() defaults to preserveFocus=false),
  // so the cursor lands in it ready to type — for both the command and the `+`
  // dropdown profile, whose provider gives us no handle to focus otherwise.
  term.show();
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

  // Clear the persistent image cache (all `rockdemo-cache` volumes). Housekeeping
  // to reclaim disk or force a fresh pull; volumes bound to a running scenario
  // are skipped and reported.
  context.subscriptions.push(
    vscode.commands.registerCommand("rockdemo.clearCache", async () => {
      notifyCacheCleared(await clearCacheVolumes());
    })
  );

  // Open a new terminal attached to a running scenario node (`docker exec`).
  // Available from the Command Palette while a scenario runs and — via the
  // terminal profile below — from the terminal view's `+` dropdown.
  context.subscriptions.push(
    vscode.commands.registerCommand("rockdemo.newNodeTerminal", async () => {
      const node = await pickRunningNode();
      if (!node) return;
      // onDidOpenTerminal → trackNodeTerminal registers and focuses it.
      vscode.window.createTerminal(nodeTerminalOptions(node));
    })
  );

  // Terminal-profile entry in the `+` dropdown; picks the node, then attaches.
  context.subscriptions.push(
    vscode.window.registerTerminalProfileProvider("rockdemo.nodeTerminal", {
      async provideTerminalProfile() {
        const node = await pickRunningNode();
        if (!node) return undefined; // cancels terminal creation
        return new vscode.TerminalProfile(nodeTerminalOptions(node));
      },
    })
  );

  // Track ad-hoc node terminals (from either entry point) so a scenario Stop
  // disposes them too. Ignores every terminal that isn't one of ours.
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(trackNodeTerminal)
  );

  // Stop the scenario AND clear the cache in one go (the STOP dropdown option).
  // Disposing the panel tears the containers down asynchronously, so retry the
  // volume removal until those in-flight `docker rm`s release them.
  context.subscriptions.push(
    vscode.commands.registerCommand("rockdemo.stopAndClearCache", async () => {
      const target = runningScenarioPanel || activeDemoPanel;
      if (target) target.dispose();
      notifyCacheCleared(await clearCacheVolumes({ retries: 8 }));
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
      buildScenario(entry.doc, entry.nodes).then((data) => {
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
