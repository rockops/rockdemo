#!/bin/sh
# Propagate the host's HTTP(S) proxy and CA trust to this node's system daemons
# (containerd, dockerd) at boot, BEFORE they start — so image pulls work behind
# a corporate, TLS-intercepting proxy. Both problems below are invisible to the
# `docker run -e HTTP_PROXY=...` env that rockDemo forwards:
#
# 1. The daemons don't inherit the container env. containerd and dockerd run as
#    systemd units, and systemd starts units with a CLEAN environment — the
#    proxy vars rockDemo set via `docker run -e` never reach them. systemd DID
#    inherit them (it's PID 1), so they survive in /proc/1/environ. We lift them
#    out into /run/rockdemo/proxy.env, which the baked containerd/docker drop-ins
#    (rockdemo-proxy.conf) pull in via `EnvironmentFile=`.
#
# 2. TLS interception. A corporate proxy re-signs TLS with an internal CA the
#    container doesn't trust, so pulls fail cert verification. rockDemo bind-
#    mounts the HOST's CA bundle at /etc/rockdemo-host-ca.crt; we add it to the
#    container trust store so the daemons (and curl, git, …) trust it too.
#
# Ordered Before=containerd.service docker.service by rockdemo-proxy.service, so
# the env file and trust store are in place before either daemon starts.
set -eu

RUN_DIR=/run/rockdemo
ENV_FILE="$RUN_DIR/proxy.env"
mkdir -p "$RUN_DIR"

# (1) Lift the proxy vars out of PID 1's environment (where the container's
# `docker run -e` values live) into an EnvironmentFile for the daemons. The
# environ is NUL-delimited; keep only the proxy keys, both cases. No matches
# (no proxy configured) just leaves an empty file — harmless, the drop-in's
# leading '-' makes it optional.
: > "$ENV_FILE"
tr '\0' '\n' < /proc/1/environ \
  | grep -E '^(HTTP_PROXY|HTTPS_PROXY|NO_PROXY|http_proxy|https_proxy|no_proxy)=' \
  >> "$ENV_FILE" || true

# (2) Trust the host's CAs (covers a TLS-intercepting proxy's internal CA). The
# host bundle is a superset of the base image's, so merging it never removes
# trust; update-ca-certificates de-dups. Skipped when nothing was mounted.
HOST_CA=/etc/rockdemo-host-ca.crt
if [ -s "$HOST_CA" ]; then
  mkdir -p /usr/local/share/ca-certificates
  cp "$HOST_CA" /usr/local/share/ca-certificates/rockdemo-host-ca.crt
  update-ca-certificates >/dev/null 2>&1 || true
fi
