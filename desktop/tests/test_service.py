import threading
import time
import unittest
from PySide6.QtWidgets import QApplication
from vibe_desktop.service import TranslatorService


class ServiceTests(unittest.TestCase):
    def pump_until(self, condition, timeout=2):
        app = QApplication.instance() or QApplication([])
        deadline = time.monotonic() + timeout
        while not condition() and time.monotonic() < deadline:
            app.processEvents()
            time.sleep(.005)
        self.assertTrue(condition())

    def test_background_mount_before_translation_reuses_the_same_engine(self):
        app = QApplication.instance() or QApplication([])
        instances, events = [], []
        class Engine:
            def __init__(self):
                instances.append(self)
                self.mounted = False
            def prepare(self, target, cancel, status):
                self.mounted = True
                events.append('mounted')
            def translate(self, text, source, target, cancel, status, partial):
                if not self.mounted:
                    raise AssertionError('Translation started before mounting')
                events.append('translated')
                return '譯文'
        service = TranslatorService(Engine)
        ready, results = [], []
        service.prepared.connect(lambda profile, target: ready.append((profile, target)))
        service.finished.connect(lambda job, text: results.append(text))
        try:
            service.preload('nllb-1.3b', 'zh-Hant')
            self.pump_until(lambda: bool(ready))
            self.assertEqual(events, ['mounted'])
            service.submit(1, 'input', 'en', 'zh-Hant', 'nllb-1.3b')
            self.pump_until(lambda: bool(results))
            self.assertEqual(len(instances), 1)
            self.assertEqual(events, ['mounted', 'translated'])
        finally:
            service.close()

    def test_typing_and_same_model_translation_do_not_cancel_mount(self):
        app = QApplication.instance() or QApplication([])
        started, release = threading.Event(), threading.Event()
        tokens = []
        class Engine:
            def prepare(self, target, cancel, status):
                tokens.append(cancel)
                started.set()
                release.wait(2)
            def translate(self, text, source, target, cancel, status, partial):
                return text.upper()
        service = TranslatorService(Engine)
        results = []
        service.finished.connect(lambda job, text: results.append(text))
        try:
            service.preload('nllb-600m', 'zh-Hant')
            self.assertTrue(started.wait(1))
            service.cancel()
            service.submit(1, 'new', 'en', 'zh-Hant', 'nllb-600m')
            self.assertFalse(tokens[0].is_set())
            release.set()
            self.pump_until(lambda: bool(results))
            self.assertEqual(results, ['NEW'])
        finally:
            release.set()
            service.close()

    def test_changing_profile_cancels_stale_mount_and_only_reports_new_ready(self):
        app = QApplication.instance() or QApplication([])
        started = threading.Event()
        instances = []
        class Engine:
            def __init__(self):
                self.number = len(instances)
                instances.append(self)
            def prepare(self, target, cancel, status):
                if self.number == 0:
                    started.set()
                    cancel.wait(2)
        service = TranslatorService(Engine)
        ready = []
        service.prepared.connect(lambda profile, target: ready.append(profile))
        try:
            service.preload('nllb-1.3b', 'zh-Hant')
            self.assertTrue(started.wait(1))
            service.preload('nllb-600m', 'zh-Hant')
            self.pump_until(lambda: bool(ready))
            self.assertEqual(ready, ['nllb-600m'])
        finally:
            service.close()

    def test_queued_translation_receives_mount_progress_and_completes(self):
        app = QApplication.instance() or QApplication([])
        started, release = threading.Event(), threading.Event()
        class Engine:
            def prepare(self, target, cancel, status):
                status('loading 10%')
                started.set()
                release.wait(2)
                status('loading 100%')
            def translate(self, text, source, target, cancel, status, partial):
                return 'translated'
        service = TranslatorService(Engine)
        progress, results = [], []
        service.progress.connect(lambda job, text: progress.append((job, text)))
        service.finished.connect(lambda job, text: results.append((job, text)))
        try:
            service.preload('nllb-600m', 'zh-Hant')
            self.assertTrue(started.wait(1))
            service.submit(2, 'new', 'auto', 'zh-Hant', 'nllb-600m')
            release.set()
            self.pump_until(lambda: bool(results))
            self.assertIn((2, 'loading 10%'), progress)
            self.assertIn((2, 'loading 100%'), progress)
            self.assertEqual(results, [(2, 'translated')])
        finally:
            release.set()
            service.close()

    def test_mount_failure_finishes_queued_request_with_error(self):
        app = QApplication.instance() or QApplication([])
        started, release = threading.Event(), threading.Event()
        class Engine:
            def prepare(self, target, cancel, status):
                started.set()
                release.wait(2)
                raise OSError('model unavailable')
        service = TranslatorService(Engine)
        errors = []
        service.failed.connect(lambda job, text: errors.append((job, text)))
        try:
            service.preload('nllb-600m', 'zh-Hant')
            self.assertTrue(started.wait(1))
            service.submit(3, 'new', 'auto', 'zh-Hant', 'nllb-600m')
            release.set()
            self.pump_until(lambda: bool(errors))
            self.assertEqual(errors, [(3, 'model unavailable')])
            self.assertIsNone(service.pending)
        finally:
            release.set()
            service.close()

    def test_cache_is_separate_for_each_model(self):
        app = QApplication.instance() or QApplication([])
        instances = []
        class Engine:
            def __init__(self):
                self.number = len(instances) + 1
                instances.append(self)
            def translate(self, text, source, target, cancel, status, partial):
                return f'model-{self.number}'
        service = TranslatorService(Engine)
        results = []
        service.finished.connect(lambda job, text: results.append((job, text)))
        try:
            for job, profile in ((1, 'opus'), (2, 'nllb-600m'), (3, 'opus')):
                service.submit(job, 'same input', 'en', 'zh-Hant', profile)
                deadline = time.monotonic() + 2
                while len(results) < job and time.monotonic() < deadline:
                    app.processEvents()
                    time.sleep(.005)
            self.assertEqual(results, [(1, 'model-1'), (2, 'model-2'), (3, 'model-1')])
        finally:
            service.close()

    def test_new_request_cancels_old_and_repeats_use_cache(self):
        app = QApplication.instance() or QApplication([])
        started = threading.Event()
        calls = []
        class Engine:
            def translate(self, text, source, target, cancel, status, partial):
                calls.append(text)
                if text == 'old':
                    started.set()
                    cancel.wait(2)
                return text.upper()
        service = TranslatorService(Engine)
        results = []
        service.finished.connect(lambda job, text: results.append((job, text)))
        service.submit(1, 'old', 'en', 'zh-Hant')
        self.assertTrue(started.wait(1))
        service.submit(2, 'new', 'en', 'zh-Hant')
        deadline = time.monotonic() + 2
        while len(results) < 1 and time.monotonic() < deadline:
            app.processEvents()
            time.sleep(.005)
        self.assertEqual(results, [(2, 'NEW')])
        service.submit(3, 'new', 'en', 'zh-Hant')
        while len(results) < 2 and time.monotonic() < deadline:
            app.processEvents()
            time.sleep(.005)
        self.assertEqual(results[-1], (3, 'NEW'))
        self.assertEqual(calls, ['old', 'new'])
        service.close()


if __name__ == '__main__':
    unittest.main()
