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

# Pins. pkgs.k8s.io is per-minor; the kube* packages are pinned to a patch that
# matches the kubernetesVersion in the bundled kubeadm-config.yaml asset.
ARG K8S_MINOR=v1.33
ARG KUBE_PKG_VERSION=1.33.1-1.1
ARG CRICTL_VERSION=v1.33.0
ARG CNI_PLUGINS_VERSION=v1.5.1
ARG TARGETARCH=amd64

# --- Kubernetes apt repo + kubelet/kubeadm/kubectl + containerd + helpers ---
# This mirrors the apt steps in scenarios/install-kubernetes/step1/step1.md, so
# by the time a shell appears the only thing left to run is `kubeadm init`.
# conntrack/socat/ethtool/iptables are kubeadm runtime/preflight dependencies;
# containerd is the CRI runtime (the base image's docker.io already pulls it in,
# installed explicitly here to be self-contained).
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL "https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/deb/Release.key" \
      | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/deb/ /" \
      > /etc/apt/sources.list.d/kubernetes.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      apt-transport-https \
      software-properties-common \
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

WORKDIR /root
# So kubectl in the interactive shell finds the cluster immediately once
# startup.sh has copied the admin kubeconfig here.
ENV KUBECONFIG=/root/.kube/config

# Inherit systemd as PID 1 (CMD ["/sbin/init"]) from the base image — no
# ENTRYPOINT override, so the node boots like a real host.
