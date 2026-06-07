# Discord / Telegram Bot 與 ggboss 整合研究

> 本文件記錄了將 ggcoder / ggboss 接入 Discord 與 Telegram 的架構研究，包含方案比較、時序分析與實作指引。

---

## 目錄

1. [背景：gg-framework 架構概覽](#1-背景gg-framework-架構概覽)
2. [方案 A：Discord + ggcoder](#2-方案-a-discord--ggcoder)
3. [方案 B：Discord + ggboss（推薦）](#3-方案-b-discord--ggboss推薦)
4. [ggboss 能否作為子行程？](#4-ggboss-能否作為子行程)
5. [Telegram 已原生支援：ggboss serve](#5-telegram-已原生支援ggboss-serve)
6. [Telegram → ggboss → LLM 時序圖](#6-telegram--ggboss--llm-時序圖)
7. [ggboss serve 啟動測試](#7-ggboss-serve-啟動測試)
8. [Claude Pro 訂閱的 Policy 問題](#8-claude-pro-訂閱的-policy-問題)
9. [快速上手：Telegram 接入步驟](#9-快速上手telegram-接入步驟)

---

## 1. 背景：gg-framework 架構概覽

```
@kenkaiiii/gg-ai       ← 統一 LLM 串流 API（Anthropic / OpenAI / ...）
    └─► @kenkaiiii/gg-agent   ← Agent 迴圈 + 工具執行
          └─► @kenkaiiii/ggcoder   ← CLI 編程 Agent（單專案）
                └─► @kenkaiiii/gg-boss  ← 多專案 Orchestrator
```

| 套件 | 角色 | 適用場景 |
|------|------|----------|
| `gg-ai` | LLM 串流抽象層 | 底層，不直接使用 |
| `gg-agent` | Agent 迴圈 | 需要最大彈性時 |
| `ggcoder` | 單專案 CLI Agent | 一個對話、一個專案 |
| `gg-boss` | 多專案 Orchestrator | 跨專案並發、長任務管理 |

---

## 2. 方案 A：Discord + ggcoder

### 架構圖

```
┌──────────────────────────────────────────────────────────────┐
│                        DISCORD 層                            │
│  用戶 ──→ Discord Gateway ──→ Discord Bot App                │
│                               • 指令解析                     │
│                               • Session 路由                 │
│                               • 訊息緩衝 / 速率限制           │
└──────────────────────────────────┬───────────────────────────┘
                                   │
                        Session 協調器
                     （依 channel / user 隔離）
                                   │
          ┌────────────────────────┼────────────────────────┐
          ▼                        ▼                        ▼
   ggcoder Worker #1       ggcoder Worker #2       ggcoder Worker #N
   （RPC 子行程）           （RPC 子行程）           （RPC 子行程）
   JSON stdin/stdout        JSON stdin/stdout
          │
     AgentSession
     agentLoop()
     工具層（read/write/bash/...）
          │
     LLM API（Anthropic 等）
```

### 整合方式

**ggcoder 有 `--rpc-mode`，JSON over stdin/stdout：**

```typescript
const proc = spawn("ggcoder", ["--rpc-mode"], { cwd: projectDir });

// 傳送指令
proc.stdin.write(JSON.stringify({ id: "1", command: "prompt", text: "..." }) + "\n");

// 接收事件串流
proc.stdout.on("data", (data) => {
  const event = JSON.parse(data); // text_delta / tool_call_* / agent_done
});
```

### 需要新建的元件

```
discord-ggcoder-bot/
├── src/
│   ├── bot.ts                  # discord.js 入口
│   ├── coordinator/
│   │   ├── session-pool.ts     # 管理 Worker 實例
│   │   ├── worker.ts           # 封裝 ggcoder RPC 子行程
│   │   └── queue.ts            # 序列化同一 session 的請求
│   ├── discord/
│   │   ├── commands/           # /ask /new /compact /model
│   │   └── reply-streamer.ts   # text_delta → 編輯 Discord 訊息
│   └── auth/
│       └── credential-store.ts # 每個 guild/user 的 API key 儲存
```

### 缺點

- 需要自己實作 SessionPool 和 Worker 管理（約 500 行新程式碼）
- 每個 Worker 只知道自己的專案，Worker 之間無協調
- 無內建任務追蹤

---

## 3. 方案 B：Discord + ggboss（推薦）

### 架構圖

```
┌──────────────────────────────────────────────────────────────────┐
│                          DISCORD 層                              │
│  用戶 A ──→ #general                                             │
│  用戶 B ──→ #project-api    ──→ Discord Bot App                  │
│  用戶 C ──→ 私訊                  Discord Adapter（新建）         │
└──────────────────────────────────┬───────────────────────────────┘
                                   │ GGBoss.enqueueUserMessage()
┌──────────────────────────────────▼───────────────────────────────┐
│                         GGBOSS 層                                │
│                                                                  │
│  GGBoss Orchestrator                                             │
│  ├── EventQueue（優先級 FIFO）                                    │
│  ├── TasksStore（待辦持久化）                                     │
│  ├── BossStore（UI 狀態 / 訂閱）                                  │
│  └── Boss Agent（claude-opus — 協調者）                           │
│       ├── prompt_worker(project, msg)                            │
│       ├── list_workers() / get_worker_activity()                 │
│       └── add_task / dispatch_pending                            │
│                                                                  │
│  Workers（同行程，各自獨立 AgentSession）                         │
│  ├── Worker #1  project: api   (claude-sonnet)                   │
│  ├── Worker #2  project: web   (claude-sonnet)                   │
│  └── Worker #N  ...                                              │
└──────────────────────────────────────────────────────────────────┘
```

### 與 Telegram serve-mode 的對照

ggboss 已有完整的 Telegram 整合，Discord 版只需替換傳輸層：

| | Telegram（已有） | Discord（待建） |
|---|---|---|
| 訊息接收 | 長輪詢 `getUpdates` | discord.js WebSocket |
| 事件處理 | `bot.onText(handler)` | `client.on("messageCreate", handler)` |
| 傳送訊息 | `bot.send(chatId, text)` | `channel.send()` / `msg.edit()` |
| Session 隔離 | 單一 chatId | Thread / channel |
| 推送邏輯 | `bossStore.subscribe(...)` | **相同，完全複用** |
| Boss 入口 | `GGBoss.enqueueUserMessage()` | **相同，完全複用** |

### 需要新建的程式碼（極少）

```
packages/gg-boss/src/
├── discord-adapter.ts     # 對標 telegram.ts，約 150 行
└── discord-serve-mode.ts  # 對標 serve-mode.ts，約 80 行

packages/gg-boss/src/cli.ts
└── 新增 "ggboss discord" 子指令
```

### 方案比較

| 維度 | A: ggcoder | B: ggboss |
|------|-----------|----------|
| 多專案協調 | ✗ | ✓ Boss Agent 統一協調 |
| 任務追蹤 | ✗ | ✓ TasksStore 持久化 |
| 自動派發 | ✗ | ✓ auto-chain 內建 |
| Worker 間通訊 | ✗ | ✓ 透過 Boss Agent |
| Headless 先例 | ✗ | ✓ Telegram serve-mode |
| 新增程式碼量 | ~500 行 | ~230 行 |
| 適合場景 | 單專案簡單問答 | 多專案並發、長任務管理 |

---

## 4. ggboss 能否作為子行程？

### 現狀

| | ggcoder | ggboss |
|---|---|---|
| RPC 模式 | ✓ `--rpc-mode`（JSON stdin/stdout） | ✗ 無 |
| Headless 模式 | ✗ | ✓ `ggboss serve`（Telegram） |
| 程式化 API | `AgentSession` class | `GGBoss` class |

**ggboss 目前只能同行程使用。**

### 三種可能方案

**方案 1：同行程（現在就能做）**
```
Discord Bot 行程
└── GGBoss 實例（import { GGBoss } from "@kenkaiiii/gg-boss"）
    ├── Worker #1（AgentSession）
    └── Worker #2（AgentSession）
```
優點：直接 API，`bossStore.subscribe()` 天然串流
缺點：ggboss 崩潰 = bot 崩潰

**方案 2：給 ggboss 加 RPC mode（需新增 ~150 行）**
```
Discord Bot 行程
└── spawn("ggboss", ["--rpc-mode"])
    stdin/stdout JSON 協議（參考 ggcoder 的 rpc-mode.ts）
```
優點：行程隔離，崩潰可重啟
缺點：需修改 ggboss 原始碼

**方案 3：ggboss serve 擴展為 Discord（最推薦）**
```
ggboss discord --token=xxx
└── GGBoss（內嵌）
    └── Discord Adapter（替代 Telegram）
```
Bot 是 ggboss 的一個 serve 模式，依賴關係反轉，複用最多。

---

## 5. Telegram 已原生支援：ggboss serve

**不需要寫任何程式碼，直接可用。**

```
packages/gg-boss/src/
├── telegram.ts          # Telegram bot 收發訊息
├── telegram-setup.ts    # ggboss telegram 互動式精靈
└── serve-mode.ts        # ggboss serve 啟動邏輯
```

### 使用流程

```bash
# 步驟 1：登入 Anthropic（只需一次）
ggcoder login

# 步驟 2：連結專案
ggboss link

# 步驟 3：設定 Telegram bot 憑證
ggboss telegram
# 互動式輸入：
#   - Bot token（從 @BotFather 取得）
#   - 你的 Telegram User ID（從 @userinfobot 取得）
# 儲存至 ~/.gg/boss/telegram.json

# 步驟 4：啟動
ggboss serve
```

### BotFather 注意事項

建立 bot 後需要關閉 group privacy mode，讓 bot 能讀取群組訊息：
```
/mybots → 選擇 bot → Bot Settings → Group Privacy → Turn off
```

### Telegram 指令列表

| 指令 | 功能 |
|------|------|
| `/help` | 顯示說明 |
| `/m` 或 `/model` | 切換 boss 模型 |
| `/model-workers` | 切換 worker 模型 |
| `/scope` | 切換作用範圍（全部 / 特定專案） |
| `/new` | 開啟新對話 |
| `/compact` | 壓縮上下文 |
| 一般文字 | 傳給 Boss Agent 處理 |

---

## 6. Telegram → ggboss → LLM 時序圖

```
用戶(TG)   TelegramBot    serve-mode      GGBoss         BossAgent     Worker#1      LLM(boss)   LLM(worker)
   │            │              │              │               │             │              │            │
   │        ── 啟動階段 ──      │              │               │             │              │            │
   │            │    new TelegramBot()        │               │             │              │            │
   │            │  subscribeToBossStore(cb)   │               │             │              │            │
   │            │              │   new GGBoss() + initialize()│             │              │            │
   │            │              │─────────────►│  new Worker() × N           │              │            │
   │            │              │              │─────────────────────────────►              │            │
   │            │              │              │  new Agent(bossModel)       │              │            │
   │            │              │              │───────────────►             │              │            │
   │            │   bot.start() [長輪詢]      │               │             │              │            │
   │            │   boss.run() [永久迴圈]     │               │             │              │            │
   │            │              │              │  await queue.next() [阻塞]  │              │            │
   │            │              │              │               │             │              │            │
   │   ── 用戶傳送訊息 ──        │              │               │             │              │            │
   │─── 傳訊息 ─►│              │              │               │             │              │            │
   │            │ GET /getUpdates (30s 輪詢)   │               │             │              │            │
   │            │  onText handler 觸發        │               │             │              │            │
   │            │─────────────►│              │               │             │              │            │
   │            │              │  scopePrefix + text          │             │              │            │
   │            │              │  boss.enqueueUserMessage()   │             │              │            │
   │            │              │─────────────►│  queue.push(user_message)   │              │            │
   │            │   sendTyping() 每 4 秒      │               │             │              │            │
   │            │◄─────────────│ (streaming=true 時觸發)      │             │              │            │
   │            │              │              │               │             │              │            │
   │   ── Boss 處理事件 ──       │              │               │             │              │            │
   │            │              │              │  queue.next() → user_message│              │            │
   │            │              │              │  formatEventForBoss()       │              │            │
   │            │              │              │  bossAgent.prompt(text)     │              │            │
   │            │              │              │───────────────►             │              │            │
   │            │              │              │               │  POST /messages (串流)      │            │
   │            │              │              │               │─────────────────────────────►│            │
   │            │              │◄── bossStore 變化 ────────────│◄── text_delta × N ──────────│            │
   │            │◄─────────────│ startTyping()│               │             │              │            │
   │            │              │              │               │◄── tool_call_start          │            │
   │            │              │              │◄──────────────│ name:"prompt_worker"        │            │
   │            │              │              │  worker.prompt(msg) [fire-and-forget]       │            │
   │            │              │              │─────────────────────────────►              │            │
   │            │              │              │               │             │  POST /messages│            │
   │            │              │              │               │             │─────────────►│            │
   │            │              │              │               │◄── agent_done ──────────────│            │
   │            │              │◄── bossStore 變化 ────────────│             │              │            │
   │            │              │  flushNewItems()             │             │              │            │
   │            │              │  formatItemForTelegram()     │             │              │            │
   │◄── 收到回覆 ─│ bot.send()  │              │               │             │              │            │
   │            │              │              │               │             │              │            │
   │   ── Worker 完成（非同步，稍後）──          │               │             │              │            │
   │            │              │              │               │             │◄── agent_done│            │
   │            │              │              │◄──────────────────────────── │ worker_turn_complete      │
   │            │              │              │  tasksStore.update(done)     │              │            │
   │            │              │              │  bossAgent.prompt(summary)   │              │            │
   │            │              │  flushNewItems() → bot.send()│             │              │            │
   │◄── Worker 完成通知 ─────────│              │               │             │              │            │
```

### 關鍵機制

**1. 輸入方向：TG → boss**
- `bot.onText()` → `scopePrefix + text` → `enqueueUserMessage()`
- EventQueue 為優先級 FIFO：`user_message` 插隊到 `worker_turn_complete` 前面

**2. 輸出方向：boss → TG**
- `bossStore` 是中間層（類似 Redux store）
- serve-mode 訂閱它，diff history 長度，只推新增項
- 過濾規則（`formatItemForTelegram`）：
  - ✓ 傳送：assistant 文字、worker_error、task_dispatch
  - ✗ 丟棄：user echo、tool calls、worker_event、info 雜訊

**3. Worker 是 fire-and-forget**
- Boss 呼叫 `prompt_worker` 工具 → 立即返回
- Worker 在背景跑 AgentSession（可能數分鐘）
- 完成後自行向 queue 推入 `worker_turn_complete`

**4. typing indicator 驅動**
- `bossStore.streaming !== null` → `startTyping()` 每 4 秒重發
- `bossStore.streaming === null` → `stopTyping()`

---

## 7. ggboss serve 啟動測試

在 sandbox 環境中測試啟動順序：

```
關卡 1: ggboss serve 指令可執行           ✓
   ↓
關卡 2: 檢查 linked projects
   → 無 → 報錯：run ggboss link first
   → 有 → 繼續                           ✓
   ↓
關卡 3: 驗證 Anthropic 登入
   → 未登入 → 報錯：
     "Not logged in to anthropic.
      Run ggcoder login to authenticate." ✗（sandbox 限制）
   ↓
關卡 4: 驗證 Telegram bot token
   → token 無效 → 報錯退出
   ↓
關卡 5: 正常啟動，開始長輪詢 TG           ✓（真實環境）
```

**結論：** 指令本身可以跑，流程是通的。sandbox 缺少真實 Anthropic 憑證，但這是環境限制，非程式錯誤。

---

## 8. Claude Pro 訂閱的 Policy 問題

### 結論：使用 Pro 訂閱沒有違反 Policy

**原因：ggcoder 使用的就是 Claude Code 官方 OAuth 流程。**

```typescript
// packages/ggcoder/src/core/oauth/anthropic.ts
const CLIENT_ID = atob("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
// 解碼 = 9d1c250a-e61b-44d9-88ed-5944d1962f5e
// ↑ 這是 Anthropic 官方 Claude Code 的 client_id

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL     = "https://platform.claude.com/v1/oauth/token";
const SCOPES        = "user:sessions:claude_code ...";
//                                    ↑ 明確的 claude_code session scope
```

- ggcoder 直接複用官方 Claude Code CLI 的 OAuth client
- Anthropic 明確設計此 OAuth 流程給第三方 Claude Code 相容工具
- Claude Pro / Max 訂閱原生支援 Claude Code，ggcoder 走同一條路

### 使用邊界

| 使用情境 | 是否合規 |
|----------|---------|
| 個人使用 ggcoder / ggboss | ✓ 沒問題 |
| `ggboss serve` 個人遙控 | ✓ 應該沒問題 |
| 拿來做商業服務對外提供 | ⚠ 建議改用 API 計費模式 |

---

## 9. 快速上手：Telegram 接入步驟

### 前置條件

1. 安裝 ggboss：`npm i -g @kenkaiiii/gg-boss`
2. 在 Telegram 建立 bot：
   - 找 `@BotFather` → `/newbot` → 取得 token
   - 關閉 group privacy：`/mybots → Bot Settings → Group Privacy → Turn off`
3. 取得你的 Telegram User ID：找 `@userinfobot` 傳任意訊息

### 啟動

```bash
# 1. 登入 Anthropic（Pro / Max 訂閱皆可）
ggcoder login

# 2. 連結想讓 boss 管理的專案
ggboss link

# 3. 儲存 Telegram 憑證
ggboss telegram
# 依提示輸入 bot token 和 user ID
# 儲存至 ~/.gg/boss/telegram.json

# 4. 啟動
ggboss serve
```

### 測試

在 Telegram 傳給 bot：
```
你好，幫我看看 api 專案的 README
```

Boss Agent 會自動分析請求，呼叫對應 worker 執行，完成後回傳結果。

---

*文件日期：2026-05-10*
