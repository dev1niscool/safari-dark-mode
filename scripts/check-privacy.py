#!/usr/bin/env python3
"""Check source/release files without printing potentially sensitive matches.

Default: tracked files plus nonignored new files in the working tree.
--directory: every file in a generated source directory (excluding .git).
--archive: every member in a source ZIP, without extracting it.
--history: all reachable commit identities, messages, paths, and file versions.
This is a pattern-based guard, not a guarantee of anonymity or a history scrubber.
"""

import argparse
import pathlib
import re
import subprocess
import sys
import zipfile


CONTENT_PATTERNS = {
    "personal filesystem path": re.compile(rb"/(?:Users|home)/[^\s/]+/", re.I),
    "signing configuration": re.compile(
        rb'(?m)^\s*"?(?:DEVELOPMENT_TEAM|DevelopmentTeam|PROVISIONING_' rb'PROFILE(?:_SPECIFIER)?'
        rb'|CODE_SIGN_IDENTITY)(?:\[[^\]]+\])?"?\s*='
    ),
    "signing identity": re.compile(rb"Apple\s+Development:|Team" rb"Identifier\s*=", re.I),
    "email address": re.compile(
        rb"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.(?!png\b|jpg\b|svg\b)[A-Z]{2,}\b", re.I
    ),
    "private key": re.compile(rb"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    "access credential": re.compile(
        rb"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b"
    ),
    "generated author header": re.compile(rb"(?m)^\s*//\s*Created\s+by\s+", re.I),
}
FORBIDDEN_PATH = re.compile(
    r"(?:^|/)(?:\.git|\.DS_Store|xcuserdata|DerivedData|__MACOSX|_CodeSignature)(?:/|$)"
    r"|\.(?:xcuserdatad|xcuserstate|xcarchive|dSYM|app)(?:/|$)"
    r"|\.(?:mobileprovision|provisionprofile|p12|pfx|key|pem|ipa|pkg)$"
    r"|(?:^|/)\.env(?:\.[^/]*)?$", re.I
)
NEUTRAL_IDENTITY = ("Safari Dark Mode", "maintainers" + "@" + "example.invalid")


def inspect(name, data):
    findings = []
    if FORBIDDEN_PATH.search(name):
        findings.append("private or built artifact")
    for label, pattern in CONTENT_PATTERNS.items():
        matches = pattern.findall(data)
        if label == "email address":
            matches = [value for value in matches if value.decode() != NEUTRAL_IDENTITY[1]]
        if matches:
            findings.append(label)
    if name.endswith("SafariWebExtensionHandler.swift") and re.search(
        rb"\b(?:NSLog|os_log|print|Logger)\s*\(", data
    ):
        findings.append("native handler logging")
    return findings


def git(root, *arguments):
    return subprocess.check_output(["git", "-C", str(root), *arguments])


def history_files(root):
    seen = set()
    for commit in git(root, "rev-list", "--all").decode().splitlines():
        for entry in git(root, "ls-tree", "-r", "-z", commit).split(b"\0"):
            if not entry:
                continue
            metadata, name = entry.split(b"\t", 1)
            mode, kind, oid = metadata.split()
            key = (oid, name)
            if key in seen:
                continue
            seen.add(key)
            if kind != b"blob" or mode == b"120000":
                raise ValueError("History contains a submodule or symlink; inspect it before release.")
            yield name.decode(), git(root, "cat-file", "blob", oid.decode())


def history_metadata_findings(root):
    findings = []
    for commit in git(root, "rev-list", "--all").decode().splitlines():
        author, author_email, committer, committer_email, message = git(
            root, "show", "-s", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B", commit
        ).decode().split("\0", 4)
        if ((author, author_email) != NEUTRAL_IDENTITY
                or (committer, committer_email) not in {
                    NEUTRAL_IDENTITY, ("GitHub", "noreply" + "@" + "github.com")
                }):
            findings.append(f"commit {commit[:12]}: non-neutral author or committer identity")
        for issue in inspect("commit message", message.encode()):
            findings.append(f"commit {commit[:12]}: {issue}")
    for entry in git(root, "for-each-ref", "--format=%(objecttype) %(objectname)", "refs/tags").decode().splitlines():
        kind, oid = entry.split()
        if kind != "tag":
            continue
        text = git(root, "cat-file", "tag", oid)
        tagger = re.search(rb"(?m)^tagger (.*?) <(.*?)> ", text)
        if not tagger or tuple(value.decode() for value in tagger.groups()) != NEUTRAL_IDENTITY:
            findings.append(f"tag {oid[:12]}: non-neutral tagger identity")
        message = text.split(b"\n\n", 1)[-1]
        for issue in inspect("tag message", message):
            findings.append(f"tag {oid[:12]}: {issue}")
    return findings


def files(args):
    if args.archive:
        with zipfile.ZipFile(args.archive) as archive:
            for item in archive.infolist():
                if not item.is_dir():
                    yield item.filename, archive.read(item)
        return
    if args.directory:
        root = pathlib.Path(args.directory)
        paths = [p for p in root.rglob("*") if ".git" not in p.relative_to(root).parts]
    else:
        root = pathlib.Path(__file__).resolve().parents[1]
        if args.history:
            yield from history_files(root)
            return
        output = subprocess.check_output([
            "git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"
        ])
        paths = [root / name.decode() for name in output.split(b"\0") if name]
    for path in paths:
        name = path.relative_to(root).as_posix()
        if path.is_symlink():
            # Avoid silently following source links outside the audit scope.
            yield name, b""
            raise ValueError("Source symlink encountered; inspect its target before release.")
        if path.is_file():
            yield name, path.read_bytes()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--directory")
    group.add_argument("--archive")
    group.add_argument("--history", action="store_true")
    args = parser.parse_args()
    failed = False
    count = 0
    try:
        if args.history:
            for issue in history_metadata_findings(pathlib.Path(__file__).resolve().parents[1]):
                failed = True
                print(f"FAIL: {issue}")
        for name, data in files(args):
            count += 1
            findings = inspect(name, data)
            if findings:
                failed = True
                # Never echo matched credential/identity values.
                print(f"FAIL: {name}: {', '.join(findings)}")
    except (OSError, ValueError, subprocess.CalledProcessError, zipfile.BadZipFile) as error:
        print(f"Audit could not finish: {type(error).__name__}", file=sys.stderr)
        return 1
    if not count:
        print("Audit found no files; check the selected source.", file=sys.stderr)
        return 1
    print(f"{'FAIL' if failed else 'PASS'}: checked {count} source files.")
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
