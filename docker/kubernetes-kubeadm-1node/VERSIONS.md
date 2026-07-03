# Managing versions in the kubeadm backend image

This image (`kubernetes-kubeadm-1node`, also used for the 2-node backend) bakes in
everything needed to bring up a `kubeadm` cluster fast: the Kubernetes tools, the
container runtime, and **every runtime container image pre-pulled as a tarball**
so the cluster starts from a warm cache with no network pulls (see
[`rockdemo-preload-images.sh`](rockdemo-preload-images.sh)).

## TL;DR — change a version

Edit **[`versions.env`](versions.env)** and rebuild. That's it:

```env
KUBERNETES_VERSION=1.33.1   # kubelet/kubeadm/kubectl + all control-plane images
CILIUM_VERSION=1.16.1       # cilium agent + operator images
```

```bash
docker build -t ghcr.io/rockops/rockdemo/kubernetes-kubeadm-1node:24.04 \
  docker/kubernetes-kubeadm-1node
```

Everything downstream is **derived** from those two values at build time — the apt
package pins, the apt repo minor, the control-plane image tags (via `kubeadm`),
the Cilium image tags in the manifest, and the pre-pulled image cache. Nothing is
restated, so the warm cache can never drift from what the cluster runs.

## How the derivation works

- **Kubernetes** — `versions.env` `KUBERNETES_VERSION` drives, in the
  [`Dockerfile`](Dockerfile): the apt pin (`kubelet/kubeadm/kubectl=<ver>-1.1`),
  the apt repo minor (`pkgs.k8s.io/.../v<major.minor>`), and — via
  `kubeadm config images list` pinned to the installed binary — all control-plane
  image tags (apiserver, etcd, coredns, kube-proxy, pause). The backend
  `kubeadm-config.yaml` files carry `kubernetesVersion: 0.0.0` as a placeholder
  that the foreground scripts rewrite at runtime to `kubeadm version -o short`, so
  there is no second Kubernetes version anywhere.
- **Cilium** — `versions.env` `CILIUM_VERSION` is stamped into the templated
  `__CILIUM_VERSION__` tags in [`manifests/cilium-cni.yaml`](manifests/cilium-cni.yaml)
  at build (cilium agent + operator). The preload list then greps `image:` out of
  the finished manifest, so preload matches exactly.

## What still lives in a manifest (not in versions.env)

These are separately-versioned artifacts; each has one home:

| Component | Where | Note |
| --- | --- | --- |
| **cilium-envoy** image | `manifests/cilium-cni.yaml` (real tag) | Its release tag isn't equal to the Cilium version and is constant across Cilium **patch** releases. Update it only when bumping the Cilium **minor**. |
| **local-path** provisioner + `busybox` | `manifests/local-path-storage.yaml` | Replace this file with the upstream manifest for the storage release you want. |
| **crictl**, **CNI plugins** | `Dockerfile` ARGs (`CRICTL_VERSION`, `CNI_PLUGINS_VERSION`) | Build-time tool downloads, not pre-pulled container images. |

## Recipes

### Bump Kubernetes (patch or minor)
Set `KUBERNETES_VERSION` in `versions.env`, rebuild. If you jump a **minor**,
also confirm the `CILIUM_VERSION` supports it. Nothing else to touch.

### Bump Cilium (patch, e.g. 1.16.1 → 1.16.2)
Set `CILIUM_VERSION` in `versions.env`, rebuild.

### Bump Cilium (minor, e.g. 1.16 → 1.17)
1. Set `CILIUM_VERSION` in `versions.env`.
2. Update the `cilium-envoy` tag in `manifests/cilium-cni.yaml` to the one that
   ships with that Cilium release (from the upstream chart / release notes).
3. Keep all cilium/operator tags as the `__CILIUM_VERSION__` placeholder, and
   keep images **tag-only** (no `@sha256:` — a digest-pinned ref won't resolve
   against a tag-imported image and would trigger a runtime pull).
4. Ensure `cluster-pool-ipv4-cidr` in the manifest still matches `podSubnet`
   (`10.244.0.0/16`) in the `kubeadm-config.yaml` files.
5. Rebuild.

### Bump storage
Replace `manifests/local-path-storage.yaml` with the upstream release manifest,
rebuild.

## Rebuild & verify

```bash
# Rebuild the base first if you changed docker/ubuntu-systemd.
docker build -t ghcr.io/rockops/rockdemo/kubernetes-kubeadm-1node:24.04 \
  docker/kubernetes-kubeadm-1node

# Confirm the preloaded tarballs match the versions you set:
docker run --rm --entrypoint ls ghcr.io/rockops/rockdemo/kubernetes-kubeadm-1node:24.04 \
  /opt/rockdemo/preload/
```

Then run a scenario that uses the `kubernetes-kubeadm-1node` /
`kubernetes-kubeadm-2nodes` backend and confirm the cluster reaches `Ready` with
**no** `Pulling` events (`kubectl get events -A | grep -i pulling` should be
empty — everything served from the baked-in cache).

CI (`.github/workflows/docker-image.yml`) rebuilds and publishes this image to
GHCR on pushes to `main` that touch `docker/kubernetes-kubeadm-1node/**`.
