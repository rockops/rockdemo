---
name: rebuild-docker-images
description: Build and push the custom Docker images in the docker/ directory using the GitHub Actions pipeline. Handles branching, staging only docker files, opening a PR, waiting for checks, merging to main, and monitoring the Docker images build workflow.
---

# Rebuild and Push Docker Images (rockDemo)

Standardize rebuilding and pushing custom Docker images located in the `docker/` folder. The Docker image pipeline ([.github/workflows/docker-image.yml](../../../.github/workflows/docker-image.yml)) builds and publishes the images to GHCR only when commits are pushed or merged into the `main` branch. Since `main` is protected, this must be done via a Pull Request.

## Preconditions to verify (in order)

1. **Tooling**: `gh auth status` must show an authenticated account. If not, stop and tell the user to run `gh auth login`.
2. **Locate Docker Changes**: Verify changes exist under the `docker/` folder (e.g. `docker/ubuntu/Dockerfile`, `docker/ubuntu-systemd/Dockerfile`, or `docker/kubernetes-kubeadm-1node/Dockerfile`).
3. **Checkout main**: Begin by switching to `main` and pulling the latest updates (`git checkout main && git pull`).

## Steps

1. **Create a dev branch**:
   Create a new branch from `main`:
   ```bash
   git checkout -b build/update-docker-images
   ```

2. **Stage and Commit ONLY the docker changes**:
   Avoid committing other modified files (like `src/extension.js` or configuration changes) unless they are strictly related to the Docker build.
   ```bash
   git add docker
   git commit -m "build: update Dockerfiles in docker/ directory"
   ```

3. **Push the branch**:
   Push the branch to the remote repository:
   ```bash
   git push -u origin build/update-docker-images
   ```

4. **Create a Pull Request**:
   Use the GitHub CLI to open a pull request into `main`:
   ```bash
   gh pr create --base main --head build/update-docker-images \
     --title "build: update custom docker images" \
     --body "Updates the Dockerfiles under the docker/ folder and rebuilds them via the GHA pipeline upon merge."
   ```

5. **Wait for PR validation checks**:
   Check status until the `CI/package` check completes:
   ```bash
   gh pr checks
   ```

6. **Merge the PR**:
   Once checks pass, merge the PR to push the changes into the `main` branch:
   ```bash
   gh pr merge --merge --delete-branch
   ```

7. **Monitor the Docker Images Pipeline**:
   Merging into `main` triggers the `Docker images` workflow (`.github/workflows/docker-image.yml`). Monitor the progress of this workflow:
   ```bash
   gh run list --workflow="Docker images" --limit 5
   ```
   Wait until the run corresponding to your merge commit successfully completes (indicated by a green checkmark `✓`).

## Notes / do-not

- **Do not commit unrelated files** like `src/extension.js` or scenario metadata files unless explicitly requested.
- **Do not push directly to main** as it will be rejected by the repository rules.
- **Never publish/release the VS Code extension** during this workflow. Rebuilding the Docker images is independent of publishing a new extension version.
