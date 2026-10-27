"""Build upload-ready extension/brand ZIPs using only Python's standard library."""
from pathlib import Path
from html.parser import HTMLParser
import hashlib
import json
import re
import struct
import zipfile

ROOT = Path(__file__).resolve().parents[1]
manifest = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))
version = manifest['version']
if not re.fullmatch(r'\d+\.\d+\.\d+', version):
    raise ValueError('Expected a three-part release version in manifest.json')

runtime = [
    'manifest.json', 'background.js', 'content.js', 'content.css', 'translate-core.js',
    'layout.js', 'local-mt.js', 'options.html', 'options.js', 'viewer.html', 'viewer.js',
    'viewer.css', 'pdf-overlay.js', 'theme.css', 'theme.js', 'LICENSE',
]
runtime += ['icons/' + name for name in (
    'icon16.png', 'icon48.png', 'icon128.png', 'store-icon-128.png', 'author-avatar.webp', 'busy.svg')]
runtime += [p.relative_to(ROOT).as_posix() for p in (ROOT / 'lib').rglob('*') if p.is_file()]


class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        for key, value in attrs:
            if key in ('src', 'href') and value and not re.match(r'^(?:https?:|#|data:)', value):
                self.paths.append(value)


def archive(destination, entries):
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for source, target in sorted(entries, key=lambda item: item[1]):
            bundle.write(source, target)
    with zipfile.ZipFile(destination) as bundle:
        assert bundle.testzip() is None, 'Corrupt ZIP entry'


package = ROOT / f'vibe-reading-store-v{version}.zip'
archive(package, [(ROOT / name, name) for name in runtime])
with zipfile.ZipFile(package) as bundle:
    names = set(bundle.namelist())
    assert 'manifest.json' in names and 'pdf-overlay.js' in names
    assert not any(n.startswith(('tests/', 'tmp/', '.git/')) for n in names)
    assert json.loads(bundle.read('manifest.json'))['version'] == version
    for group in manifest['content_scripts']:
        for name in group['js'] + group['css']:
            assert name in names, name
    for name in [*manifest['icons'].values(), manifest['background']['service_worker']]:
        assert name in names, name
    for name in ('viewer.html', 'options.html'):
        refs = References()
        refs.feed(bundle.read(name).decode('utf-8'))
        for ref in refs.paths:
            assert ref in names, f'{name}: missing {ref}'

for name, size in [('logo-chrome-128.png', 128), ('logo-edge-300.png', 300), ('logo-512.png', 512)]:
    data = (ROOT / 'store' / name).read_bytes()
    assert data[:8] == b'\x89PNG\r\n\x1a\n'
    assert struct.unpack('>II', data[16:24]) == (size, size)

brand_names = ['logo-chrome-128.png', 'logo-edge-300.png', 'logo-512.png',
               'reading-illustration.png', 'logo-prompt.txt', f'release-notes-v{version}.txt',
               'pdf-layout-v2.1.png', 'pdf-inline-edit-v2.1.png']
brand = ROOT / f'vibe-reading-brand-v{version}.zip'
archive(brand, [(ROOT / 'store' / name, name) for name in brand_names])
checksums = ROOT / 'store' / f'checksums-v{version}.txt'
checksums.write_text(''.join(hashlib.sha256(p.read_bytes()).hexdigest() + '  ' + p.name + '\n'
                             for p in (package, brand)), encoding='utf-8')
print(json.dumps({'version': version, 'runtimeFiles': len(runtime),
                  'packageBytes': package.stat().st_size, 'brandBytes': brand.stat().st_size,
                  'checksums': str(checksums)}, ensure_ascii=False))
