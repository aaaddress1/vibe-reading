"""One persistent inference worker; a newer request cancels the previous one."""
from collections import OrderedDict
import threading
from PySide6.QtCore import QObject, Signal


class TranslatorService(QObject):
    progress = Signal(int, str)
    partial = Signal(int, str)
    finished = Signal(int, str)
    failed = Signal(int, str)
    preparing = Signal(str, str, str)
    prepared = Signal(str, str)
    preparation_failed = Signal(str, str, str)

    def __init__(self, engine_factory=None):
        super().__init__()
        self.factory = engine_factory
        self.pending = None
        self.pending_preload = None
        self.preloading = None
        self.preload_status = '正在掛載模型…'
        self.load_cancel = threading.Event()
        self.current_cancel = threading.Event()
        self.condition = threading.Condition()
        self.stopping = False
        self.thread = threading.Thread(target=self._run, name='local-inference', daemon=True)
        self.thread.start()

    def submit(self, job, text, source, target, profile='opus'):
        with self.condition:
            self.current_cancel.set()
            self.current_cancel = threading.Event()
            self.pending = (job, text, source, target, self.current_cancel, profile)
            if self.preloading and self.preloading[0] == profile:
                self.progress.emit(job, self.preload_status)
            if self.preloading and (self.preloading[0] != profile or
                    (profile == 'opus' and self.preloading[1] != target)):
                self.load_cancel.set()
            if self.pending_preload and self.pending_preload[0] != profile:
                self.pending_preload = None
            self.condition.notify()

    def preload(self, profile, target):
        with self.condition:
            if self.stopping:
                return
            self.pending_preload = (profile, target)
            if self.preloading and (self.preloading[0] != profile or
                    (profile == 'opus' and self.preloading[1] != target)):
                self.load_cancel.set()
            self.condition.notify()

    def cancel(self):
        with self.condition:
            self.current_cancel.set()
            self.pending = None

    def close(self):
        with self.condition:
            self.stopping = True
            self.current_cancel.set()
            self.load_cancel.set()
            self.pending = None
            self.pending_preload = None
            self.condition.notify()
        self.thread.join(1)

    def _preload_progress(self, profile, target, text):
        self.preparing.emit(profile, target, text)
        with self.condition:
            self.preload_status = text
            if self.pending and self.pending[-1] == profile and not self.pending[4].is_set():
                self.progress.emit(self.pending[0], text)

    def _run(self):
        # Import inference dependencies only here, never during window creation.
        engine = None
        engine_profile = None
        cache = OrderedDict()
        while True:
            with self.condition:
                self.condition.wait_for(lambda: self.pending is not None or self.pending_preload is not None or self.stopping)
                if self.stopping:
                    return
                preload = self.pending is None
                if preload:
                    profile, target = self.pending_preload
                    self.pending_preload = None
                    self.preloading = (profile, target)
                    self.preload_status = '正在掛載模型…'
                    self.load_cancel = threading.Event()
                    cancel = self.load_cancel
                else:
                    job, text, source, target, cancel, profile = self.pending
                    self.pending = None
            try:
                if engine is None or engine_profile != profile:
                    engine = None  # Release the previous model before loading a larger one.
                    if self.factory:
                        engine = self.factory()
                    elif profile == 'opus':
                        from .engine import Engine
                        engine = Engine()
                    else:
                        from .multilingual import NllbEngine
                        engine = NllbEngine(profile)
                    engine_profile = profile
                if preload:
                    engine.prepare(target, cancel, lambda text: self._preload_progress(profile, target, text))
                    if not cancel.is_set():
                        self.prepared.emit(profile, target)
                    continue
                key = profile, text, source, target
                if key in cache:
                    result = cache[key]
                    cache.move_to_end(key)
                else:
                    result = engine.translate(text, source, target, cancel,
                        lambda status: self.progress.emit(job, status),
                        lambda value: self.partial.emit(job, value))
                    if not cancel.is_set():
                        cache[key] = result
                        while len(cache) > 64:
                            cache.popitem(last=False)
                if not cancel.is_set():
                    self.finished.emit(job, result)
            except Exception as error:
                if not cancel.is_set():
                    if preload:
                        self.preparation_failed.emit(profile, target, str(error))
                        with self.condition:
                            if self.pending and self.pending[-1] == profile:
                                self.failed.emit(self.pending[0], str(error))
                                self.pending = None
                    else:
                        self.failed.emit(job, str(error))
            finally:
                if preload:
                    with self.condition:
                        self.preloading = None
