# rockDemo "kubernetes-kubeadm-1node" image — a single-node Kubernetes cluster
# brought up with kubeadm, Ready by the time you reach a shell.
#
# Built on the rockDemo ubuntu image. The container runs WITHOUT a real init
# system (rockDemo launches it as `docker run -it <image> bash`), so the
# entrypoint starts containerd + the kubelet itself; a tiny `systemctl` shim
# lets `kubeadm init` "start" the kubelet the way it expects. kubelet and
# containerd both use the cgroupfs driver so no systemd is needed.
#
# MUST run --privileged (Kubernetes needs cgroup/mount/netlink access). Under
# rockDemo, give the node "docker": true so it launches privileged.
#
# Published to GHCR by .github/workflows (once wired). Build locally with:
#   docker build -t ghcr.io/rockops/rockdemo/kubernetes-kubeadm-1node:latest \
#     docker/kubernetes-kubeadm-1node
#
# Try it directly:
#   docker run -it --rm --privileged \
#     ghcr.io/rockops/rockdemo/kubernetes-kubeadm-1node:latest
FROM ghcr.io/rockops/rockdemo/ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive

# Pins. The pkgs.k8s.io repo is per-minor; patch level floats within it.
ARG K8S_MINOR=v1.31
ARG CRICTL_VERSION=v1.31.1
ARG CNI_PLUGINS_VERSION=v1.5.1
ARG FLANNEL_VERSION=v0.25.6
ARG HELM_VERSION=v3.16.2
ARG TARGETARCH=amd64

# --- Kubernetes apt repo + kubelet/kubeadm/kubectl + containerd + helpers ---
# conntrack/socat/ethtool/iptables are kubeadm runtime/preflight dependencies.
RUN install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL "https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/deb/Release.key" \
      | gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg \
 && echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] https://pkgs.k8s.io/core:/stable:/${K8S_MINOR}/deb/ /" \
      > /etc/apt/sources.list.d/kubernetes.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      containerd \
      conntrack \
      socat \
      ethtool \
      iptables \
      iproute2 \
      kmod \
      procps \
      mount \
      kubelet kubeadm kubectl \
 && apt-mark hold kubelet kubeadm kubectl \
 && rm -rf /var/lib/apt/lists/*

# --- crictl (kubeadm preflight uses it; handy for debugging) ---
RUN curl -fsSL "https://github.com/kubernetes-sigs/cri-tools/releases/download/${CRICTL_VERSION}/crictl-${CRICTL_VERSION}-linux-${TARGETARCH}.tar.gz" \
      | tar -C /usr/local/bin -xz \
 && printf 'runtime-endpoint: unix:///run/containerd/containerd.sock\nimage-endpoint: unix:///run/containerd/containerd.sock\n' \
      > /etc/crictl.yaml

# --- CNI plugins into /opt/cni/bin (where kubelet and flannel look) ---
RUN mkdir -p /opt/cni/bin \
 && curl -fsSL "https://github.com/containernetworking/plugins/releases/download/${CNI_PLUGINS_VERSION}/cni-plugins-linux-${TARGETARCH}-${CNI_PLUGINS_VERSION}.tgz" \
      | tar -C /opt/cni/bin -xz

# --- helm ---
RUN curl -fsSL "https://get.helm.sh/helm-${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" \
      | tar -xz -C /tmp \
 && install -m 0755 "/tmp/linux-${TARGETARCH}/helm" /usr/local/bin/helm \
 && rm -rf "/tmp/linux-${TARGETARCH}"

# --- containerd: enable the CRI plugin and use the cgroupfs driver ---
# The distro containerd ships with CRI disabled; regenerate the default config,
# then pin SystemdCgroup=false so it matches the kubelet's cgroupfs driver (we
# have no systemd to own the cgroup hierarchy).
RUN mkdir -p /etc/containerd \
 && containerd config default > /etc/containerd/config.toml \
 && sed -i 's/SystemdCgroup = true/SystemdCgroup = false/' /etc/containerd/config.toml

# --- bake the flannel CNI manifest so first boot needs no extra download ---
RUN mkdir -p /etc/kubernetes/addons \
 && curl -fsSL "https://github.com/flannel-io/flannel/releases/download/${FLANNEL_VERSION}/kube-flannel.yml" \
      -o /etc/kubernetes/addons/flannel.yml

# kubeadm config (cgroupfs driver, flannel pod CIDR, containerd CRI socket) and
# the boot scripts.
COPY kubeadm-config.yaml /etc/kubernetes/kubeadm-config.yaml
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY systemctl-shim.sh /usr/local/bin/systemctl
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/systemctl

WORKDIR /root
# So kubectl/helm in the interactive shell find the cluster immediately.
ENV KUBECONFIG=/root/.kube/config

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["bash"]
