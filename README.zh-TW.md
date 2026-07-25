# MCP Nexus Node.js 版

[English](README.md) | [繁體中文](README.zh-TW.md)

MCP Nexus 是可自行託管的 Model Context Protocol（MCP）Gateway 與 AI 研究控制平台。它能連接遠端 Streamable HTTP MCP 伺服器、提供聚合或單一上游的工具端點，並透過瀏覽器控制台執行有界的 OpenAI 相容 Agent 工作流程。

原有的 stdio 搜尋伺服器仍保留為獨立進入點。本 repository 是獨立的 Node.js 實作；Python 專案有各自的執行環境與發布週期。

> **專案狀態：** 可運作的單行程 MVP，適合本機、私人網路及受控的自行託管環境。目前尚未實作 OAuth、多實例狀態協調及強化後的公開多租戶部署。

## 目錄

- [主要功能](#主要功能)
- [架構](#架構)
- [環境需求](#環境需求)
- [快速開始](#快速開始)
- [使用 MCP Nexus](#使用-mcp-nexus)
- [環境設定](#環境設定)
- [Pterodactyl 部署](#pterodactyl-部署)
- [安全模型](#安全模型)
- [開發](#開發)
- [專案結構](#專案結構)
- [目前限制](#目前限制)
- [參與貢獻](#參與貢獻)
- [回報安全問題](#回報安全問題)
- [授權](#授權)

## 主要功能

- 第一次啟動時建立唯一管理員，完成後關閉註冊入口。
- 可自訂登入路徑，以及可保存、可刷新的 `/<uuid>/web` 控制台路徑。
- 支援高精度、固定並發及自訂並發的 OpenAI 相容 Agent 調度。
- 僅供研究 Agent 使用、具嚴格網路與資源限制的 `curl` 與 `searxng_search` Function Tools。
- 支援使用者自架 SearXNG，並可選 Google、Bing、DuckDuckGo、Startpage 或 SearXNG 預設聚合。
- 遠端 Streamable HTTP MCP 伺服器與自訂 Header／URL Query 認證。
- 以 `<alias>.<tool>` 聚合工具的 `/mcp`，以及單一上游轉出的 `/mcp/<alias>`。
- 最多 20 組具名稱的 Gateway Token、個別統計與有界請求紀錄。
- 適用 128 MB 容器的低記憶體防護。
- 支援響應式版面與 reduced-motion 的黑色／青藍色控制台。

## 架構

```text
瀏覽器
  -> Express 控制平面
     -> 行程內已驗證狀態快照
     -> 原子 JSON 持久化
     -> OpenAI 相容 Agent 調度器
        -> 僅研究 Agent：有界 curl / SearXNG tools

MCP Client
  -> /mcp 或 /mcp/<alias>
     -> Gateway Token 驗證
     -> 有界 MCP session registry
     -> 遠端 Streamable HTTP MCP 伺服器

stdio MCP Client
  -> dist/server.js
     -> 記憶體文件搜尋服務
```

Web Gateway 目前聚合 MCP **tools**。Agent 的網路工具與已設定的遠端 MCP 工具是不同的安全邊界：規劃、審核、彙整 Agent 不會取得網路工具，任何 Agent 都不會取得遠端 MCP 工具。

## 環境需求

- Node.js 20 或更新版本
- 與已安裝 Node.js 相容的 npm
- Web 啟動器需要已填寫的 `.env`
- 選用：支援 OpenAI Chat Completions 的相容供應商
- 選用：在 `search.formats` 啟用 `json` 的自架 SearXNG

## 快速開始

### 1. 建立環境設定檔

Linux 或 macOS：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

啟動前請編輯 `.env`，至少檢查 `WEB_LOGIN_PATH` 與監聽位址設定。

### 2. 安裝並驗證

```bash
npm ci
npm run check
```

### 3. 啟動 Web 控制台

```bash
node start.js
```

`start.js` 會優先使用既有的編譯進入點。若缺少 `dist/web-server.js`，它會安裝開發相依套件並建置；若仍失敗，最後會嘗試透過專案內的 `tsx` loader 執行原始碼。

開啟設定的登入網址，例如：

```text
http://127.0.0.1:3000/yoyo/s12ryt/login
```

建立唯一管理員。第一組 Gateway Token 只顯示一次，請立即妥善保存。登入後瀏覽器會重新導向至持久化的 `/<uuid>/web` 路徑。

## 使用 MCP Nexus

### Web 控制台

控制台包含：

- **AI 搜尋：** 執行 Agent 工作流程，顯示階段、usage 與 SearXNG 證據。
- **搜尋調度：** 設定 Agent 模式、並發數、歷史上限、輸出 Token、取樣、角色 Prompt 與 SearXNG。
- **MCP 伺服器：** 管理遠端 MCP 網址、認證參數、連線測試與轉出網址。
- **Gateway Token：** 建立及撤銷具名稱的 Token，並顯示末五碼識別與統計。
- **請求紀錄：** 顯示最新 200 筆已驗證 MCP HTTP 請求，不保存請求參數或完整 Token。
- **設定：** 設定 OpenAI 相容供應商及刷新私人 Web UUID。

### HTTP MCP Gateway

使用 Gateway Token 作為 Bearer 憑證：

```http
Authorization: Bearer <gateway-token>
```

可用的 Streamable HTTP 端點：

- `POST /mcp`：以 `<alias>.<tool>` 提供所有已啟用上游的工具。
- `POST /mcp/<alias>`：提供單一上游並保留原始工具名稱。

Client 必須先完成 MCP initialization，才能送出後續 session 請求。MCP session ID、request ID、上游憑證與下游 Gateway Token 彼此獨立。

### stdio MCP 伺服器

先建置，再直接執行產物，避免 npm lifecycle 訊息進入協定 stdout：

```bash
npm run build
node dist/server.js
```

Client 設定範例：

```json
{
  "mcpServers": {
    "focused-search-node": {
      "command": "node",
      "args": ["/absolute/path/to/nodejs/dist/server.js"]
    }
  }
}
```

stdio 伺服器提供唯讀的 `search_index` 與 `get_document`，底層為記憶體 repository。

### Agent 搜尋調度

- **高精度：** 規劃 -> 搜尋／分析 -> 審核 -> 彙整。
- **固定並發：** 5 個搜尋／分析 Agent -> 1 個彙整 Agent。
- **自訂並發：** 1 至 8 個搜尋／分析 Agent -> 1 個彙整 Agent。

歷史內容上限控制送入後續 Agent 的既有階段輸出字元數，不會修改供應商模型的 Context Window。每次 completion 的 `max_tokens` 限制為 128 至 4096，且只會傳送使用者選擇的 `temperature` 或 `top_p`。

只有搜尋／分析 Agent 能選擇使用以下工具：

- `searxng_search`：沿用管理員保存的服務網址、來源、結果數、語言及 SafeSearch。
- `curl`：接受 HTTP(S) URL、方法、request headers 及選用 body，不會執行 shell。

每個搜尋／分析 Agent 最多執行 3 輪工具、6 次工具呼叫，每輪最多 4 次；整筆搜尋共用 12 次上限。工具操作會序列化；輪次耗盡後，供應商會收到 `tool_choice: "none"` 的最終請求。

### 自架 SearXNG

SearXNG 必須啟用 JSON 回應：

```yaml
search:
  formats:
    - html
    - json
```

Google、Bing、DuckDuckGo 與 Startpage 會設定對應的 SearXNG `engines`。選擇 SearXNG 時不傳 `engines`，使用實例已啟用的預設聚合。

單一模式必須選擇一個來源；並行模式最多可選五個來源，同時最多執行兩路 HTTP 搜尋。每個來源最多保留 10 筆結果。網址會正規化並去重；單一來源失敗不會丟棄其他成功來源。

### 遠端 MCP 認證

每台遠端伺服器最多支援 20 組認證參數，秘密總長度最多 32,000 字元：

- **HTTP Header：** 建議用於 `Authorization`、`X-API-Key` 等憑證。
- **URL Query：** 僅在上游明確要求時使用，因為中介代理或紀錄可能保存 URL。

設定 API 只回傳參數位置與名稱，秘密值只存在伺服器端狀態。系統會拒絕重複、格式錯誤、帶控制字元、由 transport 管理或不安全的 Header 名稱。

## 環境設定

| 變數 | 預設值 | 說明 |
|---|---:|---|
| `HOST` | `127.0.0.1` | Web 監聽位址 |
| `PORT` | `3000` | Web 監聽連接埠 |
| `MCP_NEXUS_DATA` | `data/state.json` | JSON 狀態路徑；相對路徑以專案根目錄為基準 |
| `WEB_LOGIN_PATH` | `/login` | 登入頁與驗證 API 的完整前綴 |
| `ALLOW_PRIVATE_UPSTREAMS` | 未設定 | 只在可信任的本機開發環境設為 `true` |
| `MCP_MAX_SESSIONS` | `8` | 保留的 MCP sessions；允許範圍 1-64 |
| `MCP_SESSION_IDLE_MS` | `900000` | 閒置逾時；允許範圍 30000-86400000 毫秒 |
| `MCP_MAX_TOOLS` | `256` | 上游工具收集上限；允許範圍 1-2048 |
| `MCP_MAX_AI_RESPONSE_BYTES` | `1048576` | OpenAI 相容回應上限；允許範圍 16384-8388608 bytes |

Shell 與面板環境變數的優先序高於 `.env`。無論呼叫端目前目錄為何，Web 進入點都從專案根目錄載入 `.env`。`WEB_LOGIN_PATH` 不可使用保留的 API、MCP 或靜態資產前綴。

JSON 狀態在每個行程中只會解析及驗證一次，之後保留為內部快照。每次更新仍會驗證 schema，並在快照變更前原子替換檔案。手動修改檔案不會熱載入，需重啟服務才會生效。

## Pterodactyl 部署

使用 Node.js 20 或更新版本的 Generic Node egg。

128 MB 容器建議啟動指令：

```bash
node --max-old-space-size=48 --max-semi-space-size=2 start.js
```

- 將填寫完成的 `.env` 放在 `start.js` 旁。
- `SERVER_PORT` 會映射至 `PORT`。
- 在偵測到的面板環境中，未明確指定 `HOST` 時預設監聽 `0.0.0.0`。
- 啟動完成文字使用 `MCP Nexus login available at`。
- 停止指令使用 `^C`，讓 Wings 傳送 `SIGINT`。
- 不要把 `NODE_OPTIONS` 放進 `.env`；V8 heap 參數必須在 Node.js 啟動前提供。

## 安全模型

- 預設只監聽 loopback，本機監聽器會驗證 Host。
- 瀏覽器 session 使用 HttpOnly、SameSite=Strict Cookie，登入後寫入操作需通過 CSRF 驗證。
- 管理員密碼使用 scrypt；Gateway Token 只保存 SHA-256 指紋。
- Gateway Token 全文只顯示一次，持久資料只保留末五碼供識別。
- 對外請求預設只允許 HTTPS，拒絕 URL credentials 與 redirect，並對 Agent `curl` 套用 SSRF 檢查及 DNS 位址釘選。
- Session、請求紀錄、工具目錄、回應、Prompt、Agent 歷史、工具輪次、Header 與 request body 均有上限。
- AI Provider、上游 MCP、Cookie 與 Gateway 秘密不會注入 Agent tools。
- Agent Prompt 將標題、摘要、網址及直接 HTTP 回應視為不可信證據。

`ALLOW_PRIVATE_UPSTREAMS=true` 會同時放寬上游 MCP、SearXNG 與 Agent HTTP 的 HTTP／私人網路限制，只能用於可信任的開發環境。

若沒有 TLS、反向代理防護與明確網路政策，請勿直接公開服務。自訂登入路徑與 Web UUID 只能降低意外發現機率，不能取代身分驗證。

## 開發

| 指令 | 用途 |
|---|---|
| `npm run dev` | 執行 TypeScript stdio 伺服器 |
| `npm run dev:web` | 執行 TypeScript Web 服務 |
| `npm run build` | 將 TypeScript 編譯至 `dist/` |
| `npm run lint` | 執行 ESLint |
| `npm run typecheck` | 執行 strict TypeScript 檢查但不輸出檔案 |
| `npm test` | 執行一次 Vitest |
| `npm run check` | 依序執行 lint、typecheck、build 與 test |
| `npm run start:web` | 執行正式環境啟動器 |

送出變更前執行：

```bash
npm ci
npm run check
npm audit --omit=dev
```

## 專案結構

```text
src/                 TypeScript 服務、安全政策、MCP adapters 與進入點
public/              零建置瀏覽器控制台
tests/               單元及整合測試
docs/                歷史架構決策與 roadmap
.github/              CI、Issue forms、相依更新及 PR template
start.js             Pterodactyl 相容正式環境啟動器
.env.example         Web 環境設定範本
CONTRIBUTING.md      貢獻流程
SECURITY.md          弱點回報政策
LICENSE              AGPL-3.0-or-later 授權全文
```

`docs/` 部分內容描述早期 stdio scaffold，可能落後於目前 Web Gateway。在這些文件完成更新前，本 README 是執行環境現況的主要依據。

## 目前限制

- 單行程加單一 JSON 狀態檔；多個實例不可同時寫入同一檔案。
- 尚無 OAuth provider 或公開多租戶 authorization server。
- MCP Gateway 採 tools-first；尚未聚合 prompts 與 resources。
- AI completion 不支援串流。
- 外部直接修改狀態檔後需重啟。
- stdio 文件搜尋 repository 位於記憶體，不會爬取或持久保存文件。
- 本 repository 尚未實作 Python 控制平面。

## 參與貢獻

歡迎提供貢獻。請先閱讀 [CONTRIBUTING.md](CONTRIBUTING.md)，保持變更範圍聚焦，為行為變更加上測試，並在送出 Pull Request 前執行 `npm run check`。

提交貢獻即表示你同意以本專案相同的 `AGPL-3.0-or-later` 授權發布貢獻內容。

## 回報安全問題

請勿透過公開 Issue 回報安全弱點。請依照 [SECURITY.md](SECURITY.md)，並在公開遠端啟用後使用 private vulnerability reporting。

## 授權

本專案採用 [GNU Affero General Public License v3.0 或更新版本](LICENSE)。依照授權要求，修改後透過網路提供服務時，必須提供對應原始碼。
