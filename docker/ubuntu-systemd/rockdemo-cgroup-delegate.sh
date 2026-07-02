#!/bin/sh
# Enable cgroup v2 controller delegation so a nested kubelet can create
# kubepods.slice with the controllers it validates (cpu, cpuset, hugetlb,
# memory, pids). In a private cgroup namespace the container's root cgroup must
# list those in cgroup.subtree_control, but cgroup v2's "no internal processes"
# rule only allows enabling controllers on a cgroup that has NO member
# processes. containerd drops `docker exec` shells straight into the root cgroup
# whenever subtree_control is empty, which then blocks enabling controllers
# (EBUSY) — a self-perpetuating trap that leaves the kubelet stuck on "kubepods
# has some missing controllers".
#
# So: first relocate any processes sitting directly in the root cgroup into a
# leaf (this both satisfies the rule and RECOVERS an already-trapped state),
# then enable every available controller. Once subtree_control is non-empty the
# kernel keeps new processes out of the root, so it stays healthy. Idempotent —
# safe to run at boot and again before every kubelet start.
CG=/sys/fs/cgroup
[ -w "$CG/cgroup.subtree_control" ] || exit 0

# Move strays (interactive shells, etc.) out of the root cgroup. Kernel threads
# can't be moved — ignore those failures.
if [ -s "$CG/cgroup.procs" ]; then
  mkdir -p "$CG/rockdemo-stray" 2>/dev/null
  while read -r pid; do
    echo "$pid" > "$CG/rockdemo-stray/cgroup.procs" 2>/dev/null || true
  done < "$CG/cgroup.procs"
fi

# Delegate each available controller to child cgroups (kubepods.slice inherits).
for c in cpuset cpu io memory hugetlb pids; do
  if grep -qw "$c" "$CG/cgroup.controllers" 2>/dev/null; then
    echo "+$c" > "$CG/cgroup.subtree_control" 2>/dev/null || true
  fi
done
exit 0
