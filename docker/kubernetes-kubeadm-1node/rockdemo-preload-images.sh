#!/bin/sh
# rockDemo: import the container images baked into this image (as tarballs under
# /opt/rockdemo/preload) into containerd's k8s.io namespace. Called by the backend
# foreground scripts at cluster start — so its output shows in the node's terminal
# and the user watches each image import — before `kubeadm init` / `kubeadm join`.
#
# WHY this exists: rockDemo mounts a FRESH anonymous volume at /var/lib/containerd
# at runtime (nested overlay-on-overlay can't work, so the inner containerd store
# must sit on a real filesystem — see startNamedContainer in src/extension.js).
# That volume shadows anything baked into the image at that path, so images
# pre-pulled into /var/lib/containerd during the build would be invisible at
# runtime. Instead we bake the images as docker-archive tarballs in a NORMAL
# image path (not shadowed) and import them here into the volume-backed store.
# Import is a local disk operation — no network — so kubeadm/Cilium/the worker
# join start from a warm cache instead of pulling ~1.3 GB every run.
#
# The refs (in images.list, written at build) are TAG-only and match exactly what
# kubeadm/kubelet and the manifests request, so containerd reports them present
# (imagePullPolicy IfNotPresent) and never re-pulls.

PRELOAD_DIR=/opt/rockdemo/preload
LIST="$PRELOAD_DIR/images.list"

# Nothing baked in → nothing to do (older builds / other images).
[ -f "$LIST" ] || exit 0

# containerd may still be coming up; wait for it (the caller already waited on
# crictl, but be self-contained).
i=0
until ctr version >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 120 ] && break
  sleep 1
done

# Import each image, one clean line per image, indented 4 spaces.
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  name="$(echo "$ref" | sed 's|[/:@]|_|g')"
  tar="$PRELOAD_DIR/${name}.tar"
  [ -f "$tar" ] || continue
  printf '    %s\n' "$ref"
  # Import into the k8s.io namespace (the one CRI/kubelet use). Tolerate a single
  # failed tar rather than aborting — a missing image just falls back to a pull.
  ctr -n k8s.io images import "$tar" >/dev/null 2>&1 || printf '    (import failed) %s\n' "$ref"
done < "$LIST"

# Unpack every imported image for the current platform so snapshots are ready
# (kubeadm/kubelet then start pods without an unpack or a pull). Best-effort.
for ref in $(ctr -n k8s.io images ls -q 2>/dev/null); do
  ctr -n k8s.io images unpack "$ref" >/dev/null 2>&1 || true
done
