import unittest
from vibe_desktop.shortcut import DoubleCopy


class DoubleCopyTests(unittest.TestCase):
    def test_trigger_only_after_second_copy_releases(self):
        detector = DoubleCopy()
        self.assertIsNone(detector.feed(67, True, True, 1, 50, 99))
        self.assertIsNone(detector.feed(67, False, True, 1.02, 51, 99))
        self.assertIsNone(detector.feed(67, True, True, 1.2, 51, 99))
        self.assertEqual(detector.feed(67, False, True, 1.22), (50, 99, 1.22))
        self.assertIsNone(detector.feed(67, False, True, 1.24))

    def test_holding_c_does_not_count_as_repeated_copy(self):
        detector = DoubleCopy()
        detector.feed(67, True, True, 1, 10, 1)
        detector.feed(67, True, True, 1.1, 11, 1)
        self.assertIsNone(detector.feed(67, False, True, 1.2))

    def test_separate_ctrl_presses_are_allowed(self):
        detector = DoubleCopy()
        detector.feed(67, True, True, 1, 10, 1)
        detector.feed(67, False, True, 1.01)
        detector.feed(17, False, False, 1.02)
        detector.feed(17, True, True, 1.2)
        detector.feed(67, True, True, 1.21, 11, 1)
        self.assertIsNotNone(detector.feed(67, False, True, 1.22))

    def test_unrelated_key_slow_copy_or_new_app_does_not_trigger(self):
        for key, second_time, owner in [(65, 1.2, 1), (17, 2, 1), (17, 1.2, 2)]:
            detector = DoubleCopy()
            detector.feed(67, True, True, 1, 10, 1)
            detector.feed(67, False, True, 1.01)
            detector.feed(key, True, True, 1.1)
            detector.feed(67, True, True, second_time, 11, owner)
            self.assertIsNone(detector.feed(67, False, True, second_time + .01))


if __name__ == '__main__':
    unittest.main()
