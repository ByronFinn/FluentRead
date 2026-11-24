# Use a script manager

Use Tampermonkey, Violentmonkey, Via, or Safari Userscripts for FluentRead’s core webpage translation when an extension is unavailable. Support depends on your browser and manager.

<GuideVisual kind="userscript" en />

## Install

1. Install and enable a script manager.
2. Open the [FluentRead Greasy Fork page](https://greasyfork.org/en/scripts/482986) and follow its installation prompts.
3. Confirm that the script is enabled. Reload a regular HTTP(S) page and use the floating button to translate or open settings.

Keep only one FluentRead script enabled. Greasy Fork and source builds update separately; check the version actually installed in your manager when troubleshooting.

Tampermonkey on Chromium browsers may also need permission to execute scripts. Follow its [official instructions](https://www.tampermonkey.net/faq.php?q=Q209), including the mobile steps for Edge Android.

### Build the standalone script from source

Install repository dependencies, run `pnpm test:userscript:standalone`, and import `.output/userscript-standalone/fluent-read.user.js` into your manager. **Use this standalone build for Via.**

It includes runtime libraries, so installation needs no extra dependency downloads. Translation services and first use of some interface languages still need internet access. It uses the full settings center: supported desktop managers open a new tab, while Android and other managers show settings over the current page.

Other builds are available for environments that need them:

| Build command | File | Difference |
| --- | --- | --- |
| `pnpm test:userscript` | `.output/userscript/fluent-read.user.js` | Slim build; downloads dependencies at installation and uses compact settings |
| `pnpm build:userscript:greasyfork` | `.output/userscript-greasyfork/fluent-read.user.js` | Source build prepared for Greasy Fork; downloads dependencies and uses compact settings |

A local build does not update the Greasy Fork listing. The standalone build is unsuitable for direct Greasy Fork submission; install its local file through a manager.

## Via setup and troubleshooting

1. Build the standalone script above. Open **Settings → Scripts → + → Import script** and select its `.user.js` file.
2. Enable it, disable other FluentRead copies, and reopen a regular webpage.
3. If the floating button is missing, check the script switch, page address, and installed version.

Existing Via checks used an Android emulator; physical devices and online services may behave differently. Include Via, Android, script versions, and the page URL when reporting a problem.

## Safari Userscripts setup and troubleshooting

1. Install Userscripts from the App Store. Enable it in the system’s Safari extension settings and allow access to the current site.
2. Open the Greasy Fork page in Safari and follow the Userscripts installation prompt. For a local build, put its `.user.js` file in the configured scripts directory, then open the Userscripts popup to refresh the file list.
3. Check **Enable Injection**, confirm FluentRead matches and is enabled for this site, then reload the page.
4. Open FluentRead settings from its page floating button. Safari Userscripts has no script menu commands.

After replacing a file manually, open the Userscripts popup to refresh its file list. If the floating button is missing, check site permissions, URL matching, and dependency downloads. Page access and service-domain access follow separate manager rules; allow additional access when needed. Permission for a page does not grant access to every service.

See the [official Userscripts documentation](https://github.com/quoid/userscripts/tree/release/4.x.x). Actual Safari Userscripts behavior still needs device verification.

## What it can do

Translate pages and restore originals, translate selections or hovered text, and use input translation, copying, and speech where the manager supports them. Choose free, cloud, AI, or custom services.

Userscripts do not provide image OCR, area capture, Chrome’s built-in translator, video subtitles, writing assistance, translation statistics, or model usage. Extension context-menu and popup-layout settings also do not apply.

## Data

Configuration stays in the manager’s private storage. Translation text goes to your selected service. Slim builds download libraries from jsDelivr at installation; the standalone build includes them.

Chinese and English interface text ships with the script. Japanese, Korean, French, Russian, and Spanish are downloaded from jsDelivr or GitHub on first use and cached. These requests contain no page text or keys. Before a language is cached, offline use temporarily falls back to Chinese.

## Related guides

- [Mobile and Safari](/en/guide/mobile-safari)
- [Data and privacy](/en/guide/privacy)
