import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from api.app import _cors_origins
from api.routers.files import _safe_upload_name
from config import SECRET_MASK, merge_config_update, redact_config
from path_security import resolve_allowed_local_file, resolve_media_reference


class ConfigSecurityTests(unittest.TestCase):
    def setUp(self):
        self.config = {
            "server": {"host": "127.0.0.1", "port": 8000},
            "api_providers": {
                "openai": {"api_key": "real-secret", "base_url": "https://example.com"},
                "gemini": {"api_key": ""},
                "deepseek": {"api_key": ""},
                "dashscope": {"api_key": ""},
                "ark": {"api_key": ""},
                "kling": {"access_key": "", "secret_key": ""},
            },
        }

    def test_public_config_never_contains_secret(self):
        public = redact_config(self.config)

        self.assertEqual(public["api_providers"]["openai"]["api_key"], SECRET_MASK)
        self.assertNotIn("real-secret", repr(public))

    def test_masked_secret_is_preserved_during_update(self):
        merged = merge_config_update(
            self.config,
            {
                "server": {"port": 9000},
                "api_providers": {"openai": {"api_key": SECRET_MASK}},
            },
        )

        self.assertEqual(merged["server"]["port"], 9000)
        self.assertEqual(merged["api_providers"]["openai"]["api_key"], "real-secret")

    def test_explicit_empty_secret_clears_value(self):
        merged = merge_config_update(
            self.config,
            {"api_providers": {"openai": {"api_key": ""}}},
        )

        self.assertEqual(merged["api_providers"]["openai"]["api_key"], "")


class PathSecurityTests(unittest.TestCase):
    def test_local_file_must_stay_under_allowed_root(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            parent = Path(temp_dir)
            allowed = parent / "uploads"
            allowed.mkdir()
            uploaded = allowed / "input.md"
            uploaded.write_text("ok", encoding="utf-8")
            outside = parent / "outside.md"
            outside.write_text("secret", encoding="utf-8")

            self.assertEqual(
                resolve_allowed_local_file("input.md", [str(allowed)]),
                str(uploaded.resolve()),
            )
            with self.assertRaises(ValueError):
                resolve_allowed_local_file("../outside.md", [str(allowed)])

            link = allowed / "outside-link.md"
            link.symlink_to(outside)
            with self.assertRaises(ValueError):
                resolve_allowed_local_file(str(link), [str(allowed)])

    def test_media_reference_rejects_file_uri(self):
        with self.assertRaises(ValueError):
            resolve_media_reference("file:///tmp/private.png", ["/tmp"])

    def test_media_reference_allows_http_url(self):
        url = "https://cdn.example.com/input.png"
        self.assertEqual(resolve_media_reference(url, ["/tmp"]), url)

    def test_upload_name_drops_client_directories(self):
        safe_name = _safe_upload_name("../../private/input.pdf")

        self.assertEqual(Path(safe_name).name, safe_name)
        self.assertTrue(safe_name.endswith("_input.pdf"))


class CorsSecurityTests(unittest.TestCase):
    def test_cors_env_only_accepts_http_origins(self):
        with patch.dict(
            "os.environ",
            {
                "XYQ_CORS_ORIGINS": (
                    "https://studio.example.com/,*,file:///tmp/index.html,"
                    "https://studio.example.com/path"
                )
            },
        ):
            origins = _cors_origins()

        self.assertIn("https://studio.example.com", origins)
        self.assertNotIn("*", origins)
        self.assertNotIn("file:///tmp/index.html", origins)
        self.assertNotIn("https://studio.example.com/path", origins)


if __name__ == "__main__":
    unittest.main()
