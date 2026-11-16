#!/usr/bin/env python3
"""Regression tests using synthetic identities; no actual credentials or user data."""

import importlib.util
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest
import zipfile


ROOT = pathlib.Path(__file__).resolve().parents[1]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / (name + ".py"))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


audit = module("check-privacy")
sanitizer = module("sanitize-project")


class PrivacyTests(unittest.TestCase):
    def test_sensitive_patterns(self):
        samples = [
            b"/" + b"Users/" + b"fixture/project/",
            b"DEVELOPMENT_" + b"TEAM = PLACEHOLDER;",
            b'"CODE_SIGN_' + b'IDENTITY[sdk=macosx*]" = "-";',
            b"PROVISIONING_" + b"PROFILE_SPECIFIER = PLACEHOLDER;",
            b"fixture" + b"@" + b"example.invalid",
            b"-----BEGIN " + b"PRIVATE KEY-----",
            b"ghp_" + b"x" * 30,
            b"// Created " + b"by PLACEHOLDER",
        ]
        for sample in samples:
            with self.subTest(sample=sample):
                self.assertTrue(audit.inspect("source.txt", sample))

    def test_image_scale_names_are_not_emails(self):
        self.assertFalse(audit.inspect("Contents.json", b'"mac-icon-16@2x.png"'))

    def test_private_artifact_paths(self):
        for path in ("App.app/Contents/Info.plist", "settings/.env", "signing.p12",
                     "App.xcodeproj/xcuserdata/state", ".DS_Store"):
            with self.subTest(path=path):
                self.assertTrue(audit.inspect(path, b""))

    def test_handler_logging_is_rejected(self):
        self.assertTrue(audit.inspect("SafariWebExtensionHandler.swift", b'os_log("sample")'))

    def test_sanitize_generated_project(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = pathlib.Path(temporary)
            project = output / "Safari Dark Mode"
            shutil.copytree(ROOT / "SafariDarkModeApp/Safari Dark Mode", project)
            settings = project / "Safari Dark Mode.xcodeproj/project.pbxproj"
            settings.write_text(settings.read_text() + '\n'.join([
                "\nDEVELOPMENT_" + "TEAM = PLACEHOLDER;",
                '"CODE_SIGN_' + 'IDENTITY[sdk=macosx*]" = "-";',
                "PROVISIONING_" + "PROFILE = PLACEHOLDER;",
                "ENABLE_OUTGOING_NETWORK_CONNECTIONS = YES;",
                "ENABLE_USER_SELECTED_FILES = readonly;",
                'INFOPLIST_KEY_NSHumanReadableCopyright = "PLACEHOLDER";',
            ]) + "\n")
            source = project / "Safari Dark Mode/AppDelegate.swift"
            source.write_text("// Created " + "by PLACEHOLDER\n" + source.read_text())
            handler = project / "Safari Dark Mode Extension/SafariWebExtensionHandler.swift"
            handler.write_text('import SafariServices\n// placeholder converter handler\nos_log("sample")\n')
            state = project / "Safari Dark Mode.xcodeproj/xcuserdata"
            state.mkdir()
            (state / "state").write_text("placeholder")
            sanitizer.sanitize(output)
            self.assertNotIn("PLACEHOLDER", settings.read_text())
            self.assertNotIn("ENABLE_OUTGOING_NETWORK_CONNECTIONS", settings.read_text())
            self.assertNotIn("ENABLE_USER_SELECTED_FILES", settings.read_text())
            self.assertFalse(state.exists())
            self.assertFalse(audit.inspect(source.name, source.read_bytes()))
            self.assertFalse(audit.inspect(handler.name, handler.read_bytes()))
            self.assertIn("context.completeRequest", handler.read_text())
            result = subprocess.run([
                "python3", str(ROOT / "scripts/check-privacy.py"), "--directory", str(output)
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_unknown_converter_layout_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(ValueError):
                sanitizer.sanitize(pathlib.Path(temporary))

    def test_archive_scans_uncompressed_content(self):
        with tempfile.TemporaryDirectory() as temporary:
            archive = pathlib.Path(temporary) / "source.zip"
            secret = "fixture" + "@" + "example.invalid"
            with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as output:
                output.writestr("source/settings.txt", secret)
            result = subprocess.run([
                "python3", str(ROOT / "scripts/check-privacy.py"), "--archive", str(archive)
            ], capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("email address", result.stdout)
            self.assertNotIn(secret, result.stdout)

    def test_history_checks_removed_files_and_commit_identities(self):
        with tempfile.TemporaryDirectory() as temporary:
            repo = pathlib.Path(temporary)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            environment = dict(os.environ)
            for role in ("AUTHOR", "COMMITTER"):
                environment[f"GIT_{role}_NAME"] = audit.NEUTRAL_IDENTITY[0]
                environment[f"GIT_{role}_EMAIL"] = audit.NEUTRAL_IDENTITY[1]

            def run(*arguments):
                subprocess.run(["git", "-C", str(repo), *arguments], env=environment,
                               check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

            source = repo / "source.txt"
            source.write_text("fixture" + "@" + "example.invalid")
            run("add", "source.txt")
            run("commit", "-qm", "Synthetic fixture")
            source.write_text("clean source")
            run("add", "source.txt")
            run("commit", "-qm", "Remove synthetic marker")
            self.assertFalse(audit.history_metadata_findings(repo))
            versions = list(audit.history_files(repo))
            self.assertEqual(len(versions), 2)
            self.assertEqual(sum(bool(audit.inspect(name, data)) for name, data in versions), 1)
            environment["GIT_AUTHOR_NAME"] = "PLACEHOLDER"
            run("commit", "--allow-empty", "-qm", "Synthetic identity")
            issues = audit.history_metadata_findings(repo)
            self.assertEqual(len(issues), 1)
            self.assertIn("non-neutral", issues[0])


if __name__ == "__main__":
    unittest.main()
