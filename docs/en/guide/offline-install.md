---
title: Offline download & installation
description: Install FluentRead through an official ZIP package or CRXSOso when the extension store is unavailable.
---

# Offline download & installation

If the extension store is unavailable, download a ZIP and install it manually in desktop Chrome or Edge. Offline installation does not make online translation services work without an internet connection.

## Download the official offline package

Open the [official release page](https://github.com/FluentRead/FluentRead/releases/latest) and expand **Assets**:

- Choose `-chrome.zip` for Chrome.
- Choose `-edge.zip` for Edge. Older releases without it can use the Chrome package.
- For checksums, download `SHA256SUMS.txt` from the same release.

`-sources.zip` and GitHub’s automatic **Source code** downloads contain source code and cannot be installed directly.

You can also follow the instructions on [CRXSOso](https://www.crxsoso.com/webstore/detail/djnlaiohfaaifbibleebjggkghlmcpcj). It is a third-party distributor, so check its version before downloading.

## Install in Chrome / Edge

1. Extract the ZIP into a folder you intend to keep.
2. Enter `chrome://extensions` in the address bar, or `edge://extensions` in Edge.
3. Enable **Developer mode**, then choose **Load unpacked**.
4. Select the folder that directly contains `manifest.json`.
5. Pin FluentRead to the toolbar and refresh webpages that were already open.

Keep the extracted folder after installation. Copy browser internal addresses into the address bar; websites cannot open them directly.

## Update an offline installation

Manual installations do not receive store updates automatically. Export your data under **Backup & restore** and back up the installation folder first.

Download the new package for your browser, replace the contents of the **original installation folder**, and choose FluentRead’s **Reload** button on the extensions page. Refresh your webpages. Reusing the folder avoids duplicate installations. Update store installations through their store.

If two copies appear, disable the new one first and keep the original extension and its data. Export any data you need before deciding which copy to keep. An older package with a different extension ID does not migrate its data automatically. Keep the only copy with complete data installed until you have a usable backup.

Follow [Quick start](/en/guide/getting-started) to translate your first page.
