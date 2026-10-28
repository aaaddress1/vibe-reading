import unittest
from unittest.mock import Mock, patch
from vibe_desktop.activation import bring_to_foreground


class ActivationTests(unittest.TestCase):
    def test_successful_foreground_request_does_not_change_topmost(self):
        user = Mock()
        user.SetForegroundWindow.return_value = True
        with patch('vibe_desktop.activation.ctypes.WinDLL', return_value=user):
            self.assertTrue(bring_to_foreground(123))
        user.SetWindowPos.assert_not_called()

    def test_denied_activation_brings_full_window_forward_without_pin(self):
        user = Mock()
        user.SetForegroundWindow.side_effect = [False, True]
        with patch('vibe_desktop.activation.ctypes.WinDLL', return_value=user):
            self.assertTrue(bring_to_foreground(123))
        self.assertEqual([call.args[1] for call in user.SetWindowPos.call_args_list], [-1, -2])

    def test_popup_keeps_its_existing_topmost_behavior(self):
        user = Mock()
        user.SetForegroundWindow.side_effect = [False, True]
        with patch('vibe_desktop.activation.ctypes.WinDLL', return_value=user):
            self.assertTrue(bring_to_foreground(123, stays_on_top=True))
        self.assertEqual([call.args[1] for call in user.SetWindowPos.call_args_list], [-1])
