#!/bin/sh
# Backend background: runs detached when the env starts. Output is captured to
# /var/log/rockdemo/<scenario>/<node>_backend_background.log inside the node.
update-ca-certificates
echo "$(hostname) booted at $(date)"
