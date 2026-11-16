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

To regenerate a fresh Xcode container after changing the extension source, install Python 3 and give the helper a new output path. The helper removes generated author headers, native logging, signing settings, and unused permissions, then runs the privacy check:

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

The published source intentionally contains no personal author name, development-team identifier, signing identity, personal filesystem path, or Xcode user state. Each person building the app supplies their own signing team locally in Xcode. The native container does not request outbound network or user-selected file access.

A public GitHub repository still identifies its owning account. Source privacy checks do not make that account anonymous, remove existing copies, or guarantee security on every website.


## Development checks

The extension itself has no package dependencies. Node.js 20 or newer, Python 3, and Playwright are used only for development checks:

```sh
npm ci
npx playwright install chromium
npm test
npm run test:privacy
python3 scripts/check-privacy.py
python3 scripts/check-privacy.py --history
node --check SafariDarkMode/content.js
node --check SafariDarkMode/popup.js
python3 -m json.tool SafariDarkMode/manifest.json >/dev/null
```

Use `SDM_BROWSER_PATH` to test with an existing browser executable. Use `SDM_BROWSER=webkit npm test` after installing Playwright WebKit and its platform dependencies for an additional engine check. These tests use mocked extension APIs; they do not replace testing the installed extension in Safari.

After every source edit, copy matching files from `SafariDarkMode/` to `SafariDarkModeApp/Safari Dark Mode/Safari Dark Mode Extension/Resources/` and confirm that the directories match:

```sh
diff -qr SafariDarkMode "SafariDarkModeApp/Safari Dark Mode/Safari Dark Mode Extension/Resources"
```

Before distributing a source ZIP, run `python3 scripts/check-privacy.py --archive RELEASE.zip`. The checker scans candidate source files, including binary strings, for common personal paths, credentials, signing configuration, and unwanted artifacts. It is a guard against common mistakes, not an exhaustive personal-data detector. Git history needs its separate check above.

On macOS with Xcode, also build the unsigned container:

```sh
xcodebuild -quiet \
  -project "SafariDarkModeApp/Safari Dark Mode/Safari Dark Mode.xcodeproj" \
  -scheme "Safari Dark Mode" -configuration Release \
  -derivedDataPath "$TMPDIR/safari-dark-mode-build" \
  CODE_SIGNING_ALLOWED=NO build
```

Reload a page after changing its native theme if detection does not refresh. Closed shadow roots, ancestor-driven style changes, and some complex CSS colors remain limitations of generic color conversion.
