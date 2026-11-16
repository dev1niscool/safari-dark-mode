# Safari Dark Mode

A Safari Web Extension that automatically detects light websites and darkens them. Websites that already use a dark theme are left unchanged.

## What it does

- Samples the rendered page to distinguish light pages from dark pages.
- Changes light backgrounds to dark colors and adjusts text and borders for contrast.
- Preserves the original appearance of photos, video, canvas content, and background images.
- Watches dynamically loaded content so single-page apps stay dark.
- Includes global and per-website controls in the toolbar popup.

## Build and install

The ready-to-build Xcode project is included. Xcode is required to sign and install a Safari Web Extension.

1. Open `SafariDarkModeApp/Safari Dark Mode/Safari Dark Mode.xcodeproj` in Xcode.
2. Choose your Apple development team under **Signing & Capabilities** for both the **Safari Dark Mode** and **Safari Dark Mode Extension** targets, then click **Run**.
3. Quit and reopen Safari, open Safari → **Settings** → **Extensions**, then enable **Safari Dark Mode Extension** and allow website access.

The generated macOS app is only a container for the Safari extension. Keep it installed while using the extension.

To regenerate a fresh Xcode container after changing the extension source, give the helper a new output path:

```sh
./make-safari-project.sh SafariDarkModeApp-New
```

## Source layout

- `SafariDarkMode/content.js` detects page themes and performs color conversion.
- `SafariDarkMode/dark-mode.css` contains the safely scoped override rules.
- `SafariDarkMode/popup.*` implements the toolbar controls.
- `SafariDarkMode/manifest.json` defines the Safari Web Extension.

## Notes

Safari does not allow extensions to modify some built-in pages, such as its start page and settings. Those pages are reported as unavailable in the popup.

Safari 15.4 or newer is recommended for Manifest V3 support.

## Privacy

Safari Dark Mode collects no analytics, browsing history, personal information, or device identifiers. It makes no network requests. The extension stores only its enabled state and the hostnames the user explicitly excludes, using Safari's local extension storage.

The repository intentionally contains no development-team identifier, signing identity, local filesystem path, Xcode user state, or author name. Each person building the app supplies their own signing team locally in Xcode.
