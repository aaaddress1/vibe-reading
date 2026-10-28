"""Normalize supplied screenshots to the shared Chrome/Edge upload dimensions."""
import argparse
from pathlib import Path
import struct
import zipfile
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SIZE = (1280, 800)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('images', nargs='+', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / 'store' / 'upload-screenshots')
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    outputs = []
    for index, source in enumerate(args.images, 1):
        destination = args.output / f'{index:02d}-{source.stem}-1280x800.png'
        with Image.open(source) as image:
            # Store uploads need exact dimensions. Keep the entire supplied UI
            # visible and flatten alpha rather than cutting either reading pane.
            rgba = image.convert('RGBA')
            flattened = Image.new('RGB', image.size, '#191919')
            flattened.paste(rgba, mask=rgba.getchannel('A'))
            flattened.resize(SIZE, Image.Resampling.LANCZOS).save(destination, optimize=True)
        with Image.open(destination) as check:
            assert check.size == SIZE and check.mode == 'RGB'
            check.verify()
        data = destination.read_bytes()
        assert struct.unpack('>II', data[16:24]) == SIZE
        assert data[24:26] == bytes([8, 2]), 'Must be 24-bit RGB PNG without alpha'
        outputs.append(destination)
        print(f'{destination}: 1280x800, RGB PNG, {len(data):,} bytes')
    guide = args.output / 'UPLOAD-GUIDE.txt'
    guide.write_text(
        '這兩張請上傳至 Chrome / Edge 商城的「螢幕擷取畫面／Screenshots」欄位。\n'
        '規格：1280×800，24-bit RGB PNG，無透明色。原始圖片未覆寫。\n'
        '為保留完整工具列及兩側內容，整張畫面縮放至商城指定比例。\n'
        '小型宣傳圖與大型宣傳圖是不同欄位，分別使用 440×280 與 1400×560。\n'
        'https://developer.chrome.com/docs/webstore/images\n'
        'https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension\n', encoding='utf-8')
    archive = ROOT / 'vibe-reading-upload-screenshots-1280x800.zip'
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as bundle:
        for path in [*outputs, guide]:
            bundle.write(path, path.name)
    print(archive)


if __name__ == '__main__':
    main()
