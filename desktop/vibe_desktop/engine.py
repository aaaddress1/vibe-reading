"""Lazy native ONNX inference; only public, pinned model files use the network."""
from collections import OrderedDict
import json
import os
from pathlib import Path
import re
import threading
import urllib.request

REVISIONS = {
    'en-zh': '046f55aec303cdee3e0318604406d4df20f1e8ea',
    'zh-en': '39d480d52a9ea3065a1f117adfe4dbc55de10e6f',
}
FILES = ['config.json', 'tokenizer.json', 'onnx/encoder_model_quantized.onnx',
         'onnx/decoder_model_merged_quantized.onnx']
CACHE = Path(os.environ.get('LOCALAPPDATA', Path.home() / '.cache')) / 'VibeReading' / 'models'


class Cancelled(Exception):
    pass


def check_cancel(cancel):
    if cancel.is_set():
        raise Cancelled()


def detect_source(text, multilingual=False):
    if re.search(r'[\u3040-\u30ff]', text):
        return 'ja'
    if re.search(r'[\uac00-\ud7af]', text):
        return 'ko'
    if re.search(r'[\u3400-\u9fff]', text):
        return 'zh'
    # Short English selections should avoid a cold language-model import.
    if not multilingual and re.fullmatch(r'[\x00-\x7f]*', text):
        return 'en'
    import langid
    return langid.classify(text)[0]


def route_for(source, target):
    source, primary = source.split('-')[0], target.split('-')[0]
    if source == primary:
        return None
    if (source, primary) == ('en', 'zh'):
        return 'en-zh'
    if (source, primary) == ('zh', 'en'):
        return 'zh-en'
    raise ValueError('這個預覽版先支援英文與中文互譯，請選擇對應的來源與目標語言。')


def repeated_trigrams(tokens):
    if len(tokens) < 2:
        return set()
    a, b = tokens[-2:]
    return {tokens[i + 2] for i in range(len(tokens) - 2) if tokens[i:i+2] == [a, b]}


def normalized_tokenizer(config):
    # Xenova exports a null SentencePiece charsmap for its JS tokenizer. Native
    # tokenizers rejects it; NFKC restores the intended Unicode normalization.
    def clean(value):
        if isinstance(value, dict):
            if value.get('type') == 'Precompiled' and value.get('precompiled_charsmap') is None:
                return {'type': 'NFKC'}
            return {key: clean(item) for key, item in value.items()}
        if isinstance(value, list):
            return [clean(item) for item in value]
        return value
    return clean(config)


def model_files(model, cancel, status):
    return download_files('Xenova/opus-mt-' + model, REVISIONS[model], FILES, model, cancel, status)


def download_files(repository, revision, files, key, cancel, status):
    directory = CACHE / key / revision
    directory.mkdir(parents=True, exist_ok=True)
    for name in files:
        check_cancel(cancel)
        destination = directory / name
        if destination.exists():
            continue
        if os.environ.get('VIBE_DESKTOP_OFFLINE') == '1':
            raise OSError('離線模式找不到所需模型；請先連網下載這個語言方向的模型。')
        destination.parent.mkdir(parents=True, exist_ok=True)
        partial = destination.with_suffix(destination.suffix + '.part')
        url = f'https://huggingface.co/{repository}/resolve/{revision}/{name}'
        request = urllib.request.Request(url, headers={'User-Agent': 'VibeReadingDesktop/0.1'})
        try:
            with urllib.request.urlopen(request, timeout=25) as response, partial.open('wb') as stream:
                total = int(response.headers.get('Content-Length', '0'))
                loaded = 0
                while chunk := response.read(512 * 1024):
                    check_cancel(cancel)
                    stream.write(chunk)
                    loaded += len(chunk)
                    status(f'首次下載本機模型 · {loaded/1e6:.0f}' + (f' / {total/1e6:.0f} MB' if total else ' MB'))
                if total and loaded != total:
                    raise OSError('模型下載不完整，請重新翻譯。')
            partial.replace(destination)
        finally:
            partial.unlink(missing_ok=True)
    return directory


NLLB_MODELS = {
    'nllb-600m': ('JustFrederik/nllb-200-distilled-600M-ct2-int8',
                  '302d78f00e6fdb50a1064059df7c392b735e9d05', 'shared_vocabulary.txt'),
    'nllb-1.3b': ('OpenNMT/nllb-200-distilled-1.3B-ct2-int8',
                  '70f572adafa4794890ce7826156a4209717855af', 'shared_vocabulary.json'),
}


def nllb_files(profile, cancel, status):
    repository, revision, vocabulary = NLLB_MODELS[profile]
    return download_files(repository, revision, ['config.json', vocabulary, 'tokenizer.json', 'model.bin', 'README.md'],
                          profile, cancel, status)


