# Azure DevOps Personal Access Token (PAT) Guide

This document describes how to generate and update the Azure DevOps Personal Access Token (`VSCE_PAT`) required for publishing the **rockDemo** VS Code extension to the VS Code Marketplace.

---

## 1. Credentials & Token Management URL

- **Azure DevOps Token Management URL:**  
  [https://dev.azure.com/rockops0678/_usersSettings/tokens](https://dev.azure.com/rockops0678/_usersSettings/tokens)

- **Login Credentials:**  
  The credentials/password for the Azure DevOps account are stored in **KeePass** under:  
  `rockops / Compte Microsoft`

---

## 2. Generating a New PAT

1. Go to [https://dev.azure.com/rockops0678/_usersSettings/tokens](https://dev.azure.com/rockops0678/_usersSettings/tokens) (sign in using credentials from KeePass if prompted).
2. Click **+ New Token**.
3. Configure the token options:
   - **Name**: `vsce-rockdemo` (or descriptive name)
   - **Organization**: Select **All accessible organizations**  
     *(⚠️ **CRITICAL**: If set to a specific organization, `vsce publish` will fail with a `401 Access Denied` error).*
   - **Expiration**: Select duration (e.g. 90 days or 1 year)
   - **Scopes**: Select **Custom defined**, then click **Show all scopes** at the bottom of the page.
   - Scroll to **Marketplace** and check **Acquire** and **Manage**.
4. Click **Create** and copy the generated token string.

---

## 3. Updating the GitHub Repository Secret

After copying the new token, update the `VSCE_PAT` repository secret:

```bash
gh secret set VSCE_PAT
```
*(Paste the new PAT when prompted)*

Alternatively, update it via GitHub Web UI under **Settings → Secrets and variables → Actions → VSCE_PAT**.

---

## 4. Re-running a Failed Release Workflow

After updating the secret, re-run the failed GitHub Actions Release workflow:

```bash
gh run rerun <run_id>
```

For example, to re-run the `v1.2.7` release run:
```bash
gh run rerun 30165514527
```
