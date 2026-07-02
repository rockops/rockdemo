#!/bin/sh
# Backend foreground for the control-plane node of the 2-node kubeadm cluster.
# Same as the 1-node startup, but `kubeadm init` publishes a fixed bootstrap
# token so the worker (worker.sh) can join, and it waits for BOTH nodes Ready.
# Reuses the 1-node assets (kubeadm-config / cilium / local-path) — the whole
# config/ folder is mounted read-only, so they're available by path.
set -e
CFG=/var/rockdemo/config/kubernetes-kubeadm-2nodes       # 2-node kubeadm config
ASSETS=/var/rockdemo/config/kubernetes-kubeadm-1node     # reuse cilium + local-path manifests
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

echo 'Initialising the control plane with kubeadm (this takes a couple of minutes)...'
kubeadm init --config="$CFG/kubeadm-config.yaml" --upload-certs --node-name=cp \
  | tee /var/log/kubeadm-init.out

# kubeconfig for root (matches $KUBECONFIG baked into the image).
mkdir -p /root/.kube
cp -f /etc/kubernetes/admin.conf /root/.kube/config

echo 'Installing the Cilium CNI...'
kubectl apply -f "$ASSETS/cilium-cni.yaml"

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

echo 'Installing the local-path storage provisioner...'
kubectl apply -f "$ASSETS/local-path-storage.yaml"
kubectl -n local-path-storage rollout status deployment/local-path-provisioner --timeout=180s
kubectl patch storageclass local-path \
  -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'

echo 'Cluster is ready (2 nodes).'
