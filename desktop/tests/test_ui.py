import time
import unittest
from unittest.mock import patch
from PySide6.QtCore import QEvent
from PySide6.QtWidgets import QApplication, QDialog, QWidget
from vibe_desktop.ui import STYLE, TranslationWindow
from vibe_desktop import __version__
from vibe_desktop.ui import COFFEE_URL, GITHUB_URL


class WindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = QApplication.instance() or QApplication([])
        cls.app.setStyleSheet(STYLE)
        cls.app.setQuitOnLastWindowClosed(False)

    def setUp(self):
        self.popup = TranslationWindow(True)
        self.full = TranslationWindow(False)

    def tearDown(self):
        self.popup.hide()
        self.full.hide()
        self.popup.deleteLater()
        self.full.deleteLater()
        self.app.processEvents()

    def pump(self, duration=.1):
        end = time.perf_counter() + duration
        while time.perf_counter() < end:
            self.app.processEvents()
            time.sleep(.005)

    def test_compact_default_sizes_and_no_source_pane_in_popup(self):
        self.assertEqual((self.popup.width(), self.popup.height()), (460, 264))
        self.assertEqual((self.full.width(), self.full.height()), (820, 500))
        self.popup.show()
        self.assertTrue(self.popup.source.isHidden())
        self.assertTrue(self.popup.source_language.isHidden())

    def test_popup_hides_on_deactivation_and_keeps_result(self):
        self.popup.translation.setPlainText('保留已翻譯的內容')
        self.popup.show()
        self.app.processEvents()
        with patch.object(QApplication, 'activePopupWidget', return_value=None), \
                patch.object(QApplication, 'activeWindow', return_value=self.full):
            QApplication.sendEvent(self.popup, QEvent(QEvent.Type.WindowDeactivate))
            self.pump()
        self.assertFalse(self.popup.isVisible())
        self.assertEqual(self.popup.translation.toPlainText(), '保留已翻譯的內容')

    def test_owned_preferences_and_language_menu_do_not_hide_popup(self):
        self.popup.show()
        self.app.processEvents()
        preferences = QDialog(self.popup)
        language_menu = QWidget(self.popup.target_language)
        for active, menu in [(preferences, None), (None, language_menu)]:
            with patch.object(QApplication, 'activeWindow', return_value=active), \
                    patch.object(QApplication, 'activePopupWidget', return_value=menu):
                QApplication.sendEvent(self.popup, QEvent(QEvent.Type.WindowDeactivate))
                self.pump()
            self.assertTrue(self.popup.isVisible())

    def test_full_window_stays_open_after_losing_focus(self):
        self.full.show()
        self.app.processEvents()
        QApplication.sendEvent(self.full, QEvent(QEvent.Type.WindowDeactivate))
        self.pump()
        self.assertTrue(self.full.isVisible())

    def test_brand_and_external_links_in_both_modes(self):
        for window in (self.popup, self.full):
            self.assertFalse(window.logo.pixmap().isNull())
            self.assertGreaterEqual(window.logo.width(), 36)
            self.assertIn(__version__, window.version_label.text())
            self.assertEqual(window.coffee_button.text(), '')
            self.assertEqual(window.coffee_button.width(), 29)
            with patch('vibe_desktop.ui.QDesktopServices.openUrl', return_value=True) as open_url:
                window.github_button.click()
                self.assertEqual(open_url.call_args.args[0].toString(), GITHUB_URL)
                window.coffee_button.click()
                self.assertEqual(open_url.call_args.args[0].toString(), COFFEE_URL)


if __name__ == '__main__':
    unittest.main()
