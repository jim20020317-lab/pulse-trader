# PULSE TRADER｜短線交易實驗室

用正態隨機行情練習 Long / Short 的互動網頁，所有畫面與邏輯均包含於 **index.html**。不需要安裝套件、連線交易所或啟動後端，直接用瀏覽器開啟即可。

## 操作

1. 開啟 `index.html`，選擇 1s 或 1m K 線。兩個週期使用相同的模擬行情。
2. 觀察 MA5、MA10 與下方 Z-score 20。最下方為本局 PnL 曲線。
3. 設定開倉大小、止盈、止損，按 LONG 或 SHORT。倉位留白為 10%；風險欄位留白即不啟用。
4. 一次只能持有一倉；按「平倉」退出，或等待止盈／止損觸發。
5. 可暫停、每次推進一秒、選擇 1×／10×／60× 速度，或匯出交易 CSV。

初始資金為 10,000 USDT，無槓桿、手續費或滑價。每秒對數報酬使用 Box–Muller 常態亂數，預設 σ = 0.06%。種子在重新開始後套用；同種子、同波動設定與相同操作時點可重播。本局資料僅存在記憶體，重新整理頁面就會重置。

快捷鍵：空白鍵暫停／繼續，L 做多，S 做空，X 平倉。輸入欄位有焦點時不觸發快捷鍵。

## GitHub Pages 發布

1. 在 GitHub 建立一個公開儲存庫，例如 `pulse-trader`。
2. 將 **index.html** 上傳到儲存庫根目錄的 `main` 分支；只需要這一個檔案就能執行作品。
3. 開啟儲存庫 **Settings → Pages → Build and deployment**。
4. Source 選 **Deploy from a branch**，Branch 選 **main**，資料夾選 **/ (root)**，按 Save。
5. 等待 Pages 部署成功，在 Pages 頁面按 **Visit site**，實際開啟後再複製網址繳交。

依 [GitHub Pages 官方文件](https://docs.github.com/en/pages/getting-started-with-github-pages/creating-a-github-pages-site)，入口檔案須位於發布來源根目錄。此專案為單純靜態 HTML。

## 作業交付

- `index.html`：完整作品，CSS、JavaScript 與 SVG 均內嵌。
- `SPEC.md`：完整規格書。
- `SUBMISSION.md`：可貼到作業文字區的內容，請補上姓名等個資及部署完成後的網址。
- `screenshot-desktop.png`、`screenshot-mobile.png`：實際瀏覽器畫面，含模擬交易範例。
- `engine-tests.cjs`：可使用 Node.js 執行的內嵌引擎驗證；網站本身不依賴此檔案。

驗證：`node engine-tests.cjs` 檢查 HTML 內嵌引擎的交易、K 線聚合與指標運算，共 12 組檢查。介面另經本機 Playwright 檢查開平倉、CSV、離線運作及手機版；截圖由實際瀏覽器擷取。

本作品使用虛構行情與資金，僅供操作與學習。
