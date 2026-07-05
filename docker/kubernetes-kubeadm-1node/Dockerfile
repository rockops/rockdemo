# rockDemo "kubernetes-kubeadm-1node" image — everything needed to bring up a
# single-node kubeadm cluster is baked in; the cluster itself is created at
# runtime by the backend foreground script (config/kubernetes-kubeadm-1node/
# startup.sh), because `kubeadm init` can't run during an image build.
#
# Built on the rockDemo ubuntu-systemd image, so it has a real systemd as PID 1.
# That lets containerd and the kubelet run as ordinary systemd services and the
# manual CNCF kubeadm procedure run verbatim — no entrypoint or `systemctl` shim.
# The base image's boot units already make / rshared (kubelet + Cilium bpffs) and
# set a real upstream DNS resolver.
#
# MUST run --privileged (Kubernetes needs cgroup/mount/netlink access) AND boot
# systemd. Under rockDemo, give the node "docker": true (privileged) and
# "systemd": true (boots /sbin/init) — see config/backends.json.
#
# Published to GHCR by .github/workflows/docker-image.yml. Build locally with:
#   docker build -t ghcr.io/rockops/rockdemo/kubernetes-kubeadm-1node:24.04 \
#     docker/kubernetes-kubeadm-1node
FROM ghcr.io/rockops/rockdemo/ubuntu-systemd:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Build-time tool downloads (not pre-pulled container images — see VERSIONS.md).
ARG CRICTL_VERSION=v1.33.0
ARG CNI_PLUGINS_VERSION=v1.5.1
ARG TARGETARCH=amd64

# Single source of truth for the Kubernetes + Cilium versions. Edit versions.env,
# rebuild, done — the apt pins, apt repo minor, control-plane image tags, Cilium
# manifest tags and the pre-pulled cache all follow from it. COPYed first so a
# version bump invalidates the cache from here down. See versions.env / VERSIONS.md.
COPY versions.env /etc/rockdemo-versions.env

# --- Kubernetes apt repo + kubelet/kubeadm/kubectl + containerd + helpers ---
# This mirrors the apt steps in scenarios/install-kubernetes/step1/step1.md, so
# by the time a shell appears the only thing left to run is `kubeadm init`.
# conntrack/socat/ethtool/iptables are kubeadm runtime/preflight dependencies;
# containerd is the CRI runtime (the base image's docker.io already pulls it in,
# installed explicitly here to be self-contained). The apt repo minor (K8S_MINOR)
# and package pin (KUBE_PKG_VERSION) are DERIVED from KUBERNETES_VERSION, so that
# version lives in exactly one place.
RUN . /etc/rockdemo-versions.env \
 && K8S_MINOR="v$(echo "$KUBERNETES_VERSION" | cut -d. -f1,2)" \
 && KUBE_PKG_VERSION="${KUBERNETES_VERSION}-1.1" \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL "https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/deb/Release.key" \
      | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/deb/ /" \
      > /etc/apt/sources.list.d/kubernetes.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      apt-transport-https \
      software-properties-common \
      bash-completion \
      containerd \
      conntrack \
      socat \
      ethtool \
      iptables \
      iproute2 \
      kmod \
      procps \
      mount \
      "kubelet=${KUBE_PKG_VERSION}" "kubeadm=${KUBE_PKG_VERSION}" "kubectl=${KUBE_PKG_VERSION}" \
 && apt-mark hold kubelet kubeadm kubectl \
 && rm -rf /var/lib/apt/lists/*

# --- crictl (kubeadm preflight uses it; handy for debugging) ---
RUN curl -fsSL "https://github.com/kubernetes-sigs/cri-tools/releases/download/${CRICTL_VERSION}/crictl-${CRICTL_VERSION}-linux-${TARGETARCH}.tar.gz" \
      | tar -C /usr/local/bin -xz \
 && printf 'runtime-endpoint: unix:///run/containerd/containerd.sock\nimage-endpoint: unix:///run/containerd/containerd.sock\n' \
      > /etc/crictl.yaml

