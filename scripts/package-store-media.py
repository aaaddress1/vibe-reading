"""Validate and bundle the current store screenshots and promotional images."""
from pathlib import Path
import hashlib
import json
import struct
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / 'manifest.json').read_text(encoding='utf-8'))['version']
MEDIA = ROOT / 'store' / f'v{VERSION}'
SCREENSHOTS = ['01-layout', '02-paragraphs', '03-summary-ask', '04-web', '05-themes', '06-mobile-edge']


def entries():
    return [
        *[(f'{lang}/{name}-1280x800.png', (1280, 800))
          for lang in ('zh-TW', 'en') for name in SCREENSHOTS],
        ('shared/promo-small-440x280.png', (440, 280)),
        ('shared/promo-marquee-1400x560.png', (1400, 560)),
        ('shared/logo-chrome-128.png', (128, 128)),
        ('shared/logo-edge-300.png', (300, 300)),
        ('shared/logo-512.png', (512, 512)),
        ('UPLOAD-GUIDE.txt', None),
        ('preview.html', None),
        ('contact-sheet.png', None),
        ('assets.json', None),
    ]


def package():
    files = entries()
    for name, size in files:
        data = (MEDIA / name).read_bytes()
        if size:
            assert data[:8] == b'\x89PNG\r\n\x1a\n', name
            assert struct.unpack('>II', data[16:24]) == size, name
    destination = ROOT / f'vibe-reading-store-media-v{VERSION}.zip'
    with zipfile.ZipFile(destination, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for name, _ in files:
            bundle.write(MEDIA / name, name)
    with zipfile.ZipFile(destination) as bundle:
        assert bundle.testzip() is None
        assert len(bundle.namelist()) == len(files)
    checksum = hashlib.sha256(destination.read_bytes()).hexdigest()
    print(json.dumps({'media': str(destination), 'files': len(files),
                      'bytes': destination.stat().st_size, 'sha256': checksum}))
    return destination


if __name__ == '__main__':
    package()
