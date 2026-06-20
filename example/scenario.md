# Demo: Hello from rockDemo

This is a Killercoda-style scenario. Open this file in the Extension
Development Host and you'll see clickable buttons appear above each block.

## Step 1 — Run a command

A `bash` block runs in the terminal by default (no annotation needed):

```bash
echo "Hello from rockDemo 👋"
```

## Step 2 — Explicit exec

Any block can be made runnable with the `{{exec}}` annotation:

```sh
python3 --version
```{{exec}}

## Step 3 — Copy only

Use `{{copy}}` for something the audience should copy but you don't want
to auto-run (e.g. a destructive or interactive command):

```bash
rm -rf ./build
```{{copy}}

## Step 4 — Open a file

Use `{{open}}` to jump to a file (path is relative to this scenario):

```text
../../hello/main.py
```{{open}}
