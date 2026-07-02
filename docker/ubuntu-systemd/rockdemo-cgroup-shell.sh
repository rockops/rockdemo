# rockDemo: relocate an interactive shell out of the cgroup v2 root.
#
# rockDemo attaches the shell (`docker exec -it bash`) in the first moments of
# container boot — before the boot-time delegation seed runs. In a private
# cgroup namespace `subtree_control` is still empty at that instant, so the
# kernel places the shell directly in the cgroup ROOT. A process in the root
# cgroup then blocks enabling controllers there ("no internal processes" rule),
# which stops a nested kubelet from creating kubepods.slice and it dies with
# "kubepods has some missing controllers".
#
# A process may move ITSELF between cgroups, so if this shell finds itself in
# the root cgroup, move it into a leaf and enable controller delegation. This
# self-heals the boot race regardless of timing. It's a no-op for every normal
# shell: once delegation is set the kernel keeps new shells out of the root, so
# /proc/self/cgroup is no longer "0::/" and the block below is skipped.
if [ "$(cat /proc/self/cgroup 2>/dev/null)" = "0::/" ]; then
  mkdir -p /sys/fs/cgroup/rockdemo-stray 2>/dev/null
  echo $$ > /sys/fs/cgroup/rockdemo-stray/cgroup.procs 2>/dev/null || true
  for c in cpuset cpu io memory hugetlb pids; do
    echo "+$c" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
  done
fi
