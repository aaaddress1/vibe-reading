# Vibe Reading Desktop v1.0

**Select text and quickly press Ctrl+C twice to translate.** Works in readers, browsers, and other apps that allow text copying. Content stays on your computer.

[繁體中文](README.md) · **English**

## Get started

Download the Windows **.msi installer** from [GitHub Releases](https://github.com/aaaddress1/vibe-reading/releases), double-click to install, then launch from your desktop or Start menu. Uninstall through Windows Installed apps.

The selected model loads in the background at startup. Look for the model-ready status. Models require an initial internet download, then work offline.

## Controls

| Action | Result |
| --- | --- |
| Press Ctrl+C twice quickly | Translate the selection and bring the interface forward |
| ⚙ | Choose a model, language, or popup/two-column mode |
| Ctrl+Enter | Translate pasted text in the full window |
| Esc / close window | Hide the window; keep running in the system tray |
| System tray → Quit | Exit the app |

Only one translation window appears at a time. Switching retains the text and remembers your mode. The popup hides when it loses focus.

## Models

| Model | Languages and download |
| --- | --- |
| NLLB 1.3B (default, quality first) | About 200 languages/scripts, 1.4GB |
| NLLB 600M (balanced) | About 200 languages/scripts, 650MB |
| Opus-MT (lightweight) | English ↔ Chinese, 120MB per direction |

Switching models starts background loading. NLLB weights are for non-commercial use; see [THIRD_PARTY.md](THIRD_PARTY.md).

[Report an issue](https://github.com/aaaddress1/vibe-reading/issues) · [Buy the author a coffee](https://buymeacoffee.com/aaaddress1)
