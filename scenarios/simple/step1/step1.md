# Demo: Hello from rockDemo

This is a Killercoda-style scenario. Open this file in the Extension
Development Host and you'll see clickable buttons appear above each block.

## Step 1 — Run a command

A `bash` block runs in the terminal by default (no annotation needed):

```bash
echo "Hello from rockDemo 👋"
```

```bash
cat /var/log/rockdemo/simple/intro_background.log
```


```bash
echo "Changing background to grey!"
```{{exec background=lightgrey}}

```bash
echo "Returning terminal to default style"
```{{exec background=default}}

## Step 2 — Explicit exec

Any block can be made runnable with the `{{exec}}` annotation:

```sh
python3 --version
```{{exec}}

```sh
echo "I am host3"
```{{exec target=host3}}


## Step 3 — Copy only

Use `{{copy}}` for something the audience should copy but you don't want
to auto-run (e.g. a destructive or interactive command):

```bash
rm -rf ./build
```{{copy}}

## Step 4 — Open a file

Use `{{open}}` with a **container path**: rockDemo opens the host copy that is
bind-mounted there, so edits are live inside the container.

```text
/var/killercoda/solution/solution1/first.txt
```{{open}}
