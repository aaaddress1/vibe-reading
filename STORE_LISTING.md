# Chrome Web Store 上架文案（直接複製貼上）

## 名稱 (Name)
氛圍閱讀 Vibe Reading — 離線 PDF 翻譯

## 簡短說明 (Summary，≤132 字元)
用 Chrome 內建 Gemini Nano AI 將 PDF 論文逐段翻成中文。完全離線、零 API Key。點翻譯定位原文、AI 摘要、反白問答。

## 類別 (Category)
生產力 (Productivity)

## 詳細說明 (Description)
🔓 本專案完全開源（MIT 授權），原始碼公開於 GitHub：
https://github.com/aaaddress1/vibe-reading
歡迎查看程式碼、回報問題或貢獻。

氛圍閱讀 Vibe Reading 是一款完全離線的 PDF 翻譯擴充功能，使用 Chrome 內建的地端 AI（Gemini Nano / Translator API），把整份 PDF 論文逐段翻成繁體中文。所有 AI 推理都在你自己的電腦上完成——論文內容不會送到任何雲端，沒有 API Key、沒有費用、沒有速率限制。

主要功能：
• 逐段翻譯：左側渲染原始 PDF、右側對照翻譯
• 雙向定位：點翻譯 → 論文捲動並高亮原文；點原文 → 翻譯高亮
• AI 摘要：讀完整份論文後，以 Gemini Nano 生成背景知識、相關研究、突破亮點、總結
• 反白問 AI：在論文中反白文字直接向 Gemini Nano 提問，並附上摘要與前後文作為上下文
• 自動偵測來源語言，你只需選擇翻譯目標語言（預設為瀏覽器語言）
• Alt+T 熱鍵 / 右鍵選單 / 工具列圖示，一鍵開啟
• 左側 PDF 獨立平滑縮放、方向鍵翻頁、雙欄論文支援、暗黑主題

系統需求：
• Chrome 138 以上（Windows 10/11、macOS 13+、Linux、Chromebook Plus）
• 首次使用需於 chrome://flags 啟用 Prompt API 與 Translator API，並於 chrome://components 下載地端模型
• 不支援 Android / iOS，亦不支援 Edge 等其他瀏覽器（內建 AI 為 Chrome 專屬）

開放原始碼：https://github.com/aaaddress1/vibe-reading

## 權限用途說明（審查用）
• host_permissions `<all_urls>`：需要讀取使用者所開啟的任意 PDF 網址（例如 arxiv.org、各期刊、本機 file:// PDF）以擷取內容進行翻譯。不會蒐集或傳送任何資料到外部伺服器。
• tabs：取得目前分頁的 PDF 網址以開啟翻譯檢視器（含 Alt+T 熱鍵與右鍵選單）。
• contextMenus：提供「翻譯整份 PDF」右鍵選單。
• storage：記住使用者偏好（目標語言、字體大小）。
• activeTab：搭配使用者操作開啟翻譯。

## 隱私權實務 (Privacy practices)
• 不蒐集任何使用者資料。所有處理皆在本機完成，無任何外部傳輸。
• 單一用途：將 PDF 內容翻譯成使用者選擇的語言並輔助閱讀。

────────────────────────────────────────
## 「隱私權實務規範」分頁 — 逐欄填寫（直接複製）

【單一用途說明 Single purpose】
氛圍閱讀是一款 PDF 翻譯與閱讀輔助工具：使用 Chrome 內建的地端 AI，將使用者開啟的 PDF 文件逐段翻譯成所選語言，並提供 AI 摘要與選取問答以協助閱讀。

【activeTab 權限理由】
當使用者點擊工具列圖示或按下 Alt+T 熱鍵時，用來在使用者操作的當下取得目前作用中分頁的 PDF 網址，以開啟翻譯檢視器。

【contextMenus 權限理由】
在 PDF 分頁提供「翻譯整份 PDF」右鍵選單，讓使用者一鍵啟動翻譯。

【storage 權限理由】
在本機儲存使用者偏好設定（翻譯目標語言、翻譯字體大小）。不含個人資料，也不會上傳到任何伺服器。

【tabs 權限理由】
讀取目前分頁的網址以判斷是否為 PDF，並將該 PDF 網址傳給翻譯檢視器分頁。用於工具列圖示、Alt+T 熱鍵與右鍵選單開啟翻譯。

【網站存取權理由 host permissions（<all_urls>）】
需要讀取使用者所開啟的任意 PDF 網址（例如 arxiv.org、各學術期刊網站，以及本機 file:// PDF），以擷取 PDF 內容進行翻譯與顯示。本擴充僅於使用者主動開啟翻譯時讀取該 PDF，不會蒐集或外傳任何資料。

【遠端程式碼 Remote code】→ 請選「否，未使用遠端程式碼」
本擴充未使用任何遠端程式碼。所有函式庫（PDF.js）皆已封裝於擴充功能套件內（lib/ 目錄），不從遠端載入或執行程式碼；AI 功能使用 Chrome 瀏覽器內建 API，亦非遠端程式碼。
（若表單仍要求文字理由，貼上上面這段即可。）

## 截圖建議（需 1280×800 或 640×400，至少 1 張）
1. 雙欄檢視器：左側 PDF + 右側翻譯（含頂部 AI 摘要卡）
2. 反白問 AI 的浮動面板
3. 點翻譯 → 原文高亮定位
擷取方式：開啟檢視器後用系統截圖，再用小畫家/線上工具裁切或加邊框到 1280×800。
