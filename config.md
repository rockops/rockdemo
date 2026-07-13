# Configuration Options

This document describes the configuration settings available for the **rockDemo** extension in VS Code. These settings can be configured via the VS Code Settings UI (search for `rockDemo`) or directly in your `settings.json` file.

---

## Settings Summary

| Setting Key | Type | Default Value | Description |
| :--- | :--- | :--- | :--- |
| [`rockdemo.scenarioLayout`](#rockdemoscenariolayout) | `string` | `"vertical"` | Layout orientation of instructions and terminals. |
| [`rockdemo.clearTerminalOnReady`](#rockdemoclearterminalonready) | `boolean` | `true` | Clear the terminal window when standard/foreground scripts finish. |
| [`rockdemo.restoreSidebar`](#rockdemorestoresidebar) | `boolean` | `true` | Restore the file explorer sidebar when exiting DEMO mode. |
| [`rockdemo.restorePanel`](#rockdemorestorepanel) | `boolean` | `true` | Restore the bottom panel (Terminal) when exiting DEMO mode. |
| [`rockdemo.restoreAgentPanel`](#rockdemorestoreagentpanel) | `boolean` | `true` | Restore the auxiliary bar (Agent Panel) when exiting DEMO mode. |

---

## Detailed Settings Description

### `rockdemo.scenarioLayout`
Defines the layout orientation of the scenario instructions (webview panel) and the node terminals.

* **Type**: `string`
* **Default**: `"vertical"`
* **Allowed Values**:
  * `"vertical"`: Places the scenario instructions on the left side of the editor area and node terminals in columns/grids to the right. (Ideal for widescreen displays).
  * `"horizontal"`: Places the scenario instructions on the top half of the editor area and node terminals side-by-side on the bottom half.
* **Example**:
  ```json
  "rockdemo.scenarioLayout": "horizontal"
  ```

---

### `rockdemo.clearTerminalOnReady`
Controls whether node terminals are cleared after the shell becomes ready and all background/foreground startup scripts have finished running.

* **Type**: `boolean`
* **Default**: `true`
* **Allowed Values**:
  * `true`: Clears the terminal screen so you start the scenario step instructions with a clean terminal window.
  * `false`: Preserves all stdout/stderr logs and command outputs from the Docker container startup process in the terminal scrollback buffer. (Useful for debugging container bootstrap issues).
* **Example**:
  ```json
  "rockdemo.clearTerminalOnReady": false
  ```

---

### `rockdemo.restoreSidebar`
Determines if VS Code should automatically re-reveal the primary sidebar (File Explorer) when you exit DEMO mode or close/end a scenario.

* **Type**: `boolean`
* **Default**: `true`
* **Allowed Values**:
  * `true`: Shows the File Explorer sidebar if it was collapsed by entering DEMO mode.
  * `false`: Keeps the sidebar collapsed even after exiting DEMO mode.
* **Example**:
  ```json
  "rockdemo.restoreSidebar": true
  ```

---

### `rockdemo.restorePanel`
Determines if VS Code should automatically re-reveal the bottom panel (Terminal, Output, Debug Console) when you exit DEMO mode or close/end a scenario.

* **Type**: `boolean`
* **Default**: `true`
* **Allowed Values**:
  * `true`: Shows the bottom panel if it was collapsed by entering DEMO mode.
  * `false`: Keeps the bottom panel collapsed after exiting DEMO mode.
* **Example**:
  ```json
  "rockdemo.restorePanel": true
  ```

---

### `rockdemo.restoreAgentPanel`
Determines if VS Code should automatically re-reveal the Auxiliary Bar (Secondary Sidebar / Agent Panel) when you exit DEMO mode or close/end a scenario.

* **Type**: `boolean`
* **Default**: `true`
* **Allowed Values**:
  * `true`: Shows the Auxiliary Bar if it was collapsed by entering DEMO mode.
  * `false`: Keeps the Auxiliary Bar collapsed after exiting DEMO mode.
* **Example**:
  ```json
  "rockdemo.restoreAgentPanel": true
  ```
