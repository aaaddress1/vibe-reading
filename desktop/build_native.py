"""Compile the application to C with optimization and link-time optimization."""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import winreg

ROOT = Path(__file__).resolve().parent
environment = os.environ.copy()
windows = Path(environment.get('SystemRoot', r'C:\Windows'))
environment['PATH'] = os.pathsep.join(map(str, [Path(sys.executable).parent,
    Path(sys.base_prefix) / 'DLLs', windows / 'System32', windows]))
for key in ('PYTHONPATH', 'QT_PLUGIN_PATH', 'QT_QPA_PLATFORM_PLUGIN_PATH', 'QML2_IMPORT_PATH'):
    environment.pop(key, None)
with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Microsoft\Windows Kits\Installed Roots') as key:
    sdk = Path(winreg.QueryValueEx(key, 'KitsRoot10')[0])
versions = [path.name for path in (sdk / 'Include').iterdir()
            if (path / 'um/Windows.h').is_file() and (path / 'ucrt/stdio.h').is_file()
            and (sdk / 'Lib' / path.name / 'um/x64/kernel32.lib').is_file()]
version = max(versions, key=lambda text: tuple(map(int, text.split('.'))))
# Nuitka needs this SDK selector even when the SDK headers and libs are installed.
environment['WindowsSDKVersion'] = version + '\\'
environment['WindowsSdkDir'] = str(sdk) + '\\'
subprocess.run([sys.executable, '-m', 'nuitka', '--mode=standalone',
    '--msvc=latest', '--lto=yes', '--jobs=4', '--enable-plugin=pyside6',
    '--windows-console-mode=disable', '--windows-icon-from-ico=vibe_desktop/assets/icon.png',
    '--include-package=vibe_desktop',
    '--include-data-dir=vibe_desktop/assets=vibe_desktop/assets',
    '--include-package-data=opencc', '--include-package-data=langid',
    '--nofollow-import-to=torch,transformers,pandas,scipy,matplotlib,tkinter',
    '--output-dir=build/native', '--output-filename=VibeReading.exe',
    '--assume-yes-for-downloads', 'run.py'], cwd=ROOT, env=environment, check=True)
output = ROOT / 'dist/VibeReading-native'
shutil.copytree(ROOT / 'build/native/run.dist', output, dirs_exist_ok=True)
subprocess.run([sys.executable, str(ROOT / 'build.py'), '--collected-directory', str(output)],
    cwd=ROOT, env=environment, check=True)
print(output / 'VibeReading.exe', flush=True)
