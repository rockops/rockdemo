#!/usr/bin/env bash
# Bring up a single-node Kubernetes cluster with kubeadm, then hand off to the
# container's command (a shell). By the time the shell appears the node is Ready
# and `kubectl` / `helm` work against it.
#
# Re-runs kubeadm init on every container start: rockDemo launches nodes with
# --rm, so each run is a fresh, ephemeral cluster.
set -euo pipefail

log() { echo "[k8s-init] $*"; }

# --- host prerequisites (we are --privileged) ---
swapoff -a 2>/dev/null || true
mount --make-rshared / 2>/dev/null || true        # kubelet needs shared mount propagation
modprobe br_netfilter overlay 2>/dev/null || true
sysctl -w net.ipv4.ip_forward=1                 >/dev/null 2>&1 || true
sysctl -w net.bridge.bridge-nf-call-iptables=1  >/dev/null 2>&1 || true

# --- container runtime ---
if ! pgrep -x containerd >/dev/null 2>&1; then
  log "starting containerd"
  containerd >/var/log/containerd.log 2>&1 &
fi
# Wait until the CRI actually answers — not just until the socket file exists —
# so kubeadm's runtime probe doesn't race a half-started containerd.
log "waiting for containerd CRI"
ready=""
for _ in $(seq 1 60); do
  if [ -S /run/containerd/containerd.sock ] && crictl info >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
[ -n "$ready" ] || log "containerd CRI not ready — see /var/log/containerd.log"

# --- cluster (once per container) ---
if [ ! -f /etc/kubernetes/admin.conf ]; then
  log "running kubeadm init — first boot takes a couple of minutes"
  # Preflight checks that don't apply (or can't pass) inside a container.
  kubeadm init \
    --config=/etc/kubernetes/kubeadm-config.yaml \
    --ignore-preflight-errors=Swap,SystemVerification,NumCPU,Mem,FileContent--proc-sys-net-bridge-bridge-nf-call-iptables \
    >/var/log/kubeadm-init.log 2>&1 \
    || { log "kubeadm init failed — see /var/log/kubeadm-init.log"; tail -n 40 /var/log/kubeadm-init.log || true; }

  # kubeconfig for root
  mkdir -p /root/.kube
  cp -f /etc/kubernetes/admin.conf /root/.kube/config
  chmod 600 /root/.kube/config

  # Single node: let workloads schedule on the control plane.
  kubectl --kubeconfig=/root/.kube/config taint nodes --all \
    node-role.kubernetes.io/control-plane- >/dev/null 2>&1 || true

  # CNI so the node turns Ready (manifest baked into the image).
  log "installing flannel CNI"
  kubectl --kubeconfig=/root/.kube/config apply -f /etc/kubernetes/addons/flannel.yml >/dev/null 2>&1 || \
    log "flannel apply failed — check connectivity / image pull"

  log "waiting for node Ready (up to 180s)"
  kubectl --kubeconfig=/root/.kube/config wait --for=condition=Ready node --all --timeout=180s >/dev/null 2>&1 \
    && log "cluster ready" \
    || log "node not Ready within timeout — inspect 'kubectl get pods -A' and /var/log/kubelet.log"
fi

exec "$@"
