# 使用油猴脚本

没有合适的扩展安装入口时，可通过 Tampermonkey、Violentmonkey、Via 或 Safari Userscripts 使用流畅阅读的核心网页翻译功能。支持情况取决于浏览器和脚本管理器。

<GuideVisual kind="userscript" />

## 直接安装

1. 安装并启用脚本管理器。
2. 打开 [流畅阅读 Greasy Fork 页面](https://greasyfork.org/zh-CN/scripts/482986)，按提示安装脚本。
3. 确认脚本已启用，刷新普通 HTTP(S) 网页，从悬浮球翻译或打开设置。

只保留一个流畅阅读脚本，避免重复运行。Greasy Fork 和源码构建分别更新；遇到问题时，以管理器中实际安装的版本为准。

Tampermonkey 在 Chromium 浏览器中还可能需要脚本执行权限，按 [官方说明](https://www.tampermonkey.net/faq.php?q=Q209) 开启。Edge Android 请使用其中的移动端步骤。

### 从源码构建独立脚本

在仓库中安装依赖后运行 `pnpm test:userscript:standalone`，将 `.output/userscript-standalone/fluent-read.user.js` 导入管理器。**Via 使用这个独立版**。

独立版包含运行所需的库，安装时无需额外下载依赖；翻译服务和首次使用部分界面语言仍需联网。它使用完整设置中心：桌面管理器支持时打开新标签页，Android 和其他管理器在当前网页显示设置面板。

其他构建用于已有对应需求的环境：

| 构建命令 | 文件 | 区别 |
| --- | --- | --- |
| `pnpm test:userscript` | `.output/userscript/fluent-read.user.js` | 精简版，安装时需下载依赖，使用简版设置 |
| `pnpm build:userscript:greasyfork` | `.output/userscript-greasyfork/fluent-read.user.js` | 为 Greasy Fork 准备的源码构建，需联网加载依赖，使用简版设置 |

本地构建不会更新 Greasy Fork 上的版本。独立版不适合直接提交到 Greasy Fork，可通过管理器安装本地文件。

## Via 安装与排查

1. 构建上面的独立版，打开 **设置 → 脚本 → + → 导入脚本**，选择生成的 `.user.js` 文件。
2. 启用脚本，停用其他流畅阅读副本，重新打开普通网页。
3. 悬浮球没有出现时，检查脚本开关、网页地址和已安装版本。

Via 的现有验证来自 Android 模拟器，真实设备和在线服务仍可能存在差异。反馈时附上 Via、Android、脚本版本及网页地址。

## Safari Userscripts 安装与排查

1. 从 App Store 安装 Userscripts，在系统的 Safari 扩展设置中启用，并允许访问当前网站。
2. 在 Safari 打开上面的 Greasy Fork 页面，按 Userscripts 提示安装。使用本地构建时，将 `.user.js` 放入 Userscripts 设置的脚本目录，再打开其弹出面板刷新文件列表。
3. 确认 **Enable Injection** 已开启，流畅阅读与当前网站匹配并启用，刷新网页。
4. 从网页悬浮球打开流畅阅读设置；Safari Userscripts 不提供脚本菜单命令。

手动替换脚本后，也需打开 Userscripts 面板刷新文件列表。没有悬浮球时，检查网站权限、地址匹配和依赖是否下载完成。网页访问权限与服务域名权限分别受管理器控制，请按实际提示授权；允许当前网站不代表所有服务都可访问。

更多管理器说明见 [Userscripts 官方文档](https://github.com/quoid/userscripts/tree/release/4.x.x)。Safari Userscripts 的实际行为仍需设备验证。

## 可以做什么？

支持网页翻译与恢复、划词和悬浮翻译，以及管理器支持的输入翻译、复制和朗读。可选择免费、云端、AI 或自定义服务。

油猴版不提供图片识别、区域截图翻译、Chrome 内置翻译、视频字幕、写作辅助、翻译统计和模型用量；扩展右键菜单与弹出面板布局设置也不适用。

## 数据与隐私

配置保存在脚本管理器的私有存储中，翻译文字发送给所选服务。精简版安装时从 jsDelivr 下载依赖，独立版已包含这些库。

中文和英文界面随脚本提供；日语、韩语、法语、俄语、西班牙语首次使用时从 jsDelivr 或 GitHub 下载并缓存。这些资源请求不包含网页文字或密钥；尚未缓存且离线时，界面暂时回退到中文。

## 相关文档

- [手机与 Safari](/guide/mobile-safari)
- [数据与隐私](/guide/privacy)
