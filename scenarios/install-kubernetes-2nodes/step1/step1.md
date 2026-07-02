# Install Kubernetes — control plane

Build a 2-node cluster with `kubeadm`. This first part runs on the
**control-plane** node (`host01`); the worker (`node01`) is set up at the end.

Refresh the package index and upgrade installed packages:

```bash
apt-get update && apt-get upgrade -y
```

Install supporting tools used later — HTTPS transport for apt, CA certificates,
`socat` (needed by `kubectl port-forward`), and `tree`:

```bash
apt install apt-transport-https tree \
software-properties-common ca-certificates socat -y
```

Turn off swap — the kubelet refuses to run with swap enabled (it breaks pod
memory accounting):

```bash
swapoff -a
```

Load the kernel modules Kubernetes networking relies on: `overlay` (container
layer filesystem) and `br_netfilter` (so bridged pod traffic is seen by
iptables):

```bash
modprobe overlay
modprobe br_netfilter
```

Tell the kernel to send bridged traffic through iptables and to allow IP
forwarding — required for pod/service routing and node-to-node traffic:

```bash
cat << EOF | tee /etc/sysctl.d/kubernetes.conf
net.bridge.bridge-nf-call-ip6tables = 1
net.bridge.bridge-nf-call-iptables = 1
net.ipv4.ip_forward = 1
EOF
```

Apply those sysctls immediately, without a reboot:

```bash
sysctl --system
```

Create the directory that will hold apt repository signing keys:

```bash
mkdir -p /etc/apt/keyrings
```

Add Docker's GPG key — it signs the `containerd.io` package (the container
runtime the kubelet drives):

```bash
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
| sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
```

Register Docker's apt repository (where `containerd.io` comes from):

```bash
echo \
"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu \
$(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

Install the containerd runtime:

```bash
apt-get update && apt-get install containerd.io -y
```

Generate containerd's default configuration file:

```bash
containerd config default | tee /etc/containerd/config.toml
```

Switch containerd to the **systemd** cgroup driver — it must match the kubelet's
driver, or pods fail to start:

```bash
sed -e 's/SystemdCgroup = false/SystemdCgroup = true/g' -i /etc/containerd/config.toml
```

Restart containerd so the new config takes effect:

```bash
systemctl restart containerd
```

Add the Kubernetes v1.33 apt repository signing key:

```bash
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.33/deb/Release.key \
| sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
```

Register the Kubernetes v1.33 apt repository:

```bash
echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] \
https://pkgs.k8s.io/core:/stable:/v1.33/deb/ /" \
| sudo tee /etc/apt/sources.list.d/kubernetes.list
```

Refresh the index so the new Kubernetes repo is visible:

```bash
apt-get update
```

Install the core Kubernetes tools pinned to 1.33.1 — `kubeadm` (cluster
bootstrap), `kubelet` (per-node agent), `kubectl` (CLI):

```bash
apt-get install -y kubeadm=1.33.1-1.1 kubelet=1.33.1-1.1 kubectl=1.33.1-1.1
```

Hold these packages so a later `apt upgrade` can't silently change the cluster
version:

```bash
apt-mark hold kubelet kubeadm kubectl
```

Find this node's IP address — you'll map the `k8scp` alias to it next:

```bash
hostname -i
```

```bash
ip addr show
```

Edit `/etc/hosts` and add a line mapping the control-plane endpoint alias to
this node's IP (`172.30.1.2 k8scp`). Using an alias instead of a raw IP lets you
move/rename the endpoint later without regenerating certificates:

```bash
vim /etc/hosts
```

Copy the cluster configuration below (the inline comments explain each choice):

```
apiVersion: kubeadm.k8s.io/v1beta4
kind: ClusterConfiguration
kubernetesVersion: 1.33.1 #<-- Use the word stable for newest version
controlPlaneEndpoint: "k8scp:6443" #<-- Use the alias we put in /etc/hosts not the IP
networking:
  podSubnet: 10.244.0.0/16 #<-- Avoid 192.168.0.0/16: it overlaps a typical LAN and breaks host access to published ports
---
# kube-proxy runs in this node's own network namespace, which can't write the
# global net/netfilter/nf_conntrack_max sysctl (permission denied, even when
# privileged). maxPerCore/min: 0 tell kube-proxy not to touch it — the standard
# setting for kubeadm inside a container (same as kind/k3d use).
apiVersion: kubeproxy.config.k8s.io/v1alpha1
kind: KubeProxyConfiguration
conntrack:
  maxPerCore: 0
  min: 0
