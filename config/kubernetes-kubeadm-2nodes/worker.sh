#!/bin/sh
# Backend foreground for the worker node of the 2-node kubeadm cluster. Waits
# for the control-plane API, then joins with the fixed bootstrap token that
# controlplane.sh published. No kubeconfig here — readiness is observed from the
# control plane (controlplane.sh waits for both nodes Ready).
set -e
TOKEN=abcdef.0123456789abcdef
CP_IP=172.30.1.2   # control-plane static IP (see config/backends.json) = k8scp

# The control-plane endpoint is the "k8scp" alias — point it at the cp's IP.
grep -q ' k8scp$' /etc/hosts || echo "$CP_IP k8scp" >> /etc/hosts

echo 'Waiting for containerd...'
until crictl info >/dev/null 2>&1; do sleep 1; done

echo 'Waiting for the control-plane API (k8scp:6443)...'
until curl -sk https://k8scp:6443/healthz >/dev/null 2>&1; do sleep 3; done

echo 'Joining the cluster...'
kubeadm join k8scp:6443 \
  --token "$TOKEN" \
  --discovery-token-unsafe-skip-ca-verification \
  --node-name node01 \
  --ignore-preflight-errors=SystemVerification \
  | tee /var/log/kubeadm-join.out

echo 'Worker joined.'
