import unittest
from pathlib import Path
import tempfile
import threading
from unittest.mock import patch
from vibe_desktop.engine import Marian, model_files, normalized_tokenizer, repeated_trigrams, route_for


class EngineTests(unittest.TestCase):
    def test_repetition_filter_bans_only_seen_trigrams(self):
        self.assertEqual(repeated_trigrams([1, 2, 3, 4, 1, 2]), {3})
        self.assertEqual(repeated_trigrams([1]), set())

    def test_long_copy_keeps_every_source_token(self):
        class Tokenizer:
            def encode(self, text):
                return type('Encoding', (), {'ids': list(range(1, 1202)) + [0]})()
            def token_to_id(self, token):
                return 5000
        model = Marian.__new__(Marian)
        model.tokenizer = Tokenizer()
        model.config = {'eos_token_id': 0}
        chunks = list(model.chunks('long document', 'language'))
        self.assertEqual([token for chunk in chunks for token in chunk[1:-1]], list(range(1, 1202)))
        self.assertTrue(all(len(chunk) <= 482 for chunk in chunks))

    def test_null_normalizer_export_is_compatible_with_native_tokenizer(self):
        source = {'normalizer': {'type': 'Precompiled', 'precompiled_charsmap': None}}
        self.assertEqual(normalized_tokenizer(source)['normalizer'], {'type': 'NFKC'})
        self.assertIsNone(source['normalizer']['precompiled_charsmap'])

    def test_language_routes_are_explicit(self):
        self.assertEqual(route_for('en', 'zh-Hant'), 'en-zh')
        self.assertEqual(route_for('zh', 'en'), 'zh-en')
        self.assertIsNone(route_for('zh', 'zh-Hant'))
        with self.assertRaises(ValueError):
            route_for('ja', 'en')

    def test_offline_validation_cannot_download_a_missing_model(self):
        with tempfile.TemporaryDirectory() as cache, \
                patch('vibe_desktop.engine.CACHE', Path(cache)), \
                patch.dict('os.environ', {'VIBE_DESKTOP_OFFLINE': '1'}), \
                patch('urllib.request.urlopen') as request:
            with self.assertRaises(OSError):
                model_files('en-zh', threading.Event(), lambda text: None)
            request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