class Marian:
    def __init__(self, directory):
        import numpy as np
        import onnxruntime as ort
        from tokenizers import Tokenizer
        self.np = np
        self.config = json.loads((directory / 'config.json').read_text(encoding='utf-8'))
        tokenizer = json.loads((directory / 'tokenizer.json').read_text(encoding='utf-8'))
        self.tokenizer = Tokenizer.from_str(json.dumps(normalized_tokenizer(tokenizer)))
        options = ort.SessionOptions()
        options.intra_op_num_threads = min(4, max(1, (os.cpu_count() or 4) // 2))
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        self.encoder = ort.InferenceSession(str(directory / FILES[2]), options, providers=['CPUExecutionProvider'])
        self.decoder = ort.InferenceSession(str(directory / FILES[3]), options, providers=['CPUExecutionProvider'])
        self.output_names = [item.name for item in self.decoder.get_outputs()]

    def chunks(self, text, prefix):
        # Split by tokens rather than truncating long copies. Every token survives.
        encoded = self.tokenizer.encode(text).ids
        eos = self.config['eos_token_id']
        if encoded and encoded[-1] == eos:
            encoded.pop()
        token = self.tokenizer.token_to_id(prefix) if prefix else None
        lead = [token] if token is not None else []
        for start in range(0, len(encoded), 480):
            yield lead + encoded[start:start+480] + [eos]

    def decode(self, ids, cancel):
        np, cfg = self.np, self.config
        mask = np.ones((1, len(ids)), dtype=np.int64)
        hidden = self.encoder.run(None, {'input_ids': np.array([ids], dtype=np.int64), 'attention_mask': mask})[0]
        layers, heads = cfg['decoder_layers'], cfg['decoder_attention_heads']
        empty = np.empty((1, heads, 0, cfg['d_model'] // heads), dtype=np.float32)
        past = {f'past_key_values.{layer}.{kind}': empty for layer in range(layers)
                for kind in ('decoder.key', 'decoder.value', 'encoder.key', 'encoder.value')}
        tokens, next_id = [], cfg['decoder_start_token_id']
        for step in range(512):
            check_cancel(cancel)
            values = self.decoder.run(None, {'encoder_attention_mask': mask,
                'input_ids': np.array([[next_id]], dtype=np.int64), 'encoder_hidden_states': hidden,
                'use_cache_branch': np.array([step > 0], dtype=np.bool_), **past})
            outputs = dict(zip(self.output_names, values))
            logits = outputs['logits'][0, -1].copy()
            logits[cfg['pad_token_id']] = -np.inf
            for token in repeated_trigrams(tokens):
                logits[token] = -np.inf
            next_id = int(np.argmax(logits))
            if next_id == cfg['eos_token_id']:
                return self.tokenizer.decode(tokens, skip_special_tokens=True).strip()
            tokens.append(next_id)
            for layer in range(layers):
                for kind in ('decoder.key', 'decoder.value', 'encoder.key', 'encoder.value'):
                    if step == 0 or kind.startswith('decoder'):
                        past[f'past_key_values.{layer}.{kind}'] = outputs[f'present.{layer}.{kind}']
        raise ValueError('這段文字的翻譯超過長度上限，請縮短選取內容後重試。')


class Engine:
    def __init__(self):
        self.models = OrderedDict()
        self.converter = None

    def convert(self, text):
        if self.converter is None:
            from opencc import OpenCC
            self.converter = OpenCC('s2twp')
        return self.converter.convert(text)

    def load_model(self, model, cancel, status):
        if model not in self.models:
            directory = model_files(model, cancel, status)
            check_cancel(cancel)
            status('載入本機翻譯模型…')
            self.models[model] = Marian(directory)
            while len(self.models) > 2:
                self.models.popitem(last=False)
        self.models.move_to_end(model)
        return self.models[model]

    def prepare(self, target, cancel, status):
        self.load_model('zh-en' if target == 'en' else 'en-zh', cancel, status)
        check_cancel(cancel)
        if target == 'zh-Hant':
            self.convert('')

    def translate(self, text, source, target, cancel, status, partial):
        source = detect_source(text) if source == 'auto' else source
        model = route_for(source, target)
        if model is None:
            return self.convert(text) if target == 'zh-Hant' else text
        translator = self.load_model(model, cancel, status)
        blocks = re.split(r'(\n[ \t]*\n)', text)
        result = ''
        for block in blocks:
            check_cancel(cancel)
            if not block.strip():
                result += block
                continue
            sentences = re.split(r'(?<=[.!?。！？])\s+', block.strip())
            for sentence in sentences:
                for ids in translator.chunks(sentence, '>>cmn_Hans<<' if model == 'en-zh' else None):
                    status('正在本機翻譯…')
                    translated = translator.decode(ids, cancel)
                    if target == 'zh-Hant':
                        translated = self.convert(translated)
                    if result and not result.endswith('\n') and target == 'en':
                        result += ' '
                    result += translated
                    partial(result)
        return result
