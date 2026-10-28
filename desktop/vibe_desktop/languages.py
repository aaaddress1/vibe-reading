"""System-language defaults and explicit user choices for translation."""
import json
from pathlib import Path
from PySide6.QtCore import QLocale


OPUS_LANGUAGES = (
    ('中文（繁體）', 'zh-Hant'),
    ('中文（简体）', 'zh-Hans'),
    ('English', 'en'),
)
CATALOG = json.loads((Path(__file__).parent / 'assets/languages.json').read_text(encoding='utf-8'))
TARGET_LANGUAGES = tuple((row['label'], row['code']) for row in CATALOG)
TARGET_CODES = frozenset(code for _, code in TARGET_LANGUAGES)
NLLB_CODES = {row['code']: row['nllb'] for row in CATALOG}
ISO_CODES = {}
for row in CATALOG:
    if row['iso']:
        ISO_CODES.setdefault(row['iso'], row['code'])
ISO_CODES.update({'zh': 'zh-Hans', 'ar': 'ar'})
NLLB_CODES['zh'] = 'zho_Hans'


def languages_for(engine):
    return OPUS_LANGUAGES if engine == 'opus' else TARGET_LANGUAGES


def system_target(engine='opus'):
    supported = {code for _, code in languages_for(engine)}
    # uiLanguages reflects display-language preferences. name() alone reflects
    # regional formatting, which can differ (for example zh-TW UI + en-US dates).
    for name in QLocale.system().uiLanguages():
        parts = name.replace('_', '-').lower().split('-')
        if parts[0] == 'zh':
            if 'hant' in parts:
                return 'zh-Hant'
            if 'hans' in parts:
                return 'zh-Hans'
            return 'zh-Hant' if any(region in parts for region in ('tw', 'hk', 'mo')) else 'zh-Hans'
        code = ISO_CODES.get(parts[0])
        if code in supported:
            return code
        for code in supported:
            if name.lower().replace('_', '-') == code.lower() or parts[0] == code.lower():
                return code
    # Never select a language the installed translation engine cannot handle.
    return 'en'


def manual_target(settings):
    target = settings.value('target')
    # Older releases wrote target only after a language interaction. Preserve it
    # when upgrading; new automatic defaults never write a target preference.
    if settings.value('target_mode') != 'system' and target in TARGET_CODES:
        return target
    return None


def preferred_target(settings, engine='opus'):
    chosen = manual_target(settings)
    return chosen if chosen in {code for _, code in languages_for(engine)} else system_target(engine)


def save_target(settings, target):
    if target is None:
        settings.remove('target')
        settings.setValue('target_mode', 'system')
    elif target in TARGET_CODES:
        settings.setValue('target', target)
        settings.setValue('target_mode', 'manual')
    else:
        raise ValueError(f'Unsupported target language: {target}')
