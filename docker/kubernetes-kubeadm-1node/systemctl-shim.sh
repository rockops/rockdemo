#!/bin/sh
# Minimal `systemctl` stand-in (shadows the real one via /usr/local/bin on PATH).
#
# The container has no init system, but `kubeadm init` drives the kubelet through
# systemctl ("daemon-reload", then "restart kubelet"). This shim turns those
# kubelet calls into a plain background process launched exactly like the kubeadm
# systemd dropin would, and no-ops everything else so kubeadm's other systemctl
# probes succeed.

start_kubelet() {
  # Replicate the ExecStart of /etc/systemd/system/kubelet.service.d/10-kubeadm.conf:
  #   kubelet $KUBELET_KUBECONFIG_ARGS $KUBELET_CONFIG_ARGS \
  #           $KUBELET_KUBEADM_ARGS $KUBELET_EXTRA_ARGS
  KUBELET_KUBECONFIG_ARGS="--bootstrap-kubeconfig=/etc/kubernetes/bootstrap-kubelet.conf --kubeconfig=/etc/kubernetes/kubelet.conf"
  KUBELET_CONFIG_ARGS="--config=/var/lib/kubelet/config.yaml"
  # Written by kubeadm (KUBELET_KUBEADM_ARGS) / optional operator overrides.
  [ -f /var/lib/kubelet/kubeadm-flags.env ] && . /var/lib/kubelet/kubeadm-flags.env
  [ -f /etc/default/kubelet ] && . /etc/default/kubelet

  pkill -f "/usr/bin/kubelet " 2>/dev/null || true
  # shellcheck disable=SC2086
  nohup /usr/bin/kubelet \
    $KUBELET_KUBECONFIG_ARGS \
    $KUBELET_CONFIG_ARGS \
    $KUBELET_KUBEADM_ARGS \
    $KUBELET_EXTRA_ARGS \
    >/var/log/kubelet.log 2>&1 &
}

# Find the verb + (optional) unit in the arg list, skipping flags like --quiet.
verb=""
unit=""
for a in "$@"; do
  case "$a" in
    -*) ;;                       # ignore flags (--quiet, --now, ...)
    *)  if [ -z "$verb" ]; then verb="$a"; else [ -z "$unit" ] && unit="$a"; fi ;;
  esac
done

case "$unit" in
  kubelet|kubelet.service)
    case "$verb" in
      start|restart) start_kubelet ;;
      stop)          pkill -f "/usr/bin/kubelet " 2>/dev/null || true ;;
      *)             : ;;        # enable / is-active / status — succeed quietly
    esac
    ;;
  *)
    : ;;                          # daemon-reload and anything else — no-op
esac
exit 0
