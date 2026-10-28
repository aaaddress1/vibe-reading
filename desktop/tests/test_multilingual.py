import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from PySide6.QtCore import QSettings
from vibe_desktop.engine import Cancelled, detect_source
from vibe_desktop.languages import CATALOG, languages_for, system_target
from vibe_desktop.multilingual import NllbEngine, language_token


class MultilingualTests(unittest.TestCase):
    def engine(self):
        engine = NllbEngine('nllb-600m')
        engine.tokenizer = Mock()
        engine.tokenizer.encode.return_value.tokens = ['hello'] * 1000
        engine.tokenizer.token_to_id.side_effect = lambda token: {'translated': 7}.get(token)
        engine.tokenizer.decode.return_value = 'Translated sentence.'
        engine.translator = Mock()
        engine.translator.translate_batch.side_effect = lambda tokens, **kw: [
            SimpleNamespace(hypotheses=[['jpn_Jpan', 'translated', '</s>']]) for _ in tokens]
        return engine

    def test_all_visible_languages_have_a_model_language_token(self):
        self.assertGreaterEqual(len(CATALOG), 200)
        for row in CATALOG:
            self.assertEqual(language_token(row['code']), row['nllb'])
        self.assertEqual(language_token('zh-Hant'), 'zho_Hant')
        self.assertEqual(language_token('fr'), 'fra_Latn')
        self.assertEqual(len(languages_for('opus')), 3)

    def test_system_language_uses_selected_models_capabilities(self):
        with patch('vibe_desktop.languages.QLocale.system', return_value=Mock(uiLanguages=lambda: ['ja-JP'])):
            self.assertEqual(system_target('nllb-600m'), 'ja')
            self.assertEqual(system_target('opus'), 'en')

    def test_multilingual_detection_does_not_treat_all_ascii_as_english(self):
        with patch('langid.classify', return_value=('fr', .99)) as classify:
            self.assertEqual(detect_source('Ce logiciel traduit les documents.', multilingual=True), 'fr')
            classify.assert_called_once()

    def test_long_input_is_complete_with_language_prefix_and_beam_search(self):
        engine = self.engine()
        engine.translate('long input', 'en', 'ja', threading.Event(), lambda text: None, lambda text: None)
        calls = engine.translator.translate_batch.call_args_list
        self.assertEqual(sum(len(tokens) - 2 for call in calls for tokens in call.args[0]), 1000)
        for call in calls:
            for tokens in call.args[0]:
                self.assertEqual(tokens[0], 'eng_Latn')
                self.assertEqual(tokens[-1], '</s>')
            self.assertEqual(call.kwargs['target_prefix'], [['jpn_Jpan']] * len(call.args[0]))
            self.assertEqual(call.kwargs['beam_size'], 4)
            self.assertEqual(call.kwargs['max_input_length'], 0)

    def test_cancelled_result_is_not_published(self):
        engine = self.engine()
        cancel = threading.Event()
        partial = Mock()
        def translate(*args, **kwargs):
            cancel.set()
            return [SimpleNamespace(hypotheses=[['jpn_Jpan', 'translated', '</s>']])]
        engine.translator.translate_batch.side_effect = translate
        with self.assertRaises(Cancelled):
            engine.translate('input', 'en', 'ja', cancel, lambda text: None, partial)
        partial.assert_not_called()

    def test_native_batches_preserve_paragraph_order_and_blank_lines(self):
        engine = self.engine()
        engine.tokenizer.encode.return_value.tokens = ['hello']
        engine.tokenizer.decode.side_effect = ['first', 'second', 'third']
        partial = Mock()
        result = engine.translate('one\n\n two\n \nthree\n\n', 'en', 'ja', threading.Event(), lambda text: None, partial)
        self.assertEqual(result, 'first\n\nsecond\n \nthird\n\n')
        self.assertEqual([len(call.args[0]) for call in engine.translator.translate_batch.call_args_list], [2, 1])
        self.assertEqual(partial.call_count, 3)

    def test_traditional_output_uses_chinese_translation_then_taiwan_conversion(self):
        engine = self.engine()
        engine.tokenizer.encode.return_value.tokens = ['hello']
        engine.convert = Mock(return_value='保留否定含義的繁體譯文')
        result = engine.translate('input', 'ja', 'zh-Hant', threading.Event(), lambda text:None, lambda text:None)
        self.assertEqual(engine.translator.translate_batch.call_args.kwargs['target_prefix'], [['zho_Hans']])
        engine.convert.assert_called_once_with('Translated sentence.')
        self.assertEqual(result, '保留否定含義的繁體譯文')

    def test_truncated_translation_is_reported_instead_of_silently_used(self):
        engine = self.engine()
        engine.translator.translate_batch.side_effect = lambda tokens, **kw: [
            SimpleNamespace(hypotheses=[['jpn_Jpan', 'translated']]) for _ in tokens]
        with self.assertRaises(ValueError):
            engine.translate('input', 'en', 'ja', threading.Event(), lambda text: None, lambda text: None)
