import importlib.util
import hashlib
import io
import json
from pathlib import Path
import socket
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("deploy", ROOT / "deploy.py")
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)

    def archive(self, name, link=None):
        archive = self.root / "test.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            entry = tarfile.TarInfo(name)
            if link is not None:
                entry.type, entry.linkname = tarfile.SYMTYPE, link
                tar.addfile(entry)
            else:
                entry.size = 3
                tar.addfile(entry, io.BytesIO(b"abc"))
        return archive

    def test_archive_rejects_parent_escape(self):
        with self.assertRaises(RuntimeError):
            deploy.extract(self.archive("../escape"), self.root / "out")

    def test_archive_rejects_absolute_escape(self):
        with self.assertRaises(RuntimeError):
            deploy.extract(self.archive("/escape"), self.root / "out")

    def test_archive_rejects_escaping_link(self):
        with self.assertRaises(RuntimeError):
            deploy.extract(self.archive("link", "../../escape"), self.root / "out")

    def test_archive_accepts_node_style_internal_link(self):
        deploy.extract(self.archive("bin/npm", "../lib/npm.js"), self.root / "out")
        self.assertTrue((self.root / "out/bin/npm").is_symlink())

    def test_archive_extracts_plain_file(self):
        deploy.extract(self.archive("source/test.py"), self.root / "out")
        self.assertEqual((self.root / "out/source/test.py").read_bytes(), b"abc")

    def test_archive_rejects_link_escape_after_prior_link_is_created(self):
        archive = self.root / "links.tar.gz"
        with tarfile.open(archive, "w:gz") as tar:
            for name, target in [("a", "."), ("b", "a/..")]:
                entry = tarfile.TarInfo(name)
                entry.type, entry.linkname = tarfile.SYMTYPE, target
                tar.addfile(entry)
        with self.assertRaises(RuntimeError):
            deploy.extract(archive, self.root / "out")

    def test_provenance_matches_cloud_snapshot_and_wiki_patch(self):
        provenance = json.loads((ROOT / "PROVENANCE.json").read_text())
        hashes = deploy.source_hashes()
        self.assertEqual(hashes["tem-twin-source.tar.gz"], provenance["tango"]["archive_sha256"])
        self.assertEqual(hashes["weknora.patch"], provenance["wiki"]["patch_sha256"])
        with tarfile.open(ROOT / "tem-twin-source.tar.gz") as source:
            for name, expected in provenance["tango"]["files_sha256"].items():
                self.assertEqual(hashlib.sha256(source.extractfile(name).read()).hexdigest(), expected)

    def test_vendored_archive_is_portable_and_has_no_runtime_credentials(self):
        with tarfile.open(ROOT / "tem-twin-source.tar.gz") as source:
            for item in source.getmembers():
                self.assertFalse(any(part.startswith("._") for part in Path(item.name).parts), item.name)
                self.assertFalse(any(part in ["node_modules", ".git", "__pycache__", ".env", "credentials"] for part in Path(item.name).parts), item.name)
                self.assertFalse(item.name.endswith((".whl", ".db", ".sqlite", ".pyc")), item.name)
        deploy.extract(ROOT / "tem-twin-source.tar.gz", self.root / "source")
        self.assertTrue((self.root / "source/tem_twin_autoscript/ASYNCROSCOPY_LICENSE").exists())

    def test_initialization_creates_private_persistent_keys_and_directories(self):
        config = deploy.initialize(self.root, 1000, ["wiki", "tango"])
        before = deploy.read_json(self.root / "wiki/environment.json")
        again = deploy.initialize(self.root, None, ["wiki", "tango"])
        self.assertEqual(config, again)
        self.assertEqual(before, deploy.read_json(self.root / "wiki/environment.json"))
        self.assertEqual(before["SERVER_HOST"], "127.0.0.1")
        self.assertEqual(config["ports"]["wiki"], 9080)
        self.assertEqual(stat.S_IMODE((self.root / "wiki/environment.json").stat().st_mode), 0o600)
        for name in ["imports", "harness", "checkpoints"]:
            self.assertTrue((self.root / "wiki-sync" / name).is_dir())

    def test_initialize_does_not_register_devices(self):
        deploy.initialize(self.root, 0, ["tango"])
        self.assertEqual(deploy.read_json(self.root / "tango/devices.json"), {})
        self.assertEqual(deploy.read_json(self.root / "tango/http-nodes.json"), {})

    def test_changing_existing_ports_is_rejected(self):
        deploy.initialize(self.root, 0, ["wiki"])
        with self.assertRaises(RuntimeError):
            deploy.initialize(self.root, 100, ["wiki"])

    def test_invalid_port_offset_is_rejected(self):
        with self.assertRaises(RuntimeError):
            deploy.initialize(self.root, -10000, ["wiki"])

    def test_busy_port_is_rejected_without_stopping_owner(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            config = {"services": ["wiki"], "ports": {"wiki": listener.getsockname()[1]}}
            with self.assertRaisesRegex(RuntimeError, "No process will be stopped"):
                deploy.check_ports(config)
            with socket.create_connection(listener.getsockname(), timeout=1):
                pass

    def test_recently_closed_service_port_can_be_reused(self):
        with socket.socket() as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(("127.0.0.1", 0))
            listener.listen()
            address = listener.getsockname()
            with socket.create_connection(address, timeout=1) as client:
                connection, _ = listener.accept()
                with connection:
                    connection.shutdown(socket.SHUT_WR)
                    self.assertEqual(client.recv(1), b"")
        deploy.check_ports({"services": ["wiki"], "ports": {"wiki": address[1]}})

    def test_missing_control_record_does_not_signal_any_process(self):
        self.assertIsNone(deploy.control(self.root, "stop"))

    def test_download_checksum_is_enforced(self):
        with patch.object(deploy, "fetch", return_value=b"wrong"):
            with self.assertRaisesRegex(RuntimeError, "checksum"):
                deploy.download_archive("https://example.invalid", "a" * 64, self.root / "download")
        self.assertFalse((self.root / "download").exists())

    def test_source_hashes_cover_runtime_inputs(self):
        self.assertEqual(set(deploy.source_hashes()), {"versions.json", "weknora.patch", "tem-twin-source.tar.gz", "requirements.txt", "requirements.lock"})

    def test_read_only_go_assets_support_repeat_install(self):
        source, target = self.root / "module-cache", self.root / "runtime"
        source.mkdir()
        (source / "dict.txt").write_text("dictionary")
        (source / "dict.txt").chmod(0o444)
        source.chmod(0o555)
        self.addCleanup(source.chmod, 0o700)
        deploy.copy_assets(source, target)
        target.chmod(0o555)
        (target / "dict.txt").chmod(0o444)
        deploy.copy_assets(source, target)
        self.assertEqual((target / "dict.txt").read_text(), "dictionary")
        self.assertEqual(stat.S_IMODE((target / "dict.txt").stat().st_mode), 0o600)


if __name__ == "__main__":
    unittest.main()