# --- CNI plugins into /opt/cni/bin (loopback etc.; Cilium ships its own too) ---
RUN mkdir -p /opt/cni/bin \
 && curl -fsSL "https://github.com/containernetworking/plugins/releases/download/${CNI_PLUGINS_VERSION}/cni-plugins-linux-${TARGETARCH}-${CNI_PLUGINS_VERSION}.tgz" \
      | tar -C /opt/cni/bin -xz

# --- containerd: enable the CRI plugin and the systemd cgroup driver ---
# The distro containerd ships with CRI disabled; regenerate the default config,
# then pin SystemdCgroup=true to match the kubelet's systemd cgroup driver (this
# image has real systemd, unlike the old cgroupfs-based one).
RUN mkdir -p /etc/containerd \
 && containerd config default > /etc/containerd/config.toml \
 && sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml

# Run only the CRI runtime: the base image's Docker daemon isn't needed for a
# kubeadm node and would contend over containerd, so mask it. Enable containerd
# explicitly (kubelet.service is enabled by the kube* packages; it crash-loops
# until `kubeadm init` writes its config — expected on a fresh node).
RUN systemctl mask docker.service docker.socket 2>/dev/null || true \
 && systemctl enable containerd.service

# --- host prerequisites applied at boot (systemd-native, no entrypoint) ---
# br_netfilter/overlay loaded by systemd-modules-load; the bridge/forwarding
# sysctls applied by systemd-sysctl — so kubeadm preflight passes stock.
RUN printf 'overlay\nbr_netfilter\n' > /etc/modules-load.d/k8s.conf \
 && printf 'net.bridge.bridge-nf-call-ip6tables = 1\nnet.bridge.bridge-nf-call-iptables = 1\nnet.ipv4.ip_forward = 1\n' \
      > /etc/sysctl.d/k8s.conf

# --- cluster add-on manifests (applied at cluster start by the foreground scripts) ---
# Cilium (CNI) and Rancher local-path (storage). The Cilium cilium/operator tags
# are TEMPLATED (__CILIUM_VERSION__) and stamped here from versions.env, so the
# Cilium version lives in one place; the storage/busybox tags live in the
# local-path manifest.
COPY manifests/ /opt/rockdemo/manifests/
RUN . /etc/rockdemo-versions.env \
 && sed -i "s|__CILIUM_VERSION__|v${CILIUM_VERSION}|g" /opt/rockdemo/manifests/cilium-cni.yaml \
 && ! grep -q '__CILIUM_VERSION__' /opt/rockdemo/manifests/cilium-cni.yaml

# Runtime container images are NOT baked into this image. They are pulled from the
# network on the FIRST cluster start (by kubeadm/kubelet and by `kubectl apply` of
# the manifests above) into /var/lib/containerd — which rockDemo backs with a
# PERSISTENT named volume (see containerdCacheVolumeFor in src/extension.js). So
# the pull happens once per machine and every subsequent run starts from that warm
# cache. This keeps the image ~1.3 GB smaller than baking the tarballs in.

WORKDIR /root
# So kubectl in the interactive shell finds the cluster immediately once
# startup.sh has copied the admin kubeconfig here.
ENV KUBECONFIG=/root/.kube/config

# kubectl bash completion + a `k` alias, wired so completion works for BOTH
# `kubectl` and `k` (the `complete -F __start_kubectl k` line re-points the alias
# at kubectl's completion function). Appended to root's .bashrc, sourced by the
# interactive `docker exec ... bash` shell rockDemo attaches.
RUN { \
      echo ''; \
      echo '# rockDemo: kubectl completion + k alias'; \
      echo '# kubectl completion needs the bash-completion helpers (e.g.'; \
      echo '# _get_comp_words_by_ref); load them first if not already sourced.'; \
      echo 'if ! type _get_comp_words_by_ref >/dev/null 2>&1; then'; \
      echo '  [ -r /usr/share/bash-completion/bash_completion ] && . /usr/share/bash-completion/bash_completion'; \
      echo 'fi'; \
      echo 'source <(kubectl completion bash)'; \
      echo 'alias k=kubectl'; \
      echo 'complete -o default -F __start_kubectl k'; \
    } >> /root/.bashrc

# Inherit systemd as PID 1 (CMD ["/sbin/init"]) from the base image — no
# ENTRYPOINT override, so the node boots like a real host.
