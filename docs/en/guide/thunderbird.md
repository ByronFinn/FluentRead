# Translate email in Thunderbird

FluentRead has a separate Thunderbird add-on for messages you are reading. Its settings are separate from the Firefox extension.

<GuideVisual kind="email" en />

## Build and install

1. Run `pnpm build:thunderbird` in the FluentRead source directory. The package is `.output/fluent-read-<version>-thunderbird.xpi`.
2. In Thunderbird 140 or later, open **Add-ons and Themes**, choose **Install Add-on From File**, and select the XPI.
3. Open FluentRead on the main toolbar to choose a service, languages, and display mode.

## Read email

Open a message and choose **Translate / Restore current message** on its toolbar. Reopen messages that were already open during installation to show the controls. Global automatic translation also applies to newly opened messages.

Translation sends the message text to your selected service, so choose a suitable service for private mail. The add-on handles displayed message bodies, not compose windows. Image OCR, area translation, and local speech playback are currently unavailable.

## Related guides

- [Choose a translation service](/en/config/translation-engines)
- [Data and privacy](/en/guide/privacy)
