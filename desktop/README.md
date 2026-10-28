# 氛圍閱讀 Desktop v1.0

**選取文字，快速按兩次 Ctrl+C，即可翻譯。** 閱讀器、瀏覽器或其他可複製文字的程式都能使用，內容在自己的電腦處理。

**繁體中文** · [English](README.en.md)

## 開始使用

從 [GitHub Releases](https://github.com/aaaddress1/vibe-reading/releases) 下載 Windows **.msi 安裝程式**，雙擊安裝後從桌面或開始功能表開啟。可在 Windows「已安裝的應用程式」解除安裝。

程式啟動即在背景掛載所選模型，完成後顯示「模型已掛載 · 準備就緒」。首次使用模型需連網下載，之後可離線翻譯。

## 常用操作

| 操作 | 功能 |
| --- | --- |
| 快速按兩次 Ctrl+C | 翻譯選取文字，主動叫出介面 |
| ⚙ | 切換模型、語言及懸浮框／雙欄模式 |
| Ctrl+Enter | 翻譯雙欄中貼上的文字 |
| Esc／關閉視窗 | 收起至系統匣，程式繼續執行 |
| 系統匣選單 → 結束 | 完整退出程式 |

懸浮框與雙欄只會出現一個，切換會保留內容並記住模式。懸浮框失去焦點自動收起。

## 模型選擇

| 模型 | 語言與下載量 |
| --- | --- |
| NLLB 1.3B（預設，品質優先） | 約 200 種語言／文字，約 1.4GB |
| NLLB 600M（多語均衡） | 約 200 種語言／文字，約 650MB |
| Opus-MT（輕量快速） | 英文 ↔ 中文，每個方向約 120MB |

切換後自動掛載模型。NLLB 為非商用授權，詳見 [THIRD_PARTY.md](THIRD_PARTY.md)。

[回報問題](https://github.com/aaaddress1/vibe-reading/issues) · [請作者喝杯咖啡](https://buymeacoffee.com/aaaddress1)
