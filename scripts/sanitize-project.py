#!/usr/bin/env python3
"""Sanitize a newly generated Xcode container before it can be distributed."""

import pathlib
import re
import shutil
import sys


def sanitize(output):
    project = output / "Safari Dark Mode"
    settings = project / "Safari Dark Mode.xcodeproj/project.pbxproj"
    handler = project / "Safari Dark Mode Extension/SafariWebExtensionHandler.swift"
    # Refuse an unexpected converter layout instead of silently skipping privacy work.
    if not settings.is_file() or not handler.is_file():
        raise ValueError("Unexpected converter output; do not distribute this directory.")

    text = settings.read_text()
    signing = re.compile(
        r'^\s*"?(?:DEVELOPMENT_TEAM|DevelopmentTeam|PROVISIONING_' r'PROFILE(?:_SPECIFIER)?'
        r'|CODE_SIGN_IDENTITY|ORGANIZATIONNAME)(?:\[[^\]]+\])?"?\s*=.*;\s*$', re.MULTILINE
    )
    text = signing.sub("", text)
    text = re.sub(
        r'(^\s*INFOPLIST_KEY_NSHumanReadableCopyright\s*=)[^\n]*;',
        r'\1 "";', text, flags=re.MULTILINE
    )
    # The container displays bundled HTML and only opens Safari settings.
    text = re.sub(
        r'^\s*(?:ENABLE_OUTGOING_NETWORK_CONNECTIONS|ENABLE_USER_SELECTED_FILES)\s*=.*;\s*$',
        "", text, flags=re.MULTILINE
    )
    settings.write_text(text)

    for source in project.rglob("*.swift"):
        # Converter headers may contain the builder's name and copyright line.
        text = re.sub(r'\A(?:[ \t]*//[^\n]*\n|[ \t]*\n)*', "", source.read_text())
        source.write_text(text)

    handler.write_text('''import SafariServices

class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        // No native messaging or logging; page processing stays in the content script.
        context.completeRequest(returningItems: nil, completionHandler: nil)
    }
}
''')

    for path in sorted(project.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        if (path.name in {"xcuserdata", ".DS_Store"}
                or path.suffix in {".xcuserdatad", ".xcuserstate", ".xccheckout"}):
            if path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
            else:
                path.unlink()


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: sanitize-project.py NEW_OUTPUT_DIRECTORY")
    try:
        sanitize(pathlib.Path(sys.argv[1]))
    except (OSError, ValueError) as error:
        sys.exit(str(error))
