"""A pass-through Win32 keyboard hook. No key logging or clipboard polling."""
import ctypes
from ctypes import wintypes
import os
import threading
import time


class DoubleCopy:
    """Trigger on the second C release, ignoring key-repeat and unrelated keys."""
    def __init__(self, interval=0.55):
        self.interval = interval
        self.first = None
        self.sequence = 0
        self.owner = 0
        self.down = False
        self.pending = False

    def feed(self, key, down, ctrl, now, sequence=0, owner=0):
        if key != 0x43:
            if down and key not in (0x11, 0xA2, 0xA3):
                self.first = None
                self.pending = False
            return None
        if not down:
            self.down = False
            if self.pending:
                self.pending = False
                return self.sequence, self.owner, now
            return None
        if self.down:
            return None
        self.down = True
        if not ctrl:
            self.first = None
            return None
        if self.first is not None and now - self.first <= self.interval and owner == self.owner:
            self.pending = True
            self.first = None
        else:
            self.first, self.sequence, self.owner = now, sequence, owner
        return None


class KeyboardHook:
    def __init__(self, callback, on_error, interval=0.55):
        self.callback = callback
        self.on_error = on_error
        self.detector = DoubleCopy(interval)
        self.thread_id = None
        self.started = threading.Event()
        self.thread = threading.Thread(target=self._run, name='double-copy-hook', daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.started.wait(1)
        if self.thread_id:
            ctypes.windll.user32.PostThreadMessageW(self.thread_id, 0x0012, 0, 0)
        self.thread.join(1)

    def _run(self):
        if os.name != 'nt':
            self.on_error('雙按 Ctrl+C 目前只支援 Windows。')
            self.started.set()
            return
        user = ctypes.WinDLL('user32', use_last_error=True)
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        result_type = ctypes.c_ssize_t
        proc_type = ctypes.WINFUNCTYPE(result_type, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)
        class Packet(ctypes.Structure):
            _fields_ = [('vkCode', wintypes.DWORD), ('scanCode', wintypes.DWORD),
                        ('flags', wintypes.DWORD), ('time', wintypes.DWORD), ('extra', ctypes.c_size_t)]
        user.SetWindowsHookExW.argtypes = [ctypes.c_int, proc_type, wintypes.HINSTANCE, wintypes.DWORD]
        user.SetWindowsHookExW.restype = wintypes.HANDLE
        user.CallNextHookEx.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM]
        user.CallNextHookEx.restype = result_type
        user.UnhookWindowsHookEx.argtypes = [wintypes.HANDLE]
        user.GetForegroundWindow.restype = wintypes.HWND
        kernel.GetModuleHandleW.restype = wintypes.HMODULE
        kernel.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]

        @proc_type
        def hook(code, message, data):
            if code >= 0 and message in (0x100, 0x101, 0x104, 0x105):
                packet = ctypes.cast(data, ctypes.POINTER(Packet)).contents
                # LLKHF_INJECTED remains allowed: accessibility and automation tools
                # must be able to copy. No input is ever suppressed.
                try:
                    event = self.detector.feed(packet.vkCode, message in (0x100, 0x104),
                        bool(user.GetAsyncKeyState(0x11) & 0x8000), time.perf_counter(),
                        user.GetClipboardSequenceNumber(), user.GetForegroundWindow())
                    if event:
                        self.callback(event)
                except Exception:
                    pass  # Never break ordinary Ctrl+C because of our UI.
            return user.CallNextHookEx(None, code, message, data)

        # Establish the message queue before stop() can post WM_QUIT.
        message = wintypes.MSG()
        user.PeekMessageW(ctypes.byref(message), None, 0, 0, 0)
        self.thread_id = kernel.GetCurrentThreadId()
        handle = user.SetWindowsHookExW(13, hook, kernel.GetModuleHandleW(None), 0)
        self.started.set()
        if not handle:
            self.on_error('無法啟用快捷鍵：' + str(ctypes.WinError(ctypes.get_last_error())))
            return
        try:
            while user.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
                user.TranslateMessage(ctypes.byref(message))
                user.DispatchMessageW(ctypes.byref(message))
        finally:
            user.UnhookWindowsHookEx(handle)


def clipboard_sequence():
    return ctypes.windll.user32.GetClipboardSequenceNumber() if os.name == 'nt' else 0
