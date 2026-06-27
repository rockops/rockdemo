#!/bin/sh
# Backend foreground: blocks the player's START button until the in-container
# Docker daemon (started Docker-in-Docker) is accepting connections.
echo 'Waiting for Docker to be ready...'
until docker info >/dev/null 2>&1; do sleep 1; done
echo 'Docker is ready.'
