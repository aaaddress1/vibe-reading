"""Use separate Windows processes: recursive same-thread mutex tests are invalid."""
import subprocess
import sys
import time
import unittest
import uuid

from PySide6.QtNetwork import QLocalServer
from PySide6.QtWidgets import QApplication
from vibe_desktop.instance import InstanceMutex, instance_name


@unittest.skipUnless(sys.platform == 'win32', 'Windows mutex integration')
class InstanceTests(unittest.TestCase):
    def child(self, name, code):
        script = ('import sys; from vibe_desktop.instance import InstanceMutex, activate_existing; '
                  'from PySide6.QtCore import QCoreApplication; app=QCoreApplication([]); '
                  'm=InstanceMutex(sys.argv[1]); ' + code)
        return subprocess.Popen([sys.executable, '-c', script, name], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def test_identity_is_stable_and_contains_user_sid(self):
        self.assertEqual(instance_name(), instance_name())
        self.assertIn('S-1-', instance_name())

    def test_other_process_is_excluded_until_owner_releases(self):
        name = 'VibeReading-test-' + uuid.uuid4().hex
        owner = InstanceMutex(name)
        try:
            self.assertTrue(owner.owned)
            child = self.child(name, 'print(m.owned); m.close()')
            self.assertEqual(child.communicate(timeout=10)[0].strip(), 'False')
        finally:
            owner.close()
        child = self.child(name, 'print(m.owned); m.close()')
        self.assertEqual(child.communicate(timeout=10)[0].strip(), 'True')

    def test_abandoned_mutex_can_be_reclaimed_after_crash(self):
        name = 'VibeReading-test-' + uuid.uuid4().hex
        child = self.child(name, 'print(m.owned, flush=True); sys.stdin.read()')
        contender = None
        try:
            self.assertEqual(child.stdout.readline().strip(), 'True')
            contender = InstanceMutex(name)
            self.assertFalse(contender.owned)
            child.kill()
            child.communicate(timeout=5)
            self.assertTrue(contender.try_acquire())
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=5)
            if contender:
                contender.close()

    def test_secondary_waits_for_startup_and_only_sends_activation(self):
        app = QApplication.instance() or QApplication([])
        name = 'VibeReading-test-' + uuid.uuid4().hex
        owner, server = InstanceMutex(name), QLocalServer()
        child = self.child(name, 'print(activate_existing(sys.argv[1],m,5)); m.close()')
        activations = []
        def accept():
            while server.hasPendingConnections():
                connection = server.nextPendingConnection()
                activations.append(True)
                connection.write(b'ok')
                connection.flush()
                connection.disconnectFromServer()
                connection.disconnected.connect(connection.deleteLater)
        try:
            time.sleep(.5)
            self.assertTrue(server.listen(name))
            server.newConnection.connect(accept)
            deadline = time.monotonic() + 7
            while child.poll() is None and time.monotonic() < deadline:
                app.processEvents()
                time.sleep(.01)
            stdout, stderr = child.communicate(timeout=2)
            self.assertEqual(child.returncode, 0, stderr)
            self.assertEqual(stdout.strip(), 'True')
            self.assertEqual(activations, [True])
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=5)
            server.close()
            owner.close()
