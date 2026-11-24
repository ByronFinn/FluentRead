---
title: 离线下载与安装
description: Chrome 商店无法访问时，通过官方 ZIP 包或 CRX搜搜安装流畅阅读。
---

# 离线下载与安装

无法访问扩展商店时，可下载 ZIP 包，在电脑上的 Chrome 或 Edge 中手动安装。离线安装不代表离线翻译；在线服务仍需联网。

## 下载官方离线包

打开 [官方发布页](https://github.com/FluentRead/FluentRead/releases/latest)，展开 **Assets**：

- Chrome 选择 `-chrome.zip`。
- Edge 选择 `-edge.zip`；没有 Edge 包的旧版本可用 Chrome 包。
- 如需校验，下载同一版本的 `SHA256SUMS.txt`。

`-sources.zip` 和 GitHub 自动生成的 **Source code** 是源码，不能直接安装。

也可使用 [CRX搜搜](https://www.crxsoso.com/webstore/detail/djnlaiohfaaifbibleebjggkghlmcpcj)，按站内说明下载或安装。它是第三方分发网站，下载前请核对版本。

## 安装到 Chrome / Edge

1. 将 ZIP 解压到一个准备长期保留的文件夹。
2. 在地址栏输入 `chrome://extensions`；Edge 输入 `edge://extensions`。
3. 开启 **开发者模式**，点击 **加载已解压的扩展程序**。
4. 选择直接包含 `manifest.json` 的文件夹。
5. 将流畅阅读固定到工具栏，刷新安装前已经打开的网页。

安装后保留解压目录。浏览器内部地址需要复制到地址栏，不能从网页直接打开。

## 更新离线安装的版本

手动安装不会自动接收商店更新。先在设置的 **备份与恢复** 中导出数据，并备份原安装目录。

下载对应浏览器的新包，将内容覆盖到**原安装目录**，再到扩展管理页点击流畅阅读的 **重新加载**，最后刷新网页。复用原目录可避免重复安装。商店安装的版本请通过商店更新。

如果出现两个副本，先停用新副本，保留原扩展及其数据。分别导出需要的数据后，再确认安装包和保留版本。旧包若使用不同扩展 ID，数据不会自动迁移；在完整备份确认可用前，不要删除唯一持有完整数据的副本。

安装后可按 [快速开始](/guide/getting-started) 翻译第一篇网页。
