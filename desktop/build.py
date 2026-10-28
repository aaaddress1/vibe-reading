"""Build a separate, windowed, one-folder Windows application."""
from pathlib import Path
import argparse
import importlib.metadata
import json
import os
import shutil
import subprocess
import sys
from PySide6.QtCore import QSettings
from vibe_desktop.languages import preferred_target
from vibe_desktop import __version__

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--collected-directory', type=Path, help='Validate and package an already compiled distribution')
args = parser.parse_args()
# Binary dependency discovery must not search unrelated tools on the host PATH.
# A Poppler ICU DLL has the same basename as Windows ICU but different exports;
# collecting it causes QtCore to fail with ERROR_PROC_NOT_FOUND on startup.
build_environment = os.environ.copy()
windows = Path(build_environment.get('SystemRoot', r'C:\Windows'))
build_environment['PATH'] = os.pathsep.join(map(str, [
    Path(sys.executable).parent, Path(sys.base_prefix) / 'DLLs', windows / 'System32', windows,
]))
for variable in ('PYTHONPATH', 'QT_PLUGIN_PATH', 'QT_QPA_PLATFORM_PLUGIN_PATH', 'QML2_IMPORT_PATH'):
    build_environment.pop(variable, None)
if not args.collected_directory:
    subprocess.run([sys.executable, '-m', 'PyInstaller', '--clean', '--noconfirm', '--onedir', '--windowed',
    '--name', 'VibeReading', '--contents-directory', '_runtime',
    '--icon', str(ROOT / 'vibe_desktop/assets/icon.png'),
    '--add-data', str(ROOT / 'vibe_desktop/assets') + ';vibe_desktop/assets',
    '--collect-data', 'opencc', '--collect-data', 'langid', '--collect-binaries', 'ctranslate2',
    '--exclude-module', 'tkinter', '--exclude-module', 'matplotlib',
    '--exclude-module', 'pandas', '--exclude-module', 'scipy',
    '--exclude-module', 'torch', '--exclude-module', 'transformers',
    '--exclude-module', 'PySide6.QtQml', '--exclude-module', 'PySide6.QtQuick',
    '--exclude-module', 'PySide6.QtWebEngineCore', '--exclude-module', 'PySide6.QtWebEngineWidgets',
    str(ROOT / 'run.py')], cwd=ROOT, env=build_environment, check=True)
output = args.collected_directory.resolve() if args.collected_directory else ROOT / 'dist/VibeReading'
assert not (output / '_runtime/icuuc.dll').exists(), 'Unexpected bundled ICU: use the Windows system library'

# Validate the actual executable before producing the MSI installer. Keep its
# working directory and PATH independent of the source checkout and tool suite.
validation = ROOT / 'preview/frozen'
validation.mkdir(parents=True, exist_ok=True)
validation_environment = build_environment.copy()
validation_environment['PATH'] = os.pathsep.join(map(str, [windows / 'System32', windows]))
validation_environment['VIBE_DESKTOP_OFFLINE'] = '1'
validation_environment['PYTHONNOUSERSITE'] = '1'
subprocess.run([str(output / 'VibeReading.exe'), '--no-hook', '--smoke-test', str(validation), '--smoke-profile', 'nllb-600m'],
    cwd=validation, env=validation_environment, check=True, timeout=120)
measurements = json.loads((validation / 'measurements.json').read_text(encoding='utf-8'))
assert measurements.get('translation'), 'Packaged executable did not produce a translation'
assert measurements.get('modelLoadedBeforeFirstTranslation'), 'Model was not mounted before the first translation'
selection = measurements['startupLanguageSelection']
assert selection['target'] == preferred_target(QSettings('VibeReading', 'Desktop'), selection['engine']), 'Incorrect startup target language'
assert selection['windowsMatch'], 'Language selectors do not match the startup target'
assert measurements.get('popupHiddenForFullWindow'), 'Popup did not hide when opening the full window'
assert measurements.get('fullWindowRemainsVisible'), 'Full window incorrectly hid after losing focus'
assert measurements.get('exclusiveTranslationWindows'), 'Translation windows overlapped'
assert (validation / 'full-window.png').exists() and (validation / 'popup-window.png').exists()
print('Packaged executable: startup language, offline translation and both real windows verified.', flush=True)
queued_validation = ROOT / 'preview/frozen-queued'
queued_validation.mkdir(parents=True, exist_ok=True)
subprocess.run([str(output / 'VibeReading.exe'), '--no-hook', '--smoke-test', str(queued_validation),
    '--smoke-profile', 'nllb-1.3b', '--smoke-queued'], cwd=queued_validation,
    env=validation_environment, check=True, timeout=120)
queued = json.loads((queued_validation / 'measurements.json').read_text(encoding='utf-8'))
assert queued.get('translation') and queued.get('translationQueuedBehindPreload'), 'Startup request did not finish behind the model mount'
print('Packaged executable: translation queued during model mounting completed.', flush=True)
subprocess.run([sys.executable, str(ROOT / 'tests/check_packaged_instance.py'),
    str(output / 'VibeReading.exe'), str(validation / 'single-instance.json')],
    cwd=ROOT, env=validation_environment, check=True, timeout=60)
shutil.copyfile(ROOT / 'README.md', output / 'README.md')
shutil.copyfile(ROOT / 'README.en.md', output / 'README.en.md')
shutil.copyfile(ROOT / 'THIRD_PARTY.md', output / 'THIRD_PARTY.md')
shutil.copyfile(ROOT.parent / 'LICENSE', output / 'LICENSE')
licenses = output / 'licenses'
shutil.copytree(ROOT / 'licenses', licenses, dirs_exist_ok=True)
license_packages = ['PySide6_Essentials', 'shiboken6', 'onnxruntime', 'tokenizers', 'numpy', 'opencc-python-reimplemented', 'langid', 'ctranslate2', 'pyyaml']
if args.collected_directory:
    license_packages.append('nuitka')
for name in license_packages:
    distribution = importlib.metadata.distribution(name)
    for item in distribution.files or []:
        if any(part.lower() in ('licenses', 'license', 'copying', 'copyright', 'notice') for part in item.parts) or item.name.lower().startswith(('license', 'copying', 'copyright', 'notice')):
            source = Path(distribution.locate_file(item))
            if source.is_file():
                target = licenses / name / Path(*item.parts[-3:])
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
subprocess.run([sys.executable, str(ROOT / 'build_installer.py'), '--source', str(output)],
    cwd=ROOT, env=build_environment, check=True)

# Keep the collected, runnable app as the only clickable EXE. PyInstaller's
# work-directory executable has no runtime beside it and cannot run there.
intermediate = ROOT / 'build/VibeReading/VibeReading.exe'
if intermediate.exists():
    intermediate.replace(intermediate.with_suffix('.intermediate'))
for shortcut_path in (ROOT / 'VibeReading.lnk', ROOT / 'build/VibeReading/VibeReading.lnk'):
    quote = lambda path: str(path).replace("'", "''")
    shortcut_script = f"""$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut('{quote(shortcut_path)}')
$shortcut.TargetPath = '{quote(output / 'VibeReading.exe')}'
$shortcut.Arguments = '--show'
$shortcut.WorkingDirectory = '{quote(output)}'
$shortcut.IconLocation = $shortcut.TargetPath + ',0'
$shortcut.Save()
"""
    subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', shortcut_script], check=True)
