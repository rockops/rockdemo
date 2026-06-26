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

# Clean shutdown signal for systemd (so `docker stop` ends it gracefully).
STOPSIGNAL SIGRTMIN+3

WORKDIR /root

CMD ["/sbin/init"]
