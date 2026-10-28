"""Exercise the real window controller without a keyboard hook or model worker."""
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from PySide6.QtCore import QSettings
from PySide6.QtWidgets import QApplication, QComboBox, QDialog
from vibe_desktop.app import Controller


class WindowModeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        cls.app.setQuitOnLastWindowClosed(False)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.settings = QSettings(str(Path(self.directory.name) / 'settings.ini'), QSettings.Format.IniFormat)
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
        self.settings.sync()
        self.settings = None
        self.directory.cleanup()

    def assert_only(self, visible):
        for window in self.controller.windows:
            self.assertEqual(window.isVisible(), window is visible)
        self.assertIs(self.controller.active, visible)

    def capture(self):
        clipboard = Mock()
        clipboard.mimeData.return_value.hasText.return_value = True
        clipboard.text.return_value = 'A new selection to translate.'
        with patch('vibe_desktop.app.clipboard_sequence', return_value=2), \
                patch.object(QApplication, 'clipboard', return_value=clipboard):
            self.controller.begin_copy((1, None, 0))

    def test_all_open_paths_hide_the_previous_surface(self):
        for target in (self.controller.popup, self.controller.full, self.controller.popup, self.controller.full):
            self.controller.show_window(target)
            self.assert_only(target)

    def test_switch_remembers_mode_and_retains_translation(self):
        self.controller.set_source('Original text')
        for window in self.controller.windows:
            window.translation.setPlainText('原文翻譯')
        self.controller.show_window(self.controller.popup)
        self.controller.switch_mode(self.controller.popup)
        self.assert_only(self.controller.full)
        self.assertEqual(self.settings.value('mode'), 'full')
        self.assertEqual(self.controller.full.source.toPlainText(), 'Original text')
        self.assertEqual(self.controller.full.translation.toPlainText(), '原文翻譯')
        self.controller.full.hide()
        self.capture()
        self.assert_only(self.controller.full)
        self.controller.switch_mode(self.controller.full)
        self.assert_only(self.controller.popup)
        self.assertEqual(self.settings.value('mode'), 'popup')

    def test_shortcut_uses_visible_full_window_even_with_popup_default(self):
        self.controller.show_window(self.controller.full)
        self.capture()
        self.assert_only(self.controller.full)
        self.controller.service.submit.assert_called_once()

    def test_full_preference_skips_popup_entirely(self):
        self.controller.default_mode = 'full'
        with patch.object(self.controller.popup, 'showNormal') as show_popup:
            self.capture()
        show_popup.assert_not_called()
        self.assert_only(self.controller.full)

    def test_dismissed_full_window_is_reopened_by_shortcut(self):
        self.controller.show_window(self.controller.full)
        self.controller.full.hide()
        with patch('vibe_desktop.app.bring_to_foreground') as foreground:
            self.capture()
        self.assert_only(self.controller.full)
        foreground.assert_called_once_with(int(self.controller.full.winId()), False)
        self.assertEqual(self.settings.value('mode'), 'full')

    def test_minimized_maximized_full_window_is_restored(self):
        self.controller.show_window(self.controller.full)
        self.controller.full.showMaximized()
        self.controller.full.showMinimized()
        with patch('vibe_desktop.app.bring_to_foreground') as foreground:
            self.capture()
        self.assert_only(self.controller.full)
        self.assertFalse(self.controller.full.isMinimized())
        self.assertTrue(self.controller.full.isMaximized())
        foreground.assert_called_once()

    def test_preferences_apply_mode_immediately(self):
        self.controller.show_window(self.controller.popup)
        def accept(dialog):
            mode = dialog.findChildren(QComboBox)[0]
            mode.setCurrentIndex(mode.findData('full'))
            return QDialog.DialogCode.Accepted
        with patch.object(QDialog, 'exec', accept):
            self.controller.preferences()
        self.assert_only(self.controller.full)
        self.assertEqual(self.settings.value('mode'), 'full')

    def test_preferences_change_model_and_enable_japanese_on_both_surfaces(self):
        self.controller.show_window(self.controller.full)
        self.controller.set_source('A paragraph to translate.')
        def accept(dialog):
            mode, engine, target = dialog.findChildren(QComboBox)
            engine.setCurrentIndex(engine.findData('nllb-600m'))
            target.setCurrentIndex(target.findData('ja'))
            return QDialog.DialogCode.Accepted
        with patch.object(QDialog, 'exec', accept):
            self.controller.preferences()
        self.assertEqual(self.settings.value('engine'), 'nllb-600m')
        self.assertEqual(self.controller.target, 'ja')
        for window in self.controller.windows:
            self.assertGreaterEqual(window.target_language.count(), 200)
            self.assertEqual(window.target_language.currentData(), 'ja')
        self.controller.service.submit.assert_called_once()
        self.assertEqual(self.controller.service.submit.call_args.args[-2:], ('ja', 'nllb-600m'))

    def test_startup_queues_mount_without_waiting_for_source_text(self):
        self.app.processEvents()
        self.controller.service.preload.assert_called_with('opus', self.controller.target)
        self.assertEqual(self.controller.full.source.toPlainText(), '')

    def test_old_model_ready_does_not_override_current_mount_status(self):
        self.controller.engine_id = 'nllb-1.3b'
        self.controller.preload_model()
        self.controller.model_prepared('opus', self.controller.target)
        self.assertIsNone(self.controller.model_ready_key)
        self.controller.model_prepared('nllb-1.3b', self.controller.target)
        self.assertEqual(self.controller.model_ready_key, ('nllb-1.3b', self.controller.target))
        self.assertIn('模型已掛載', self.controller.full.status.text())

    def test_waiting_job_shows_model_progress_and_mount_error_ends_busy_state(self):
        self.controller.set_source('A request made during startup.')
        self.controller.translate(self.controller.full)
        job = self.controller.job
        self.controller.progress(job, '載入模型 50%')
        self.assertIn('50%', self.controller.full.status.text())
        self.controller.failed(job, 'model unavailable')
        self.assertFalse(self.controller.busy)
        self.assertIn('model unavailable', self.controller.full.translation.toPlainText())


if __name__ == '__main__':
    unittest.main()
