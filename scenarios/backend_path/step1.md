# Step 1: Verify Alpine Node

Verify that the `node1` container was started properly using the external `backend.json`:

```sh
cat /etc/os-release
```

```sh
uname -a
```

Verify that the backend background script executed:

```sh
cat /var/log/rockdemo/backend_path/node1_backend_background.log
```

