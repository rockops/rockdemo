#!/bin/sh
# Backend foreground for the control-plane node of the 2-node kubeadm cluster.
# Same as the 1-node startup, but `kubeadm init` publishes a fixed bootstrap
# token so the worker (worker.sh) can join, and it waits for BOTH nodes Ready.
set -e
CFG=/var/rockdemo/config/kubernetes-kubeadm-2nodes       # 2-node kubeadm config
MANIFESTS=/opt/rockdemo/manifests                        # add-on manifests baked into the image
# The bootstrap token the worker joins with lives in $CFG/kubeadm-config.yaml
# (bootstrapTokens) — `kubeadm init --config` forbids the --token CLI flags.

# Map "cp" (the --node-name) and "k8scp" (the controlPlaneEndpoint) to this
# node's main-interface IP so kubeadm's certs/API server resolve them.
IP=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<=NF;i++) if ($i=="src") {print $(i+1); exit}}')
[ -n "$IP" ] || IP=$(hostname -i | awk '{print $1}')
for NAME in cp k8scp; do
  grep -q " $NAME\$" /etc/hosts || echo "$IP $NAME" >> /etc/hosts
done

echo 'Waiting for containerd...'
until crictl info >/dev/null 2>&1; do sleep 1; done

# Runtime images are pulled from the network on the FIRST run and cached in the
# persistent /var/lib/containerd volume (see src/extension.js), so subsequent
# runs start warm.
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

# Apply BOTH add-ons up front (Cilium CNI + the Rancher local-path storage
# provisioner) so their images pull and their pods roll out in parallel, rather
# than serializing storage behind the join/Cilium waits below.
echo 'Installing the Cilium CNI and local-path storage provisioner...'
kubectl apply -f "$MANIFESTS/cilium-cni.yaml"
kubectl apply -f "$MANIFESTS/local-path-storage.yaml"

echo 'Waiting for the worker to join...'
i=0
until [ "$(kubectl get nodes --no-headers 2>/dev/null | wc -l)" -ge 2 ] || [ "$i" -ge 100 ]; do
  i=$((i + 1))
  sleep 3
done

echo 'Waiting for all nodes to become Ready...'
kubectl wait --for=condition=Ready node --all --timeout=300s || true

echo 'Waiting for the Cilium components to be ready...'
kubectl -n kube-system rollout status daemonset/cilium --timeout=300s
kubectl -n kube-system rollout status deployment/cilium-operator --timeout=300s

# Storage rolled out alongside Cilium above; wait for it and make it the default
# StorageClass so PVCs bind out of the box.
echo 'Waiting for the local-path storage provisioner...'
kubectl -n local-path-storage rollout status deployment/local-path-provisioner --timeout=180s
kubectl patch storageclass local-path \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

echo 'Cluster is ready (2 nodes).'
