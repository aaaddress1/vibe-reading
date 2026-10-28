import argparse
import ctypes
import json
import os
from pathlib import Path
import statistics
import sys
import time
from PySide6.QtCore import QObject, QSettings, Qt, QTimer, Signal
from PySide6.QtGui import QAction, QCursor, QIcon
from PySide6.QtNetwork import QLocalServer
from PySide6.QtWidgets import (QApplication, QComboBox, QDialog, QDialogButtonBox, QMessageBox,
    QFormLayout, QLabel, QMenu, QSystemTrayIcon, QVBoxLayout)
from .service import TranslatorService
from .activation import bring_to_foreground
from .shortcut import KeyboardHook, clipboard_sequence
from .ui import ASSETS, STYLE, TranslationWindow
from .languages import TARGET_LANGUAGES, manual_target, preferred_target, save_target, system_target
from .languages import languages_for
from .models import MODELS, NOTES, preferred_model
from .instance import InstanceMutex, activate_existing, instance_name


class Controller(QObject):
    captured = Signal(object)
    hook_failed = Signal(str)

    def __init__(self, app, args):
        super().__init__()
        self.app, self.args = app, args
        self.settings = QSettings('VibeReading', 'Desktop')
        self.job = 0
        self.busy = False
        self.model_ready_key = None
        self.model_status = '正在背景掛載模型…'
        self.model_error = None
        self.syncing = False
        self.pending_capture = None
        self.default_mode = self.settings.value('mode', 'popup')
        if self.default_mode not in ('popup', 'full'):
            self.default_mode = 'popup'
        self.engine_id = preferred_model(self.settings)
        self.target = preferred_target(self.settings, self.engine_id)
        self.source_language = 'auto'
        self.paused = False
        self.windows = [TranslationWindow(True), TranslationWindow(False)]
        self.popup, self.full = self.windows
        self.active = self.full
        self.service = TranslatorService()
        self.service.progress.connect(self.progress)
        self.service.partial.connect(self.partial)
        self.service.finished.connect(self.finished)
        self.service.failed.connect(self.failed)
        self.service.preparing.connect(self.model_preparing)
        self.service.prepared.connect(self.model_prepared)
        self.service.preparation_failed.connect(self.model_preparation_failed)
        for window in self.windows:
            window.set_engine(self.engine_id, self.target)
            window.target_language.setCurrentIndex(window.target_language.findData(self.target))
            window.translate_requested.connect(lambda w=window: self.translate(w))
            window.mode_requested.connect(lambda w=window: self.switch_mode(w))
            window.settings_requested.connect(self.preferences)
            window.swap_requested.connect(lambda w=window: self.swap_languages(w))
            window.source_changed.connect(lambda w=window: self.source_changed(w))
            window.language_changed.connect(lambda w=window: self.languages_changed(w))
            # activated is user-only, including explicitly choosing the current
            # default. Source changes and programmatic synchronization must not
            # turn an automatic target into a persistent manual preference.
            window.target_language.activated.connect(lambda _index, w=window: self.remember_target(w))
        self.capture_timer = QTimer(self)
        self.capture_timer.setInterval(12)
        self.capture_timer.timeout.connect(self.read_copy)
        self.captured.connect(self.begin_copy)
        self.hook_failed.connect(self.hook_error)
        self.tray = QSystemTrayIcon(QIcon(str(ASSETS / 'icon.png')), self)
        self.tray.setToolTip('氛圍閱讀 · 雙按 Ctrl+C 快速翻譯')
        menu = QMenu()
        menu.addAction('開啟完整介面', lambda: self.show_window(self.full))
        menu.addAction('偏好設定', self.preferences)
        pause = QAction('暫停雙按 Ctrl+C', menu, checkable=True)
        pause.toggled.connect(lambda value: setattr(self, 'paused', value))
        menu.addAction(pause)
        menu.addSeparator()
        menu.addAction('結束氛圍閱讀', app.quit)
        self.tray.setContextMenu(menu)
        self.tray.activated.connect(self.tray_clicked)
        self.tray.show()
        self.hook = None
        if not args.no_hook:
            self.hook = KeyboardHook(self.captured.emit, self.hook_failed.emit, args.test_shortcut_interval or 0.55)
            self.hook.start()
        app.aboutToQuit.connect(self.close)
        first_launch = not self.settings.value('welcomed', False, type=bool)
        if args.show or (first_launch and not args.smoke_test):
            QTimer.singleShot(0, lambda: self.show_window(self.full))
            self.settings.setValue('welcomed', True)
        if args.smoke_test:
            QTimer.singleShot(100, self.start_smoke)
        else:
            QTimer.singleShot(0, self.preload_model)

    def status(self, text):
        for window in self.windows:
            window.status.setText(text)
            window.status.setToolTip(text)

    def preload_model(self):
        if self.model_ready_key == (self.engine_id, self.target):
            return
        self.model_ready_key = None
        self.model_error = None
        self.model_status = '正在背景掛載模型…'
        if not self.busy:
            self.status(self.model_status)
        self.service.preload(self.engine_id, self.target)

    def model_preparing(self, profile, target, text):
        if (profile, target) == (self.engine_id, self.target):
            self.model_status = text
            if not self.busy:
                self.status(text)

    def model_prepared(self, profile, target):
        if (profile, target) == (self.engine_id, self.target):
            self.model_ready_key = (profile, target)
            self.model_status = '模型已掛載 · 準備就緒'
            if not self.busy:
                self.status(self.model_status)

    def model_preparation_failed(self, profile, target, text):
        if (profile, target) == (self.engine_id, self.target):
            self.model_ready_key = None
            self.model_error = text
            self.model_status = '模型尚未就緒 · ' + text
            if not self.busy:
                self.status(self.model_status)

    def source_changed(self, window):
        if self.syncing:
            return
        self.job += 1
        self.service.cancel()
        self.busy = False
        self.syncing = True
        for other in self.windows:
            if other is not window:
                other.source.setPlainText(window.source.toPlainText())
            other.translation.clear()
            other.copy.setEnabled(False)
        self.syncing = False
        self.status(self.model_status)

    def set_source(self, text):
        self.syncing = True
        for window in self.windows:
            window.source.setPlainText(text)
        self.syncing = False

    def languages_changed(self, window):
        if self.syncing:
            return
        self.source_language = window.source_language.currentData()
        self.target = window.target_language.currentData()
        self.syncing = True
        for other in self.windows:
            if other is not window:
                other.source_language.setCurrentIndex(other.source_language.findData(self.source_language))
                other.target_language.setCurrentIndex(other.target_language.findData(self.target))
        self.syncing = False
        # Invalidate before submitting, so late results never cross language pairs.
        self.job += 1
        self.service.cancel()
        self.busy = False
        self.preload_model()
        if window.source.toPlainText().strip():
            self.translate(window)

    def remember_target(self, window):
        save_target(self.settings, window.target_language.currentData())

    def apply_target_preference(self, target):
        save_target(self.settings, target)
        resolved = preferred_target(self.settings, self.engine_id)
        if resolved == self.target:
            return
        self.syncing = True
        for window in self.windows:
            window.target_language.setCurrentIndex(window.target_language.findData(resolved))
        self.syncing = False
        self.languages_changed(self.active)

    def translate(self, window):
        text = window.source.toPlainText().strip()
        if not text:
            self.status('先選取或貼上要翻譯的文字。')
            return
        self.job += 1
        self.busy = True
        self.translation_started = time.perf_counter()
        self.set_source(text)
        for surface in self.windows:
            surface.translation.clear()
            surface.copy.setEnabled(False)
        self.status(self.model_status if self.model_ready_key != (self.engine_id, self.target) else '正在處理原文…')
        self.service.submit(self.job, text, self.source_language, self.target, self.engine_id)

    def swap_languages(self, window):
        text = window.translation.toPlainText().strip()
        if not text or self.busy:
            return
        new_source = self.target
        if self.engine_id == 'opus' and new_source.startswith('zh'):
            new_source = 'zh'
        new_target = self.source_language
        if new_target == 'auto':
            from .engine import detect_source
            from .languages import ISO_CODES
            detected = detect_source(window.source.toPlainText(), multilingual=self.engine_id != 'opus')
            new_target = ISO_CODES.get(detected, detected)
        if new_target == 'zh':
            new_target = 'zh-Hant'
        if new_target not in {code for _, code in languages_for(self.engine_id)}:
            self.status('請先手動選擇來源語言，再交換語言。')
            return
        self.syncing = True
        for surface in self.windows:
            surface.source_language.setCurrentIndex(surface.source_language.findData(new_source))
            surface.target_language.setCurrentIndex(surface.target_language.findData(new_target))
        self.syncing = False
        self.source_language, self.target = new_source, new_target
        save_target(self.settings, new_target)
        self.set_source(text)
        self.translate(window)

    def progress(self, job, text):
        if job == self.job:
            self.status(text)

    def partial(self, job, text):
        if job == self.job:
            for window in self.windows:
                scrollbar = window.translation.verticalScrollBar()
                position = scrollbar.value()
                window.translation.setPlainText(text)
                scrollbar.setValue(position)

    def finished(self, job, text):
        if job == self.job:
            self.busy = False
            self.last_translation_ms = (time.perf_counter() - self.translation_started) * 1000
            for window in self.windows:
                window.translation.setPlainText(text)
                window.copy.setEnabled(bool(text))
            self.status('已完成 · 內容在裝置上處理')

    def failed(self, job, text):
        if job == self.job:
            self.busy = False
            for window in self.windows:
                window.translation.setPlainText('暫時無法翻譯\n\n' + text)
                window.copy.setEnabled(False)
            self.status('請確認模型下載與所選語言後重試。')

    def show_window(self, window, at_cursor=False):
        # Every entry point (shortcut, tray, relaunch and mode switch) uses this
        # method so the two translation surfaces can never overlap.
        for other in self.windows:
            if other is not window:
                other.hide()
        self.active = window
        if not self.args.smoke_test:
            # Opening either surface through the tray, shortcut or EXE is a
            # mode choice too. Keep it when that window is later dismissed.
            self.default_mode = 'popup' if window.compact else 'full'
            self.settings.setValue('mode', self.default_mode)
        if at_cursor:
            screen = QApplication.screenAt(QCursor.pos()) or QApplication.primaryScreen()
            available = screen.availableGeometry()
            x = min(max(QCursor.pos().x() + 16, available.left()), max(available.left(), available.right() - window.width()))
            y = min(max(QCursor.pos().y() + 18, available.top()), max(available.top(), available.bottom() - window.height()))
            window.move(x, y)
        window.show_started = time.perf_counter()
        window.setWindowState(window.windowState() & ~Qt.WindowState.WindowMinimized)
        window.show()
        window.raise_()
        window.activateWindow()
        bring_to_foreground(int(window.winId()), window.compact)

    def switch_mode(self, window):
        target = self.full if window.compact else self.popup
        self.show_window(target, target.compact)

    def begin_copy(self, event):
        if self.paused:
            return
        self.pending_capture = event
        self.capture_deadline = time.perf_counter() + 0.3
        self.read_copy()
        if self.pending_capture:
            self.capture_timer.start()

    def read_copy(self):
        if not self.pending_capture:
            self.capture_timer.stop()
            return
        sequence, owner, started = self.pending_capture
        if clipboard_sequence() != sequence:
            clipboard = QApplication.clipboard()
            if clipboard.mimeData() and clipboard.mimeData().hasText():
                text = clipboard.text().strip()
                if text:
                    self.pending_capture = None
                    self.capture_timer.stop()
                    self.set_source(text)
                    # Keep using the visible surface; the saved choice is for
                    # captures when both windows have been dismissed.
                    target = next((window for window in self.windows if window.isVisible()), None)
                    if target is None:
                        target = self.full if self.default_mode == 'full' else self.popup
                    self.show_window(target, target.compact)
                    self.translate(self.active)
                    return
        if time.perf_counter() >= self.capture_deadline:
            self.pending_capture = None
            self.capture_timer.stop()
            self.tray.showMessage('氛圍閱讀', '沒有取得新的文字，請先選取文字，再快速按兩次 Ctrl+C。', QSystemTrayIcon.MessageIcon.Information, 1800)

    def preferences(self):
        dialog = QDialog(self.active)
        dialog.setWindowTitle('氛圍閱讀 · 偏好設定')
        dialog.setMinimumWidth(420)
        layout = QVBoxLayout(dialog)
        form = QFormLayout()
        mode = QComboBox()
        mode.addItem('浮動翻譯窗', 'popup')
        mode.addItem('完整雙欄介面', 'full')
        mode.setCurrentIndex(mode.findData(self.default_mode))
        form.addRow('雙按 Ctrl+C 時開啟', mode)
        engine = QComboBox()
        for label, code in MODELS:
            engine.addItem(label, code)
        engine.setCurrentIndex(engine.findData(self.engine_id))
        form.addRow('地端翻譯模型', engine)
        model_note = QLabel(NOTES[self.engine_id])
        model_note.setWordWrap(True)
        form.addRow('', model_note)
        language = QComboBox()
        labels = dict((code, label) for label, code in TARGET_LANGUAGES)
        def update_model_choices():
            selected = language.currentData() if language.count() else manual_target(self.settings)
            profile = engine.currentData()
            model_note.setText(NOTES[profile])
            language.clear()
            language.addItem('跟隨系統（' + labels[system_target(profile)] + '）', None)
            for label, code in languages_for(profile):
                language.addItem(label, code)
            language.setCurrentIndex(max(0, language.findData(selected)))
        update_model_choices()
        engine.currentIndexChanged.connect(update_model_choices)
        form.addRow('主要翻譯語言', language)
        layout.addLayout(form)
        note = QLabel('模型首次使用時需要下載，之後可離線翻譯。\n所有翻譯在本機處理，不需要 Ollama 或雲端服務。\n關閉視窗後仍留在系統匣，可隨時快速叫出。')
        note.setWordWrap(True)
        layout.addWidget(note)
        actions = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        actions.accepted.connect(dialog.accept)
        actions.rejected.connect(dialog.reject)
        layout.addWidget(actions)
        if dialog.exec() == QDialog.DialogCode.Accepted:
            self.default_mode = mode.currentData()
            self.settings.setValue('mode', self.default_mode)
            model_changed = engine.currentData() != self.engine_id
            if model_changed:
                self.job += 1
                self.service.cancel()
                self.busy = False
                self.engine_id = engine.currentData()
                self.settings.setValue('engine', self.engine_id)
                self.target = preferred_target(self.settings, self.engine_id)
                for window in self.windows:
                    window.set_engine(self.engine_id, self.target)
                    window.translation.clear()
                    window.copy.setEnabled(False)
                self.source_language = self.active.source_language.currentData()
                self.status('準備就緒 · ' + engine.currentText())
                self.preload_model()
            if any(window.isVisible() for window in self.windows):
                target = self.full if self.default_mode == 'full' else self.popup
                self.show_window(target, target.compact)
            self.apply_target_preference(language.currentData())
            if model_changed and not self.busy and self.active.source.toPlainText().strip():
                self.translate(self.active)

    def hook_error(self, text):
        self.status(text)
        self.show_window(self.full)

    def tray_clicked(self, reason):
        if reason in (QSystemTrayIcon.ActivationReason.Trigger, QSystemTrayIcon.ActivationReason.DoubleClick):
            self.show_window(self.full)

    def close(self):
        self.capture_timer.stop()
        if self.hook:
            self.hook.stop()
        self.service.close()
        self.tray.hide()

    def start_smoke(self):
        self.smoke_dir = Path(self.args.smoke_test)
        self.smoke_dir.mkdir(parents=True, exist_ok=True)
        self.startup_language_selection = {
            'target': self.target,
            'engine': self.engine_id,
            'manualTarget': manual_target(self.settings),
            'systemTarget': system_target(self.engine_id),
            'windowsMatch': all(window.target_language.currentData() == self.target for window in self.windows),
        }
        self.engine_id = self.args.smoke_profile
        self.target = 'zh-Hant'
        self.source_language = 'en'
        self.syncing = True
        for window in self.windows:
            window.target_language.setCurrentIndex(window.target_language.findData(self.target))
            window.source_language.setCurrentIndex(window.source_language.findData(self.source_language))
        self.syncing = False
        self.show_window(self.full)
        self.smoke_deadline = time.perf_counter() + 240
        self.model_preload_started = time.perf_counter()
        self.preload_model()
        if self.args.smoke_queued:
            self.model_preload_ms = None
            self.mounted_before_translation = False
            QTimer.singleShot(200, self.submit_smoke_during_mount)
        else:
            QTimer.singleShot(100, self.poll_smoke_preload)

    def submit_smoke_during_mount(self):
        self.queued_behind_preload = self.service.preloading is not None
        self.set_source('Scientific documents combine structured text, equations and figures in a carefully designed layout. All translation processing stays on your own device.')
        self.translate(self.full)
        self.smoke_phase = 'cold'
        QTimer.singleShot(100, self.poll_smoke)

    def poll_smoke_preload(self):
        if self.model_ready_key != (self.engine_id, self.target):
            if self.model_error or time.perf_counter() >= self.smoke_deadline:
                (self.smoke_dir / 'error.txt').write_text(self.model_error or 'Preload timed out', encoding='utf-8')
                self.app.exit(1)
            else:
                QTimer.singleShot(100, self.poll_smoke_preload)
            return
        self.model_preload_ms = (time.perf_counter() - self.model_preload_started) * 1000
        self.mounted_before_translation = not self.full.source.toPlainText() and not self.busy
        self.set_source('Scientific documents combine structured text, equations and figures in a carefully designed layout. All translation processing stays on your own device.')
        self.translate(self.full)
        self.smoke_phase = 'cold'
        QTimer.singleShot(100, self.poll_smoke)

    def poll_smoke(self):
        if self.busy and time.perf_counter() < self.smoke_deadline:
            QTimer.singleShot(100, self.poll_smoke)
            return
        text = self.full.translation.toPlainText()
        if not text or text.startswith('暫時無法') or self.busy:
            (self.smoke_dir / 'error.txt').write_text(text or 'Timed out', encoding='utf-8')
            self.app.exit(1)
            return
        if self.smoke_phase == 'cold':
            self.cold_translation_ms = self.last_translation_ms
            self.smoke_phase = 'warm'
            self.set_source('This translation tool runs on your own computer.')
            self.translate(self.full)
            QTimer.singleShot(100, self.poll_smoke)
            return
        if self.smoke_phase == 'warm':
            self.warm_translation_ms = self.last_translation_ms
            self.smoke_phase = 'cache'
            self.translate(self.full)
            QTimer.singleShot(20, self.poll_smoke)
            return
        self.full.grab().save(str(self.smoke_dir / 'full-window.png'))
        self.show_window(self.popup)
        self.samples_remaining = 25
        QTimer.singleShot(40, self.sample_window)

    def sample_window(self):
        if self.samples_remaining:
            self.samples_remaining -= 1
            self.popup.hide()
            QTimer.singleShot(15, lambda: self.show_window(self.popup))
            QTimer.singleShot(45, self.sample_window)
            return
        self.popup.grab().save(str(self.smoke_dir / 'popup-window.png'))
        self.smoke_exclusive = self.popup.isVisible() and not self.full.isVisible()
        self.show_window(self.full)
        self.smoke_exclusive = self.smoke_exclusive and self.full.isVisible() and not self.popup.isVisible()
        QTimer.singleShot(180, self.finish_smoke)

    def finish_smoke(self):
        samples = self.popup.paint_latencies[1:]
        stats = {'windowShowToPaintMs': {'samples': len(samples), 'median': statistics.median(samples),
            'p95': sorted(samples)[max(0, int(len(samples)*.95)-1)]},
            'modelPreloadMs': self.model_preload_ms,
            'modelLoadedBeforeFirstTranslation': self.mounted_before_translation,
            'translationSubmittedDuringStartup': self.args.smoke_queued,
            'translationQueuedBehindPreload': getattr(self, 'queued_behind_preload', False),
            'firstTranslationAfterPreloadMs': self.cold_translation_ms,
            'warmModelTranslationMs': self.warm_translation_ms,
            'cachedTranslationMs': self.last_translation_ms,
            'translation': self.full.translation.toPlainText(), 'pid': os.getpid(),
            'startupLanguageSelection': self.startup_language_selection,
            'windows': {'full': [self.full.width(), self.full.height()],
                        'popup': [self.popup.width(), self.popup.height()]},
            'popupHiddenForFullWindow': not self.popup.isVisible(),
            'fullWindowRemainsVisible': self.full.isVisible()}
        stats['exclusiveTranslationWindows'] = self.smoke_exclusive
        (self.smoke_dir / 'measurements.json').write_text(json.dumps(stats, ensure_ascii=False, indent=2), encoding='utf-8')
        if not stats['popupHiddenForFullWindow'] or not stats['fullWindowRemainsVisible'] or not self.smoke_exclusive:
            self.app.exit(1)
            return
        self.app.quit()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--show', action='store_true', help='Open the full window on startup')
    parser.add_argument('--no-hook', action='store_true', help='Run without the global shortcut')
    parser.add_argument('--smoke-test', metavar='OUTPUT_DIRECTORY', help='Measure and render the real application')
    parser.add_argument('--smoke-profile', choices=['opus', 'nllb-600m', 'nllb-1.3b'], default='opus', help=argparse.SUPPRESS)
    parser.add_argument('--smoke-queued', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--test-shortcut-interval', type=float, help=argparse.SUPPRESS)
    args = parser.parse_args()
    app = QApplication(sys.argv[:1])
    app.setApplicationName('Vibe Reading Desktop')
    app.setQuitOnLastWindowClosed(False)
    app.setStyleSheet(STYLE)
    mutex = None
    server = QLocalServer()
    try:
        if not args.smoke_test:
            name = instance_name()
            mutex = InstanceMutex(name)
            if not mutex.owned and activate_existing(name, mutex):
                return 0
            server.setSocketOptions(QLocalServer.SocketOption.UserAccessOption)
            if not server.listen(name):
                raise OSError(server.errorString())
        controller = Controller(app, args)
        def open_existing():
            while server.hasPendingConnections():
                connection = server.nextPendingConnection()
                connection.write(b'ok')
                connection.flush()
                connection.disconnected.connect(connection.deleteLater)
                connection.disconnectFromServer()
            controller.show_window(controller.full)
        server.newConnection.connect(open_existing)
        return app.exec()
    except (OSError, TimeoutError) as error:
        QMessageBox.warning(None, '氛圍閱讀', str(error))
        return 1
    finally:
        server.close()
        if mutex:
            mutex.close()


if __name__ == '__main__':
    raise SystemExit(main())
