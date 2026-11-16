#!/bin/zsh
set -euo pipefail

SCRIPT_DIR=${0:A:h}
EXTENSION_DIR="$SCRIPT_DIR/SafariDarkMode"
PROJECT_DIR=${1:-"$SCRIPT_DIR/SafariDarkModeApp"}

if [[ -e "$PROJECT_DIR" ]]; then
  print -u2 "The output path already exists: $PROJECT_DIR"
  print -u2 "Choose a new path or remove the old generated project first."
  exit 1
fi

xcrun safari-web-extension-converter \
  "$EXTENSION_DIR" \
  --project-location "$PROJECT_DIR" \
  --app-name "Safari Dark Mode" \
  --bundle-identifier "com.local.Safari-Dark-Mode" \
  --swift \
  --macos-only \
  --copy-resources \
  --no-open \
  --no-prompt

PROJECT_FILE="$PROJECT_DIR/Safari Dark Mode/Safari Dark Mode.xcodeproj/project.pbxproj"
if [[ -f "$PROJECT_FILE" ]]; then
  # Apple's converter defaults to an ad-hoc “Sign to Run Locally” identity,
  # which Safari hides unless unsigned-extension developer mode is enabled.
  /usr/bin/sed -i '' '/CODE_SIGN_IDENTITY.* = "-";/d' "$PROJECT_FILE"
fi

print "Created the Safari Xcode project at: $PROJECT_DIR"
print "Choose your development team for both targets before running it."
