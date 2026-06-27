# Install Kubernetes


```bash
apt-get update && apt-get upgrade -y
```

```bash
apt install apt-transport-https tree \
software-properties-common ca-certificates socat -y
```

```bash
swapoff -a
```

```bash
modprobe overlay
modprobe br_netfilter
```

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

```bash
mkdir -p /etc/apt/keyrings
```

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


```bash
apt-get update && apt-get install containerd.io -y
```

```bash
containerd config default | tee /etc/containerd/config.toml
```

```bash
sed -e 's/SystemdCgroup = false/SystemdCgroup = true/g' -i /etc/containerd/config.toml
```

```bash
systemctl restart containerd
```

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


```bash
apt-get install -y kubeadm=1.33.1-1.1 kubelet=1.33.1-1.1 kubectl=1.33.1-1.1
```


```bash
apt-mark hold kubelet kubeadm kubectl
```

```bash
hostname -i
```
```bash
ip addr show
```
```bash
vim /etc/hosts
```
```
apiVersion: kubeadm.k8s.io/v1beta4
kind: ClusterConfiguration
kubernetesVersion: 1.33.1 #<-- Use the word stable for newest version
controlPlaneEndpoint: "k8scp:6443" #<-- Use the alias we put in /etc/hosts not the IP
networking:
  podSubnet: 192.168.0.0/16
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
---
# SystemVerification preflight can't pass in a container: it runs `modprobe
# configs` to read the kernel build config, but this host kernel has
# CONFIG_IKCONFIG unset (no module, no /proc/config.gz). Ignoring it here keeps
# the `kubeadm init` command stock — no --ignore-preflight-errors flag needed.
apiVersion: kubeadm.k8s.io/v1beta4
kind: InitConfiguration
nodeRegistration:
  ignorePreflightErrors:
    - SystemVerification
```{{copy}}

```bash
kubeadm init --config=kubeadm-config.yaml --upload-certs --node-name=cp \
| tee kubeadm-init.out
```




```bash
kubectl taint nodes --all node-role.kubernetes.io/control-plane-
```
