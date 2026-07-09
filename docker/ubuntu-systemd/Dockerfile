# rockDemo "ubuntu-systemd" image — same tooling as the lean "ubuntu" image but
# with a real systemd as PID 1, for scenarios that follow procedures verbatim
# (e.g. the CNCF kubeadm install) and need `systemctl` to manage services.
#
# Kept as a SEPARATE image on purpose: systemd + systemd-sysv add ~40-60 MB, so
# the default "ubuntu" image stays lean for simple shell-only scenarios. Backends
# opt in per node with `"systemd": true` in config/backends.json, which makes
# rockDemo boot `/sbin/init` and attach the shell via `docker exec`.
#
# Published to GHCR as ghcr.io/rockops/rockdemo/ubuntu-systemd:24.04.
#
# Build locally (tag must match the imageid in config/backends.json):
#   docker build -t ghcr.io/rockops/rockdemo/ubuntu-systemd:24.04 docker/ubuntu-systemd
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
# Tells systemd it's running in a container so it skips host-only units.
ENV container=docker

# Same baseline tooling as the "ubuntu" image, plus systemd as init.
# `touch /etc/modules` mirrors the lean image (some procedures sed it).
RUN touch /etc/modules \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      wget \
      telnet \
      docker.io \
      podman \
      kmod \
      sudo \
      vim \
      nano \
      tree \
      systemd \
      systemd-sysv \
 && rm -rf /var/lib/apt/lists/*

# The stock ubuntu image ships /usr/sbin/policy-rc.d (`exit 101`) to block
# package post-install scripts from auto-starting services during image builds.
# This image HAS real systemd, so we want host-like behavior: installing e.g.
# containerd should auto-start + enable its service, exactly as the CNCF docs
# assume. Remove the hook so `apt install` no longer prints "policy-rc.d
# returned 101, not running 'start <svc>'".
RUN rm -f /usr/sbin/policy-rc.d

# Strip units that are pointless or fail inside a container, so boot is clean
# and fast (no getty consoles, no udev, no swap/mount targets we don't have).
RUN find /etc/systemd/system /lib/systemd/system \
      -path '*.wants/*' \
      \( -name '*udev*' -o -name '*getty*' -o -name '*swap*' \) \
      -delete \
 && systemctl mask \
      systemd-resolved.service \
      systemd-networkd.service \
      systemd-firstboot.service \
      systemd-remount-fs.service \
      getty.target \
      console-getty.service \
      podman-auto-update.service \
      podman-clean-transient.service \
      podman-restart.service 2>/dev/null || true

# Make / rshared at boot (host-like), so the kubelet and CNIs (Cilium bpffs)
# get the mount propagation they need. See the unit file for the full why.
COPY rockdemo-rshared.service /etc/systemd/system/rockdemo-rshared.service
RUN systemctl enable rockdemo-rshared.service

# Replace Docker's loopback DNS stub with a real upstream at boot, so the
# kubelet and CoreDNS run stock (no resolvConf / Corefile tweaks). See the unit.
COPY rockdemo-resolv.service /etc/systemd/system/rockdemo-resolv.service
RUN systemctl enable rockdemo-resolv.service

# Make cgroup v2 controller delegation work in a private cgroup namespace so a
# nested kubelet can create kubepods.slice with its controllers (cpu/cpuset/
# memory/pids/hugetlb). Without this the kubelet aborts: "kubepods has some
# missing controllers". Three cooperating pieces (see the .sh for the full why):
#   1. Accounting defaults — systemd keeps cpu/memory/io/pids delegated, so the
#      root cgroup never goes empty (which is what lets a stray shell get
#      trapped in it and block everything).
#   2. A boot oneshot — seeds ALL controllers (incl. cpuset/hugetlb) at early
#      boot while the root cgroup is still clean.
#   3. A shell self-heal (below) — relocates an interactive shell that lost the
#      boot race and landed in the root cgroup, then enables delegation.
COPY rockdemo-accounting.conf /etc/systemd/system.conf.d/10-rockdemo-accounting.conf
COPY rockdemo-cgroup-delegate.sh /usr/local/bin/rockdemo-cgroup-delegate.sh
RUN chmod +x /usr/local/bin/rockdemo-cgroup-delegate.sh
COPY rockdemo-cgroup-delegate.service /etc/systemd/system/rockdemo-cgroup-delegate.service
RUN systemctl enable rockdemo-cgroup-delegate.service
# Self-heal the boot race: the interactive shell attaches before the seed runs
# and lands in the cgroup root, blocking delegation. This snippet (sourced by
# every interactive shell, login or not) moves the shell out of the root cgroup
# and enables delegation when it detects it's trapped there. No-op otherwise.
COPY rockdemo-cgroup-shell.sh /etc/profile.d/rockdemo-cgroup-shell.sh
RUN printf '\n[ -f /etc/profile.d/rockdemo-cgroup-shell.sh ] && . /etc/profile.d/rockdemo-cgroup-shell.sh\n' >> /etc/bash.bashrc

# Let kubeadm's SystemVerification read a kernel config, so the stock
# `kubeadm join`/`init` runs in a container without
# `--ignore-preflight-errors=SystemVerification`. See the .sh for the full why.
COPY rockdemo-kernel-config.sh /usr/local/bin/rockdemo-kernel-config.sh
RUN chmod +x /usr/local/bin/rockdemo-kernel-config.sh
COPY rockdemo-kernel-config.service /etc/systemd/system/rockdemo-kernel-config.service
RUN systemctl enable rockdemo-kernel-config.service

# Propagate the host's proxy + CA trust to the in-container daemons (containerd,
# dockerd) at boot, so image pulls work behind a corporate, TLS-intercepting
# proxy. systemd starts those daemons with a clean env, so rockDemo's
# `docker run -e HTTP_PROXY=...` never reaches them; the oneshot below lifts the
# proxy out of PID 1's environment into an EnvironmentFile the daemons read (via
# the drop-ins), and merges the host CA bundle (bind-mounted by rockDemo at
# /etc/rockdemo-host-ca.crt) into the trust store. See rockdemo-proxy.sh.
COPY rockdemo-proxy.sh /usr/local/bin/rockdemo-proxy.sh
RUN chmod +x /usr/local/bin/rockdemo-proxy.sh
COPY rockdemo-proxy.service /etc/systemd/system/rockdemo-proxy.service
COPY rockdemo-proxy.conf /etc/systemd/system/containerd.service.d/rockdemo-proxy.conf
COPY rockdemo-proxy.conf /etc/systemd/system/docker.service.d/rockdemo-proxy.conf
RUN systemctl enable rockdemo-proxy.service

# Every container cloned from this image MUST get a unique /etc/machine-id.
# Kubernetes derives a node's machineID/systemUUID from it, so when two nodes
# (control plane + worker) boot from the same image with an identical id, they
# collide: the joining node and the control plane share an identity, the
# control-plane node flips NotReady, and its pods (incl. the API server) get
# evicted. CNI-independent — it breaks Cilium and Flannel alike. An EMPTY
# machine-id makes systemd generate a fresh one per container at first boot.
RUN rm -f /var/lib/dbus/machine-id && : > /etc/machine-id

# Clean shutdown signal for systemd (so `docker stop` ends it gracefully).
STOPSIGNAL SIGRTMIN+3

WORKDIR /root

CMD ["/sbin/init"]