```{{copy}}

Open `kubeadm-config.yaml` and paste the config you just copied, then save:

```bash
vim kubeadm-config.yaml
```

Bootstrap the control plane. `--config` uses the file above, `--upload-certs`
stashes the certs (so extra control planes could join), and `--node-name=cp`
names this node; the output is saved to `kubeadm-init.out`:

```bash
kubeadm init --config=kubeadm-config.yaml --upload-certs --node-name=cp \
| tee kubeadm-init.out
```

Point `kubectl` at the cluster by copying the admin kubeconfig `kubeadm` just
generated into root's home (without this, the `kubectl` commands below can't
reach the API server):

```bash
mkdir -p $HOME/.kube
cp -i /etc/kubernetes/admin.conf $HOME/.kube/config
```

Install the Cilium CNI (staged into `/root`). Until a CNI is running, pods get
no networking and nodes stay `NotReady`; the DaemonSet also auto-installs onto
the worker when it joins:

```bash
kubectl apply -f cilium-cni.yaml
```

Remove the default control-plane taint so this node can also schedule workloads
(convenient for a small demo cluster):

```bash
kubectl taint nodes --all node-role.kubernetes.io/control-plane-
```

# Add the worker node (`node01`)

Everything above ran on the **control plane** (`host01`). Now switch to the
**`node01`** terminal (the second node, `host02`) and prepare it as a worker.

> ⚠️ **Run this whole section in the `node01` terminal** — click that terminal
> tab first. `{{exec}}` sends commands to the *active* terminal, so make sure
> node01 is selected before running anything below.

## 1. Base setup on node01 (same tooling as the control plane)

A worker needs the exact same runtime and tools as the control plane, so this
repeats the base install on `node01`.

Refresh and upgrade packages:

```bash
apt-get update && apt-get upgrade -y
```

Install the supporting tools:

```bash
apt install apt-transport-https tree \
software-properties-common ca-certificates socat -y
```

Disable swap (kubelet requirement):

```bash
swapoff -a
```

Load the required kernel modules:

```bash
modprobe overlay
modprobe br_netfilter
```

Apply the networking sysctls (bridged traffic through iptables + IP forwarding):

```bash
cat << EOF | tee /etc/sysctl.d/kubernetes.conf
net.bridge.bridge-nf-call-ip6tables = 1
net.bridge.bridge-nf-call-iptables = 1
net.ipv4.ip_forward = 1
EOF
```

```bash
sysctl --system
```

Create the apt keyrings directory:

```bash
mkdir -p /etc/apt/keyrings
```

Add Docker's key and repo (for `containerd.io`):

```bash
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
| sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
```

```bash
echo \
"deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu \
$(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
```

Install containerd:

```bash
apt-get update && apt-get install containerd.io -y
```

Generate its config and switch to the systemd cgroup driver:

```bash
containerd config default | tee /etc/containerd/config.toml
```

```bash
sed -e 's/SystemdCgroup = false/SystemdCgroup = true/g' -i /etc/containerd/config.toml
```

Restart containerd:

```bash
systemctl restart containerd
```

Add the Kubernetes v1.33 repo key and repo:

```bash
curl -fsSL https://pkgs.k8s.io/core:/stable:/v1.33/deb/Release.key \
| sudo gpg --dearmor -o /etc/apt/keyrings/kubernetes-apt-keyring.gpg
```

```bash
echo "deb [signed-by=/etc/apt/keyrings/kubernetes-apt-keyring.gpg] \
https://pkgs.k8s.io/core:/stable:/v1.33/deb/ /" \
| sudo tee /etc/apt/sources.list.d/kubernetes.list
```

```bash
apt-get update
```

Install the pinned Kubernetes tools (a worker only strictly needs `kubeadm` +
`kubelet`, but installing `kubectl` too keeps both nodes identical):

```bash
apt-get install -y kubeadm=1.33.1-1.1 kubelet=1.33.1-1.1 kubectl=1.33.1-1.1
```

```bash
apt-mark hold kubelet kubeadm kubectl
```

Point the `k8scp` alias at the **control-plane** node's IP (its static address —
see `config/backends.json`), so the join can reach the API server:

```bash
echo "172.30.1.2 k8scp" >> /etc/hosts
```

## 2. Get the join command (on the **control plane**)

Switch back to the **control-plane** (`host01`) terminal and print a fresh
worker join command — it mints a bootstrap token and computes the CA hash for
you:

```bash
kubeadm token create --print-join-command
```

Copy the printed line. It looks like:
`kubeadm join k8scp:6443 --token <TOKEN> --discovery-token-ca-cert-hash sha256:<HASH>`

## 3. Join as a **worker** (back on `node01`)

Switch to the **node01** terminal and run the join command you copied —
**exactly as printed, no extra flags.** The node is named `node01` automatically
(from its hostname), and the image already satisfies kubeadm's
`SystemVerification` preflight, so the stock command just works:

> ⚠️ **Do NOT add `--control-plane`.** That flag makes node01 a *second
> control-plane / etcd member*, which breaks the single-member etcd and takes
> the whole cluster down. The worker join is the plain command as printed.

```
kubeadm join k8scp:6443 --token <TOKEN> --discovery-token-ca-cert-hash sha256:<HASH>
```{{copy}}

## 4. Verify (on the **control plane**)

List the nodes — both should appear, and reach `Ready` once node01's Cilium pod
is running (the CNI DaemonSet schedules onto the new node automatically, so
there's no separate CNI install on the worker):

```bash
kubectl get nodes -o wide
```
