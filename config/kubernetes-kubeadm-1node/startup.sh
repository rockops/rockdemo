#!/bin/sh
# Backend foreground for the kubernetes-kubeadm-1node node. Everything else (apt
# packages, containerd, kubelet, sysctls) is baked into the image — only the
# parts that cannot be done at build time run here, blocking the player's START
# button until the cluster is up:
#   1. `kubeadm init`            (creates the control plane)
#   2. install the Cilium CNI    (once the API server answers)
#   3. wait for the node Ready   (turns Ready only after the CNI is up)
#
# kubeadm-config.yaml lives alongside this script and is mounted read-only at
# $CFG inside the container. The add-on manifests (Cilium, local-path) are baked
# into the image at $MANIFESTS and applied with `kubectl apply`, which pulls their
# images on the first run.
set -e
CFG=/var/rockdemo/config/kubernetes-kubeadm-1node
MANIFESTS=/opt/rockdemo/manifests

# Map "cp" (the --node-name) and "k8scp" (the controlPlaneEndpoint in
# kubeadm-config.yaml) to this node's MAIN interface IP — the source address of
# the default route — so kubeadm's certs/API server resolve them (step1.md does
# this by hand via `vim /etc/hosts`).
IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')
[ -n "$IP" ] || IP=$(hostname -i | awk '{print $1}')
for NAME in cp k8scp; do
  grep -q " $NAME\$" /etc/hosts || echo "$IP $NAME" >> /etc/hosts
done

# containerd is a systemd service now; give it a moment to accept CRI calls so
# kubeadm's runtime probe doesn't race a still-starting daemon.
echo 'Waiting for containerd...'
until crictl info >/dev/null 2>&1; do sleep 1; done

# Runtime images are pulled from the network on the FIRST run and cached in the
# persistent /var/lib/containerd volume (see src/extension.js), so subsequent
# runs start warm. The first run therefore takes longer while kubeadm/kubelet and
# the manifest applies below pull ~1.3 GB.
echo 'Initialising the control plane with kubeadm (first run pulls images; this takes a few minutes)...'
# Pin the version to the installed kubeadm binary (the single k8s version knob —
# set by KUBE_PKG_VERSION in the image). kubeadm rejects --kubernetes-version
# alongside --config, so inject it into the config's placeholder line instead
# (the mount is read-only, so render a copy in /tmp). Pinning avoids kubeadm
# fetching the latest patch from the internet — which would skew from the
# installed kubelet/kubeadm.
RENDERED_CONFIG=/tmp/kubeadm-config.yaml
sed "s|^kubernetesVersion:.*|kubernetesVersion: $(kubeadm version -o short)|" \
  "$CFG/kubeadm-config.yaml" > "$RENDERED_CONFIG"
kubeadm init --config="$RENDERED_CONFIG" --upload-certs --node-name=cp \
  | tee /var/log/kubeadm-init.out

# kubeconfig for root (matches $KUBECONFIG baked into the image).
mkdir -p /root/.kube
cp -f /etc/kubernetes/admin.conf /root/.kube/config

# Single node: let workloads schedule on the control plane.
kubectl taint nodes --all node-role.kubernetes.io/control-plane- || true

# Apply BOTH add-ons up front (Cilium CNI + the Rancher local-path storage
# provisioner) so their images pull and their pods roll out in parallel, rather
# than serializing storage behind the Cilium/node-Ready waits below. Both are
# baked into the image and version-pinned in the manifests.
echo 'Installing the Cilium CNI and local-path storage provisioner...'
kubectl apply -f "$MANIFESTS/cilium-cni.yaml"
kubectl apply -f "$MANIFESTS/local-path-storage.yaml"

echo 'Waiting for the node to become Ready (Cilium must be up first)...'
kubectl wait --for=condition=Ready node --all --timeout=300s

echo 'Waiting for the Cilium components to be ready...'
kubectl -n kube-system rollout status daemonset/cilium --timeout=300s
kubectl -n kube-system rollout status deployment/cilium-operator --timeout=300s

# Storage rolled out alongside Cilium above; wait for it and make it the default
# StorageClass so PVCs bind out of the box on this single node.
echo 'Waiting for the local-path storage provisioner...'
kubectl -n local-path-storage rollout status deployment/local-path-provisioner --timeout=180s
kubectl patch storageclass local-path \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

echo 'Cluster is ready.'
