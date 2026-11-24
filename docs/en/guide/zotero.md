# Zotero literature translation

FluentRead’s experimental Zotero desktop plugin translates PDFs and selected text, then saves translated attachments or bilingual notes. Install and configure it separately from the browser extension.

## Install

1. Run `pnpm build:zotero` in the FluentRead repository root to create `integrations/zotero/dist/fluentread-zotero.xpi`.
2. In Zotero, open **Tools → Plugins**, choose **Install Plugin From File** from the gear menu, and select the XPI.
3. Open the FluentRead workspace to configure languages and a service.

The plugin currently requires a source build and has no automatic update channel. Its compatibility declaration targets Zotero 7–10. Existing checks mainly cover Zotero 10 on macOS; other versions and platforms still need validation. Try a test library first.

## Configure translation

The default detects the source language and translates into Simplified Chinese. Options include:

- **Microsoft Translator:** no model API key required.
- **OpenAI-compatible services:** enter a Chat Completions endpoint, model, and API key. Use HTTPS for remote endpoints; local models can use HTTP loopback addresses.
- **Terminology:** set fixed translations for terms in this document.
- **Output:** choose a bilingual or translation-only PDF and whether to open it when finished.

Settings are separate from the browser extension; its keys are not read or synchronized.

## Translate and continue reading

1. Select library items with local PDFs, or PDF attachments directly, and add them to the queue from the FluentRead menu.
2. Follow progress in the workspace. Documents run sequentially. Pause to keep completed passages, continue to process the remainder, or retry a failed task.
3. The translated PDF becomes a new attachment under the original item, preserving the original file. Standalone PDF results stay in the original library and collections. You can also save bilingual notes organized by page.

Closing or disabling the plugin pauses unfinished tasks; new requests start only when you continue. Language and service changes apply to new tasks. Existing tasks keep their original settings. If the source PDF changes, create a new task. Clearing task history does not delete generated PDFs or notes.

For a short passage, select text in Zotero’s PDF reader and use the FluentRead action. It uses the workspace’s service and languages.

## Files and data

Only PDFs with a text layer are supported. Scans need OCR first. EPUB, the web library, and mobile apps are unsupported. Output layout and page count may differ, and original annotations do not transfer automatically.

PDF parsing and generation happen locally. Translation sends text and necessary instructions to your selected service, without uploading the complete PDF to FluentRead’s cloud. The plugin collects no telemetry. Settings and progress stay in `fluentread/` in the Zotero profile. Keys are stored separately in local `credentials.json`, excluded from tasks and notes; this file is not encrypted.

The first export may download about 5 MB of openly licensed fonts, verified and cached for reuse. Font requests contain no paper text, translations, or keys.

If saving fails, check that the library is writable. If a PDF is missing, download the attachment or locate its file in Zotero first. See the [Zotero plugin directory](https://github.com/FluentRead/FluentRead/tree/main/integrations/zotero) for source and build instructions.
