"""Launch the real EXE concurrently, then verify relaunch and crash recovery."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vibe_desktop.instance import InstanceMutex, instance_name

parser = argparse.ArgumentParser()
parser.add_argument('executable', type=Path)
parser.add_argument('report', type=Path)
args = parser.parse_args()
children = []
def launch():
    process = subprocess.Popen([str(args.executable.resolve()), '--no-hook', '--show'],
                               cwd=args.executable.resolve().parent)
    children.append(process)
    return process
try:
    probe = InstanceMutex(instance_name())
    existing_primary = not probe.owned
    probe.close()
    for _ in range(9):
        launch()
    if existing_primary:
        exits = [process.wait(timeout=12) for process in children]
        assert exits == [0] * 9, exits
        report = dict(concurrentLaunches=9, newPrimaryProcesses=0, existingPrimaryReused=True,
                      secondaryExitCodes=exits, existingProcessAcknowledgedActivation=True,
                      crashRecovery='Not exercised against an existing user process', executable=str(args.executable.resolve()))
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, indent=2), encoding='utf-8')
        print('Real EXE: nine launches reused the already running user application.', flush=True)
        raise SystemExit(0)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        alive = [process for process in children if process.poll() is None]
        if len(alive) == 1:
            break
        time.sleep(.1)
    assert len(alive) == 1, f'{len(alive)} processes survived concurrent startup'
    primary = alive[0]
    exits = [process.wait(timeout=2) for process in children if process is not primary]
    assert exits == [0] * 8, exits
    secondary = launch()
    assert secondary.wait(timeout=12) == 0, 'Existing app did not acknowledge activation'
    assert primary.poll() is None, 'Relaunch replaced the primary'
    primary.terminate()
    primary.wait(timeout=5)
    replacement = launch()
    time.sleep(2)
    assert replacement.poll() is None, 'Could not restart after a terminated primary'
    secondary = launch()
    assert secondary.wait(timeout=12) == 0, 'Replacement did not acknowledge activation'
    assert replacement.poll() is None
    report = dict(concurrentLaunches=9, survivingPrimaryProcesses=1,
                  secondaryExitCodes=exits, existingProcessAcknowledgedActivation=True,
                  crashRecovery=True, executable=str(args.executable.resolve()))
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2), encoding='utf-8')
    print('Real EXE: nine concurrent launches, activation and crash recovery passed.', flush=True)
finally:
    for process in children:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)
