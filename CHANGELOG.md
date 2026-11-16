# Changelog

## Unreleased

- Fix early content-script startup before the document root exists.
- Stop mutation feedback loops and cancel stale work after disabling dark mode.
- Process queued work when an idle callback reaches its timeout.
- Preserve website-authored media filters and read popup status from the main frame.
- Remove unused native network and file-access permissions.
- Sanitize regenerated Xcode projects and add source, archive, and history privacy checks.
- Add automated browser regression checks for theme detection, controls, and dynamic content.

## 1.0.0 — 2026-11-15

- Detects whether a website is light or already dark.
- Selectively darkens light backgrounds, text, borders, and inline SVGs.
- Preserves already-dark websites, images, video, and canvas content.
- Handles dynamically inserted content.
- Adds global and per-website controls.
- Includes a native macOS Safari Web Extension container project.
