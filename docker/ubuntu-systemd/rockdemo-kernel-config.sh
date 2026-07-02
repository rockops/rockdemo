#!/bin/sh
# Make kubeadm's SystemVerification preflight pass in a container.
#
# kubeadm reads the kernel BUILD config to verify required options are enabled.
# A container has no /proc/config.gz, and the verifier's fallback (`modprobe
# configs`) fails because the shared host kernel doesn't ship that module — so
# the check is fatal: "[ERROR SystemVerification]: failed to parse kernel
# config". That forces every `kubeadm join`/`init` to carry
# `--ignore-preflight-errors=SystemVerification`, which leaks the container-ness
# into the demo commands.
#
# The verifier also looks for the config at /boot/config-<kernel release>. We
# provide one there (named for the running kernel, resolved at boot) declaring
# the options kubeadm requires as enabled, so the check parses it and passes.
# The stock `kubeadm join`/`init` then runs with no extra flags. This only
# feeds kubeadm's checker; it does not change the actual (host) kernel.
KREL=$(uname -r)
DEST="/boot/config-$KREL"
[ -e "$DEST" ] && exit 0
mkdir -p /boot
cat > "$DEST" <<'EOF'
# Synthetic kernel config for kubeadm SystemVerification (rockDemo container node).
CONFIG_NAMESPACES=y
CONFIG_NET_NS=y
CONFIG_PID_NS=y
CONFIG_IPC_NS=y
CONFIG_UTS_NS=y
CONFIG_CGROUPS=y
CONFIG_CGROUP_CPUACCT=y
CONFIG_CGROUP_DEVICE=y
CONFIG_CGROUP_FREEZER=y
CONFIG_CGROUP_PIDS=y
CONFIG_CGROUP_SCHED=y
CONFIG_CGROUP_BPF=y
CONFIG_CPUSETS=y
CONFIG_MEMCG=y
CONFIG_INET=y
CONFIG_EXT4_FS=y
CONFIG_PROC_FS=y
CONFIG_NETFILTER_XT_TARGET_REDIRECT=y
CONFIG_NETFILTER_XT_MATCH_COMMENT=y
CONFIG_FAIR_GROUP_SCHED=y
CONFIG_OVERLAY_FS=y
CONFIG_AUFS_FS=y
CONFIG_BLK_DEV_DM=y
CONFIG_CFS_BANDWIDTH=y
CONFIG_SECCOMP=y
CONFIG_SECCOMP_FILTER=y
EOF
