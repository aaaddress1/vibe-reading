"""INT8 encoder/decoder translation through the native CTranslate2 runtime."""
import os
import re
from .engine import Engine, check_cancel, detect_source, nllb_files, normalized_tokenizer
from .languages import ISO_CODES, NLLB_CODES


def language_token(code):
    token = NLLB_CODES.get(code) or NLLB_CODES.get(ISO_CODES.get(code))
    if token is None:
        raise ValueError('無法辨識這段文字的語言，請手動選擇來源語言。')
    return token


class NllbEngine(Engine):
    def __init__(self, profile):
        super().__init__()
        self.profile = profile
        self.translator = None
        self.tokenizer = None
        self.batch_size = 2

    def load(self, cancel, status):
        import json
        import ctranslate2
        from tokenizers import Tokenizer
        directory = nllb_files(self.profile, cancel, status)
        check_cancel(cancel)
        status('載入多語地端翻譯模型…')
        tokenizer = json.loads((directory / 'tokenizer.json').read_text(encoding='utf-8'))
        self.tokenizer = Tokenizer.from_str(json.dumps(normalized_tokenizer(tokenizer)))
        self.translator = ctranslate2.Translator(str(directory), device='cpu', compute_type='int8',
            inter_threads=1, intra_threads=min(4, max(1, (os.cpu_count() or 4) // 2)))

    def prepare(self, target, cancel, status):
        if self.translator is None:
            self.load(cancel, status)
        check_cancel(cancel)
        if target == 'zh-Hant':
            self.convert('')
        # Initialize automatic language detection before the first selection too.
        detect_source('This is an English sentence.', multilingual=True)
        check_cancel(cancel)

    def translate(self, text, source, target, cancel, status, partial):
        status('正在辨識來源語言…' if source == 'auto' else '正在處理原文…')
        source = detect_source(text, multilingual=True) if source == 'auto' else source
        source_token, target_token = language_token(source), language_token(target)
        if source_token == target_token:
            return text
        if source.startswith('zh') and target.startswith('zh'):
            if target == 'zh-Hant':
                return self.convert(text)
            from opencc import OpenCC
            return OpenCC('t2s').convert(text)
        # The simplified-Chinese branch preserves meaning more reliably in our
        # regression cases than direct zho_Hant generation. Normalize Chinese
        # input and render the resulting translation in the requested script.
        if source.startswith('zh'):
            from opencc import OpenCC
            text = OpenCC('t2s').convert(text)
            source_token = 'zho_Hans'
        if target == 'zh-Hant':
            target_token = 'zho_Hans'
        if self.translator is None:
            self.load(cancel, status)
        work, separator = [], ''
        for block in re.split(r'(\n[ \t]*\n)', text):
            check_cancel(cancel)
            if not block.strip():
                separator += block
                continue
            status('正在處理原文…')
            tokens = self.tokenizer.encode(block, add_special_tokens=False).tokens
            # Keep paragraphs together for context, and split long input by
            # tokens rather than truncating text at the model's 512-token limit.
            for start in range(0, len(tokens), 480):
                check_cancel(cancel)
                source_tokens = [source_token, *tokens[start:start + 480], '</s>']
                work.append((separator, source_tokens))
                separator = ''
        result = ''
        for start in range(0, len(work), self.batch_size):
            check_cancel(cancel)
            batch = work[start:start + self.batch_size]
            status(f'正在本機翻譯 · {min(start + len(batch), len(work))}/{len(work)} · ' + self.profile.replace('nllb-', 'NLLB '))
            predictions = self.translator.translate_batch([tokens for _, tokens in batch],
                target_prefix=[[target_token] for _ in batch], beam_size=4,
                max_input_length=0, max_decoding_length=512, return_end_token=True)
            for (before, _), prediction in zip(batch, predictions, strict=True):
                check_cancel(cancel)
                prediction = prediction.hypotheses[0]
                if not prediction or prediction[-1] != '</s>':
                    raise ValueError('這段譯文超過長度上限，請縮短選取內容後重試。')
                output = [self.tokenizer.token_to_id(token) for token in prediction[1:-1]]
                translated = self.tokenizer.decode(output, skip_special_tokens=True).strip()
                if target == 'zh-Hant':
                    translated = self.convert(translated)
                result += before
                if result and not result.endswith('\n') and not target.startswith(('zh', 'ja', 'ko')):
                    result += ' '
                result += translated
                partial(result)
        return result + separator
