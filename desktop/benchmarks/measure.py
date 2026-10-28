"""Reproducible CPU timing; excludes download, model mounting and service cache."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import threading
import time
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from vibe_desktop.multilingual import NllbEngine

parser = argparse.ArgumentParser()
parser.add_argument('--profile', default='nllb-1.3b')
parser.add_argument('--threads', default='4,8,2')
parser.add_argument('--output', default='preview/cpu-tuning.json')
parser.add_argument('--batch', type=int, default=2)
parser.add_argument('--paragraphs', type=int)
parser.add_argument('--input', default='long-text-en.txt')
parser.add_argument('--runs', type=int, default=1)
args = parser.parse_args()
text = Path(__file__).with_name(args.input).read_text(encoding='utf-8').strip()
if args.paragraphs:
    text = '\n\n'.join(text.split('\n\n')[:args.paragraphs])
import ctranslate2
constructor = ctranslate2.Translator
results = []
for threads in map(int, args.threads.split(',')):
    def create(*a, **kw):
        kw['intra_threads'] = threads
        return constructor(*a, **kw)
    engine = NllbEngine(args.profile)
    engine.batch_size = args.batch
    with patch('ctranslate2.Translator', create):
        started = time.perf_counter()
        engine.prepare('zh-Hant', threading.Event(), lambda text: None)
        mounted = time.perf_counter() - started
    # Prime native kernels, separately from the full-passage measurement.
    engine.translate('A translation model runs on this computer.', 'en', 'zh-Hant',
                     threading.Event(), lambda text: None, lambda text: None)
    timings = []
    for _ in range(args.runs):
        started = time.perf_counter()
        output = engine.translate(text, 'auto', 'zh-Hant', threading.Event(), lambda text: None, lambda text: None)
        timings.append(time.perf_counter()-started)
    row = dict(profile=args.profile, threads=threads, batchSize=args.batch, mountSeconds=mounted,
               completeTranslationSeconds=timings, translation=output)
    results.append(row)
    Path(args.output).write_text(json.dumps(dict(inputCharacters=len(text), inputWords=len(text.split()),
        inputSha256=hashlib.sha256(text.encode()).hexdigest(), source='auto (English)', target='zh-Hant',
        beamSize=4, runtime=ctranslate2.__version__, results=results), ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k:v for k,v in row.items() if k != 'translation'}), flush=True)
    del engine
