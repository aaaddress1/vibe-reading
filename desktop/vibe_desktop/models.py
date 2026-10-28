"""Selectable native machine-translation profiles. No LLM service is required."""
MODELS = (
    ('NLLB 1.3B · 多語品質優先', 'nllb-1.3b'),
    ('NLLB 600M · 多語均衡', 'nllb-600m'),
    ('Opus-MT · 中英輕量快速', 'opus'),
)
MODEL_IDS = frozenset(code for _, code in MODELS)
DEFAULT_MODEL = 'nllb-1.3b'
NOTES = {
    'opus': '英文 ↔ 中文；每個方向約 120MB。原本的輕量翻譯模型。',
    'nllb-600m': '約 200 種語言；首次下載約 650MB。INT8 地端推論，兼顧速度與品質。\n模型授權：CC-BY-NC 4.0，僅限非商業用途。',
    'nllb-1.3b': '約 200 種語言；首次下載約 1.4GB。較大模型，速度較慢，品質優先。\n模型授權：CC-BY-NC 4.0，僅限非商業用途。',
}


def preferred_model(settings):
    value = settings.value('engine', DEFAULT_MODEL)
    return value if value in MODEL_IDS else DEFAULT_MODEL
