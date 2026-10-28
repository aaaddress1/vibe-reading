"""Build the default per-user Windows MSI, with shortcuts and upgrade support."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import uuid
import xml.etree.ElementTree as ET

from PIL import Image
from vibe_desktop import __version__

ROOT = Path(__file__).resolve().parent
WIX_VERSION = '4.0.6'
UPGRADE = uuid.UUID('b8cbfc97-cb17-4b14-8855-980b84333cc8')
NS = 'http://wixtoolset.org/schemas/v4/wxs'
UI = NS + '/ui'
ET.register_namespace('', NS)
ET.register_namespace('ui', UI)


def element(parent, tag, **attrs):
    return ET.SubElement(parent, '{' + NS + '}' + tag, {key: str(value) for key, value in attrs.items()})


def identifier(path):
    return hashlib.sha256(str(path).replace('\\', '/').lower().encode()).hexdigest()[:28]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', type=Path, default=ROOT / 'dist/VibeReading-native')
    args = parser.parse_args()
    source = args.source.resolve()
    if not (source / 'VibeReading.exe').is_file():
        raise FileNotFoundError('Build the desktop application before creating the installer.')
    for name in ('README.md', 'README.en.md', 'THIRD_PARTY.md'):
        shutil.copyfile(ROOT / name, source / name)
    tools = ROOT / 'build/tools'
    wix = tools / 'wix.exe'
    environment = os.environ.copy()
    environment.setdefault('DOTNET_ROLL_FORWARD', 'Major')
    if not wix.exists():
        subprocess.run(['dotnet', 'tool', 'install', '--tool-path', str(tools), 'wix', '--version', WIX_VERSION], check=True, env=environment)
    subprocess.run([str(wix), 'extension', 'add', 'WixToolset.UI.wixext/' + WIX_VERSION], check=True, cwd=ROOT, env=environment)
    work = ROOT / 'build/installer'
    work.mkdir(parents=True, exist_ok=True)
    icon = work / 'product.ico'
    Image.open(ROOT / 'vibe_desktop/assets/icon.png').save(icon, format='ICO', sizes=[(16, 16), (32, 32), (48, 48), (128, 128), (256, 256)])
    license_text = (ROOT.parent / 'LICENSE').read_text(encoding='utf-8')
    escaped = license_text.replace('\\', '\\\\').replace('{', '\\{').replace('}', '\\}').replace('\n', '\\par\n')
    license_rtf = work / 'license.rtf'
    license_rtf.write_text(r'{\rtf1\ansi\deff0{\fonttbl{\f0 Segoe UI;}}\f0\fs20 ' + escaped + '}', encoding='utf-8')
    document = ET.Element('{' + NS + '}Wix')
    package = element(document, 'Package', Name='氛圍閱讀 Vibe Reading', Manufacturer='aaaddress1',
        Version=__version__, UpgradeCode='{' + str(UPGRADE) + '}', Language='1028', Codepage='950', Scope='perUser', InstallerVersion='500')
    element(package, 'SummaryInformation', Description='氛圍閱讀 Windows 桌面翻譯安裝程式', Manufacturer='aaaddress1', Codepage='950')
    element(package, 'MajorUpgrade', AllowSameVersionUpgrades='yes', Schedule='afterInstallInitialize', DowngradeErrorMessage='已安裝較新的氛圍閱讀版本。')
    element(package, 'MediaTemplate', EmbedCab='yes', CompressionLevel='high')
    element(package, 'Icon', Id='ProductIcon', SourceFile=icon)
    for key, value in {'ARPPRODUCTICON': 'ProductIcon', 'ARPURLINFOABOUT': 'https://github.com/aaaddress1/vibe-reading',
                       'ARPHELPLINK': 'https://github.com/aaaddress1/vibe-reading/issues'}.items():
        element(package, 'Property', Id=key, Value=value)
    element(package, 'WixVariable', Id='WixUILicenseRtf', Value=license_rtf)
    ET.SubElement(package, '{' + UI + '}WixUI', Id='WixUI_InstallDir', InstallDirectory='INSTALLFOLDER')
    element(package, 'UIRef', Id='WixUI_ErrorProgressText')
    local = element(package, 'StandardDirectory', Id='LocalAppDataFolder')
    programs = element(local, 'Directory', Id='UserPrograms', Name='Programs')
    install = element(programs, 'Directory', Id='INSTALLFOLDER', Name='VibeReading')
    directories = {Path('.'): install}
    feature = element(package, 'Feature', Id='MainFeature', Title='Vibe Reading', Level='1')
    def component(directory, identity):
        comp_id = 'C' + identifier(identity)
        comp = element(directory, 'Component', Id=comp_id, Guid='{' + str(uuid.uuid5(UPGRADE, identity.lower())) + '}', Bitness='always64')
        element(comp, 'RegistryValue', Root='HKCU', Key=r'Software\VibeReading\Installer\Components', Name=comp_id,
                Type='integer', Value='1', KeyPath='yes')
        element(feature, 'ComponentRef', Id=comp_id)
        return comp
    def directory(relative):
        if relative not in directories:
            parent = directory(relative.parent)
            directories[relative] = element(parent, 'Directory', Id='D' + identifier(relative), Name=relative.name)
        return directories[relative]
    files = sorted(path for path in source.rglob('*') if path.is_file())
    for path in files:
        relative = path.relative_to(source)
        comp = component(directory(relative.parent), 'file/' + relative.as_posix())
        element(comp, 'File', Id='F' + identifier(relative), Source=path, Name=path.name)
    for relative, node in list(directories.items()):
        cleanup = component(node, 'directory/' + relative.as_posix())
        element(cleanup, 'RemoveFolder', Id='R' + identifier(relative), On='uninstall')
    desktop = element(package, 'StandardDirectory', Id='DesktopFolder')
    start = element(package, 'StandardDirectory', Id='ProgramMenuFolder')
    start_app = element(start, 'Directory', Id='StartMenuAppFolder', Name='Vibe Reading')
    for identity, parent in [('DesktopShortcut', desktop), ('StartMenuShortcut', start_app)]:
        comp = component(parent, identity)
        element(comp, 'Shortcut', Id=identity, Name='Vibe Reading', Description='選取文字後雙按 Ctrl+C 翻譯',
                Target='[INSTALLFOLDER]VibeReading.exe', Arguments='--show', WorkingDirectory='INSTALLFOLDER', Icon='ProductIcon')
        if identity == 'StartMenuShortcut':
            element(comp, 'RemoveFolder', Id='RemoveStartMenuFolder', On='uninstall')
    wxs = work / 'VibeReading.wxs'
    ET.indent(document)
    ET.ElementTree(document).write(wxs, encoding='utf-8', xml_declaration=True)
    output = ROOT.parent / f'vibe-reading-desktop-v{__version__}-windows-x64.msi'
    subprocess.run([str(wix), 'build', str(wxs), '-arch', 'x64', '-culture', 'zh-TW',
        '-ext', 'WixToolset.UI.wixext/' + WIX_VERSION, '-intermediateFolder', str(work / 'obj'), '-o', str(output)],
        cwd=ROOT, env=environment, check=True)
    checksum = hashlib.sha256(output.read_bytes()).hexdigest()
    output.with_suffix('.sha256').write_text(checksum + '  ' + output.name + '\n', encoding='utf-8')
    (work / 'payload.json').write_text(json.dumps({path.relative_to(source).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in files}, indent=2), encoding='utf-8')
    print(f'Windows MSI installer: {output} ({output.stat().st_size / 1e6:.1f} MB)', flush=True)


if __name__ == '__main__':
    main()
