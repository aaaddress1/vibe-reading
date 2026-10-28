import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from PySide6.QtCore import QSettings
from PySide6.QtWidgets import QApplication
from vibe_desktop.app import Controller
from vibe_desktop.languages import manual_target, preferred_target, save_target, system_target


class LanguageSettingsCase(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = str(Path(self.directory.name) / 'preferences.ini')
        self.settings = QSettings(self.path, QSettings.Format.IniFormat)
        self.locale = patch('vibe_desktop.languages.QLocale.system',
                            return_value=Mock(uiLanguages=lambda: ['zh-Hant-TW', 'en-US']))
        self.locale.start()

    def tearDown(self):
        self.locale.stop()
        self.settings.sync()
        self.settings = None
        self.directory.cleanup()


class LanguagePreferenceTests(LanguageSettingsCase):
    def test_display_language_priority_and_chinese_variants(self):
        cases = [
            (['zh-Hant-TW', 'en-US'], 'zh-Hant'),
            (['zh_TW'], 'zh-Hant'), (['zh-HK'], 'zh-Hant'), (['zh-MO'], 'zh-Hant'),
            (['zh-CN'], 'zh-Hans'), (['zh-SG'], 'zh-Hans'), (['zh'], 'zh-Hans'),
            (['zh-Hans-TW'], 'zh-Hans'), (['zh-Hant-CN'], 'zh-Hant'),
            (['en-GB', 'zh-TW'], 'en'), (['ja-JP', 'zh-TW'], 'zh-Hant'),
            (['ja-JP'], 'en'), ([], 'en'),
        ]
        for names, expected in cases:
            with self.subTest(names=names), patch('vibe_desktop.languages.QLocale.system',
                                                 return_value=Mock(uiLanguages=lambda: names)):
                self.assertEqual(system_target(), expected)

    def test_automatic_default_is_not_saved_as_manual(self):
        self.assertEqual(preferred_target(self.settings), 'zh-Hant')
        self.assertFalse(self.settings.contains('target'))
        with patch('vibe_desktop.languages.QLocale.system',
                   return_value=Mock(uiLanguages=lambda: ['en-US'])):
            self.assertEqual(preferred_target(self.settings), 'en')

    def test_manual_choice_survives_restart_and_system_change(self):
        save_target(self.settings, 'zh-Hans')
        self.settings.sync()
        reloaded = QSettings(self.path, QSettings.Format.IniFormat)
        with patch('vibe_desktop.languages.QLocale.system',
                   return_value=Mock(uiLanguages=lambda: ['en-US'])):
            self.assertEqual(preferred_target(reloaded), 'zh-Hans')

    def test_legacy_choice_is_preserved_and_reset_restores_system(self):
        self.settings.setValue('target', 'en')
        self.assertEqual(preferred_target(self.settings), 'en')
        save_target(self.settings, None)
        self.assertIsNone(manual_target(self.settings))
        self.assertEqual(preferred_target(self.settings), 'zh-Hant')
        self.assertFalse(self.settings.contains('target'))

    def test_invalid_saved_language_uses_system(self):
        self.settings.setValue('target', 'invalid')
        self.assertEqual(preferred_target(self.settings), 'zh-Hant')


class ControllerLanguageTests(LanguageSettingsCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        cls.app.setQuitOnLastWindowClosed(False)

    def setUp(self):
        super().setUp()
        self.settings.setValue('welcomed', True)
        self.settings.setValue('engine', 'opus')
        with patch('vibe_desktop.app.QSettings', return_value=self.settings), \
                patch('vibe_desktop.app.QSystemTrayIcon'), \
                patch('vibe_desktop.app.TranslatorService'):
            self.controller = Controller(self.app, SimpleNamespace(no_hook=True, show=False, smoke_test=None))

    def tearDown(self):
        self.controller.close()
        for window in self.controller.windows:
            window.hide()
            window.deleteLater()
        self.controller.deleteLater()
        self.app.processEvents()
        super().tearDown()

    def test_source_change_does_not_pin_target(self):
        self.controller.full.source_language.setCurrentIndex(1)
        self.assertFalse(self.settings.contains('target'))
        self.assertEqual(self.controller.target, 'zh-Hant')

    def test_selecting_current_default_explicitly_pins_it(self):
        combo = self.controller.popup.target_language
        combo.activated.emit(combo.currentIndex())
        self.assertEqual(manual_target(self.settings), 'zh-Hant')

    def test_user_target_selection_syncs_both_windows_and_persists(self):
        combo = self.controller.full.target_language
        combo.setCurrentIndex(combo.findData('en'))
        combo.activated.emit(combo.currentIndex())
        self.assertEqual(self.controller.target, 'en')
        self.assertEqual(self.controller.popup.target_language.currentData(), 'en')
        self.assertEqual(manual_target(self.settings), 'en')

    def test_return_to_system_updates_both_windows(self):
        self.controller.apply_target_preference('en')
        self.controller.apply_target_preference(None)
        self.assertIsNone(manual_target(self.settings))
        self.assertEqual(self.controller.target, 'zh-Hant')
        for window in self.controller.windows:
            self.assertEqual(window.target_language.currentData(), 'zh-Hant')

    def test_swap_is_a_manual_target_choice(self):
        self.controller.full.translation.setPlainText('測試譯文')
        self.controller.swap_languages(self.controller.full)
        self.assertEqual(manual_target(self.settings), 'en')


if __name__ == '__main__':
    unittest.main()
