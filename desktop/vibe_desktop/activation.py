"""Bring the user-requested translator forward without leaving it always on top."""
import ctypes
from ctypes import wintypes
import os


def bring_to_foreground(hwnd, stays_on_top=False):
    if os.name != 'nt':
        return False
    user = ctypes.WinDLL('user32', use_last_error=True)
    user.SetForegroundWindow.argtypes = [wintypes.HWND]
    user.SetForegroundWindow.restype = wintypes.BOOL
    user.SetWindowPos.argtypes = [wintypes.HWND, wintypes.HWND, ctypes.c_int,
                                 ctypes.c_int, ctypes.c_int, ctypes.c_int, wintypes.UINT]
    user.SetWindowPos.restype = wintypes.BOOL
    if user.SetForegroundWindow(hwnd):
        return True
    # Windows can reject activation from a background process. A brief z-order
    # promotion still exposes the requested result, without changing focus via
    # synthetic keystrokes or attaching another application's input thread.
    flags = 0x0001 | 0x0002 | 0x0010 | 0x0040  # NOSIZE | NOMOVE | NOACTIVATE | SHOWWINDOW
    user.SetWindowPos(hwnd, -1, 0, 0, 0, 0, flags)  # HWND_TOPMOST
    if not stays_on_top:
        user.SetWindowPos(hwnd, -2, 0, 0, 0, 0, flags)  # HWND_NOTOPMOST
    return bool(user.SetForegroundWindow(hwnd))
