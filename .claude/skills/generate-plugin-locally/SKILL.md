---
name: generate-plugin-locally
description: Generate the rockDemo extension as a local .vsix file with the next version, only locally, without pushing tags/commits or creating any MR/PR. Use when the user asks to "generate plugin locally", "package extension locally", "create local vsix", or "build local package".
---

# Generate rockDemo Plugin Locally

Standardize generating the `.vsix` extension package locally with a bumped version, without pushing commits, pushing tags, or opening a PR/MR. This is useful for transferring the extension to another machine to test it before making a release.

## Preconditions to verify

1. **NPM Tooling**: Make sure `npm` is available.
2. **Working Tree**: Uncommitted changes are fine because this is a local build, but it's good practice to inform the user that their active changes will be compiled into the package.

## Steps

1. **Determine current version**:
   Read the current version from `package.json`:
   ```bash
   node -p "require('./package.json').version"
   ```

2. **Decide the next version**:
   Propose the next version (defaulting to a `patch` bump, e.g., `1.2.6` -> `1.2.7`).
   Ask the user if they'd like to use a different version bump type (`minor`, `major`, or a specific custom version).

3. **Bump version locally (without git tags/commits)**:
   Run `npm version` with `--no-git-tag-version` to update `package.json` without making git commits or git tags:
   ```bash
   npm version <bump-type> --no-git-tag-version
   ```
   *Note: Bumping the version ensures that the generated `.vsix` has the new version number, making it easy to distinguish and install in VS Code.*

4. **Package the extension**:
   Run the package command:
   ```bash
   npx @vscode/vsce package
   ```
   This generates a file named `rockdemo-<version>.vsix` (e.g. `rockdemo-1.2.7.vsix`) in the project root directory.

5. **Provide installation/transfer instructions**:
   Inform the user:
   - **Location**: `/home/ben/src/rockdemo/rockdemo-<version>.vsix`
   - **Transfer suggestion**: Use a file transfer tool (e.g., `scp`, `rsync`, USB drive, etc.) to copy it to the other machine.
     - E.g., `scp rockdemo-<version>.vsix user@remote-machine:/path/to/destination/`
   - **Installation command on the other machine**:
     ```bash
     code --install-extension /path/to/rockdemo-<version>.vsix
     ```
     Or, in VS Code on the other machine: open the Extensions view, click the `...` menu in the top-right corner, select "Install from VSIX...", and choose the generated `.vsix` file.

## Notes / do-not

- **Never run `git push` or push tags.** Keep the version change entirely local.
- **Never publish to the marketplace.** Do not run `vsce publish` or push tag triggers.
- Remind the user that since the version was bumped in `package.json` without a commit, they might want to revert the `package.json` change (e.g. `git checkout package.json` or `git restore package.json`) if they want to discard the version bump before making their actual PR/MR.
