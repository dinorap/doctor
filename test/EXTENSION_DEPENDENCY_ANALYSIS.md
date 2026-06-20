# Chrome Extension Dependency Analysis

## Tổng quan

Báo cáo phân tích chi tiết về Chrome Extension trong FlowKit để tách thành dự án độc lập.

---

## 1. Kiến trúc hiện tại

### 1.1 Cấu trúc file Extension

```
extension/
├── manifest.json          [CORE] - Extension manifest
├── background.js          [CORE] - Service worker, WebSocket client
├── content.js             [CORE] - Content script bridge
├── injected.js            [CORE] - Injected script (MAIN world)
├── side_panel.html        [UI] - Side panel UI
├── side_panel.js          [UI] - Side panel logic + chat
├── popup.html             [HELPER] - Redirect to side panel
├── rules.json             [CORE] - declarativeNetRequest rules
└── _metadata/             [AUTO-GENERATED] - Chrome metadata
```

---

## 2. File Analysis

### 2.1 Files BẮT BUỘC phải giữ

#### **manifest.json** ✅ CORE
- Định nghĩa extension: permissions, host_permissions, scripts
- **Dependencies:** NONE (standalone)
- **Cần giữ:** 100%

#### **background.js** ✅ CORE (759 dòng)
- WebSocket client kết nối agent (ws://127.0.0.1:9222)
- Token capture từ headers
- API proxy (gọi Flow API từ browser context)
- reCAPTCHA solver
- HTTP callback endpoint
- Telemetry generator
- **Dependencies:** 
  - Agent WebSocket server (agent/main.py line 67-71)
  - Agent HTTP callback (agent/main.py line 147-169)
- **Cần giữ:** 100% nếu muốn kết nối với backend

#### **content.js** ✅ CORE (49 dòng)
- Bridge giữa background.js và injected.js
- Message passing
- TRPC media URL monitor
- **Dependencies:** NONE
- **Cần giữ:** 100%

#### **injected.js** ✅ CORE (63 dòng)
- Access window.grecaptcha trong MAIN world
- Solve reCAPTCHA
- Intercept TRPC fetch responses
- **Dependencies:** NONE
- **Cần giữ:** 100%

#### **rules.json** ✅ CORE
- declarativeNetRequest: inject Referer + Origin headers
- Bypass CORS cho aisandbox-pa.googleapis.com
- **Dependencies:** NONE
- **Cần giữ:** 100%

### 2.2 Files có thể BỎ hoặc TÙY CHỌN

#### **side_panel.html + side_panel.js** ⚠️ UI ONLY
- Side panel UI: hiển thị status, metrics, request log
- **Chat interface** - gọi agent API (http://127.0.0.1:8100/api/chat)
- **Dependencies:**
  - Agent API endpoints: `/api/chat`, `/api/models/chat`, `/api/skills`
  - Dashboard WebSocket: `/ws/dashboard` (agent/main.py line 185-232)
- **Có thể bỏ:** Có - extension vẫn hoạt động mà không cần UI
- **Giữ nếu:** Muốn UI monitoring + chat assistant

#### **popup.html** ⚠️ HELPER
- Chỉ redirect sang side_panel.html
- **Có thể bỏ:** Có - không ảnh hưởng core logic

---

## 3. Backend Dependencies

### 3.1 Agent WebSocket Server (BẮT BUỘC)

**File:** `agent/main.py` lines 42-71

```python
async def ws_handler(websocket):
    """Handle Chrome extension WebSocket connection."""
    client = get_flow_client()
    client.set_extension(websocket)
    
    # Send callback secret
    await websocket.send(json.dumps({"type": "callback_secret", "secret": _CALLBACK_SECRET}))
    
    async for raw in websocket:
        data = json.loads(raw)
        await client.handle_message(data)
```

**Chức năng:**
- Nhận kết nối WebSocket từ extension
- Gửi API requests tới extension
- Nhận responses từ extension

**Địa chỉ:** `ws://127.0.0.1:9222` (config: WS_HOST, WS_PORT)

### 3.2 Agent HTTP Callback Endpoint (BẮT BUỘC)

**File:** `agent/main.py` lines 147-169

```python
@app.post("/api/ext/callback")
async def ext_callback(request: Request):
    """HTTP callback for extension to deliver API responses."""
```

**Chức năng:**
- Extension POST API responses qua HTTP thay vì WebSocket
- Immune to WS disconnect
- Requires callback secret authentication

**Địa chỉ:** `http://127.0.0.1:8100/api/ext/callback`

### 3.3 FlowClient Service (BẮT BUỘC)

**File:** `agent/services/flow_client.py`

**Core Methods:**
- `set_extension(ws)` - Register extension WebSocket
- `handle_message(data)` - Process messages from extension
- `_send(method, params)` - Send requests to extension
- API wrappers: `generate_images()`, `generate_video()`, `upload_image()`, etc.

### 3.4 Dashboard WebSocket (TÙY CHỌN - UI only)

**File:** `agent/main.py` lines 185-232

```python
@app.websocket("/ws/dashboard")
async def dashboard_ws(websocket: WebSocket):
```

**Chức năng:**
- Real-time updates cho side panel UI
- Broadcast events từ event_bus

**Có thể bỏ:** Có - chỉ cần nếu giữ side_panel

---

## 4. Communication Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        CHROME EXTENSION                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐   │
│  │   injected   │────▶│   content    │────▶│  background  │   │
│  │     .js      │     │     .js      │     │     .js      │   │
│  └──────────────┘     └──────────────┘     └──────────────┘   │
│        │                    │                      │           │
│        │                    │                      │           │
│   window.grecaptcha    CustomEvent           WebSocket        │
│   TRPC intercept       messaging             Client           │
│                                                   │            │
└───────────────────────────────────────────────────┼────────────┘
                                                    │
                    ┌───────────────────────────────┼─────────────────┐
                    │                               │                 │
                    │                    ┌──────────▼─────────┐       │
                    │                    │  WebSocket Server  │       │
                    │                    │  ws://127.0.0.1    │       │
                    │                    │     :9222          │       │
                    │                    └──────────┬─────────┘       │
                    │                               │                 │
            ┌───────▼────────┐              ┌──────▼─────────┐       │
            │  HTTP Callback │              │  FlowClient    │       │
            │  POST /api/ext │              │   Service      │       │
            │    /callback   │◀─────────────│                │       │
            └────────────────┘              └────────────────┘       │
                    │                                                 │
                    │           AGENT BACKEND                         │
                    │        (Python FastAPI)                         │
                    │                                                 │
                    └─────────────────────────────────────────────────┘
                                      │
                                      │
                    ┌─────────────────▼──────────────────┐
                    │                                    │
                    │      GOOGLE FLOW API               │
                    │  https://aisandbox-pa.googleapis   │
                    │         .com                       │
                    │                                    │
                    │  • Bearer token (captured)         │
                    │  • reCAPTCHA token (solved)        │
                    │  • Browser context (cookies)       │
                    │                                    │
                    └────────────────────────────────────┘
```

---

## 5. Key Logic Components

### 5.1 WebSocket Communication

**Extension → Agent (background.js → agent/main.py)**
```javascript
// Extension connects
ws = new WebSocket('ws://127.0.0.1:9222');

// Extension sends messages
ws.send(JSON.stringify({
  type: 'token_captured',
  flowKey: 'ya29.xxx...'
}));
```

**Agent → Extension (agent/services/flow_client.py → background.js)**
```python
# Agent sends request
await self._extension_ws.send(json.dumps({
    "id": req_id,
    "method": "api_request",
    "params": {
        "url": "https://aisandbox-pa.googleapis.com/...",
        "body": {...},
        "captchaAction": "VIDEO_GENERATION"
    }
}))
```

### 5.2 Token Capture Logic

**Location:** `background.js` lines 96-121

```javascript
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization'
    );
    const token = authHeader?.value.replace(/^Bearer\s+/i, '').trim();
    
    if (token.startsWith('ya29.')) {
      flowKey = token;
      metrics.tokenCapturedAt = Date.now();
      chrome.storage.local.set({ flowKey, metrics });
      
      // Notify agent
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'token_captured', flowKey }));
      }
    }
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*'] },
  ['requestHeaders', 'extraHeaders']
);
```

**Auto-refresh:** Every 45 minutes (line 190)

### 5.3 reCAPTCHA Solver

**Flow:**
1. Agent requests captcha via WebSocket
2. Background.js finds Flow tab (or opens one)
3. Content.js dispatches CustomEvent to page
4. Injected.js calls `window.grecaptcha.enterprise.execute()`
5. Token returned via CustomEvent → Content → Background → Agent

**Files:**
- `background.js` lines 280-361 (`solveCaptcha`, `handleSolveCaptcha`)
- `content.js` lines 12-37
- `injected.js` lines 35-62

### 5.4 API Request Proxy

**Location:** `background.js` lines 407-523

**Process:**
1. Agent sends `api_request` via WebSocket
2. Background.js:
   - Solves captcha if needed
   - Injects captcha token into request body
   - Adds Bearer token (flowKey) to headers
   - Executes `fetch()` in browser context
3. Response sent back via HTTP callback or WebSocket

**Key:** Browser context bypasses CORS, maintains cookies, uses residential IP

### 5.5 Request/Response Bridge

**Two delivery methods:**

1. **HTTP Callback (preferred)** - `background.js` lines 261-278
```javascript
fetch('http://127.0.0.1:8100/api/ext/callback', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id, status, data })
})
```

2. **WebSocket (fallback)**
```javascript
ws.send(JSON.stringify({ id, status, data }))
```

### 5.6 TRPC Media URL Interceptor

**Purpose:** Capture fresh signed URLs from TRPC responses

**Flow:**
1. `injected.js` monkey-patches `window.fetch()`
2. Intercepts responses from `/fx/api/trpc/*`
3. Extracts GCS URLs: `storage.googleapis.com/ai-sandbox-videofx/...`
4. Dispatches CustomEvent → `content.js` → `background.js`
5. Background sends to agent via WebSocket
6. Agent updates DB (`flow_client.py` lines 135-192)

**Files:**
- `injected.js` lines 14-32
- `content.js` lines 39-49
- `background.js` lines 616-654
- `agent/services/flow_client.py` lines 135-192

---

## 6. Constants & Configuration

### 6.1 Extension Constants (background.js)

```javascript
const AGENT_WS_URL = 'ws://127.0.0.1:9222';
const API_KEY = 'AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY';  // Public browser key
```

### 6.2 Extension Constants (injected.js)

```javascript
const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';  // reCAPTCHA site key
```

### 6.3 Agent Configuration (agent/config.py)

```python
# API Server
API_HOST = "127.0.0.1"
API_PORT = 8100

# WebSocket Server
WS_HOST = "127.0.0.1"
WS_PORT = 9222

# Google Flow API
GOOGLE_FLOW_API = "https://aisandbox-pa.googleapis.com"
GOOGLE_API_KEY = "AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY"
RECAPTCHA_SITE_KEY = "6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV"
```

---

## 7. Dependency Graph

```
EXTENSION CORE FILES (standalone, no dependencies)
├── manifest.json
├── rules.json
├── injected.js
├── content.js
└── background.js
    ├── DEPENDS ON: Agent WebSocket Server (ws://127.0.0.1:9222)
    │   └── agent/main.py:ws_handler()
    │       └── agent/services/flow_client.py:FlowClient
    │
    └── DEPENDS ON: Agent HTTP Callback (http://127.0.0.1:8100/api/ext/callback)
        └── agent/main.py:ext_callback()
            └── agent/services/flow_client.py:FlowClient._pending

EXTENSION UI FILES (optional, depends on agent API)
├── side_panel.html
└── side_panel.js
    ├── DEPENDS ON: Agent HTTP API
    │   ├── /api/chat
    │   ├── /api/models/chat
    │   └── /api/skills
    │
    └── DEPENDS ON: Agent Dashboard WebSocket
        └── /ws/dashboard (agent/main.py:dashboard_ws)
```

---

## 8. Cấu trúc Project mới đề xuất

### 8.1 Option 1: Standalone Extension (chỉ proxy, không backend)

```
flow-extension/
├── manifest.json
├── background.js          # Modified: remove agent WS dependency
├── content.js
├── injected.js
├── rules.json
├── popup.html             # Simple status UI
├── popup.js
└── README.md

Changes needed:
- Remove WebSocket client code from background.js
- Store flowKey locally only (chrome.storage.local)
- Expose simple HTTP API for external tools to call
- Example: GET /captcha, POST /api-proxy
```

**Pros:** Hoàn toàn độc lập, không cần backend
**Cons:** Không có queue, retry logic, database

### 8.2 Option 2: Extension + Minimal Backend (recommended)

```
flow-extension/
├── extension/
│   ├── manifest.json
│   ├── background.js      # Keep as-is
│   ├── content.js
│   ├── injected.js
│   ├── rules.json
│   └── popup.html         # Minimal UI
│
├── backend/               # Minimal Python server
│   ├── main.py           # WebSocket + HTTP server
│   ├── flow_client.py    # API wrapper
│   └── config.py
│
├── requirements.txt
└── README.md

Files to extract from FlowKit:
- agent/main.py (lines 42-71, 147-169)  # WS + callback
- agent/services/flow_client.py         # Complete file
- agent/config.py (minimal config)
```

**Pros:** Giữ nguyên architecture, dễ maintain
**Cons:** Vẫn cần chạy backend server

### 8.3 Option 3: Full Fork (keep everything)

```
flow-extension/
├── extension/             # Copy từ extension/
├── agent/                 # Copy minimal files
│   ├── main.py
│   ├── config.py
│   └── services/
│       └── flow_client.py
├── requirements.txt
└── README.md

Dependencies to remove:
- Database (db/)
- Worker (worker/)
- Dashboard API (api/)
- All business logic
```

---

## 9. Phần tối thiểu cần thiết

### 9.1 Core Extension (BẮT BUỘC)

**Files:**
- ✅ `manifest.json`
- ✅ `background.js`
- ✅ `content.js`
- ✅ `injected.js`
- ✅ `rules.json`

**Functionality:**
- ✅ Kết nối Google Flow
- ✅ Lấy Flow token (Bearer ya29.*)
- ✅ Solve reCAPTCHA
- ✅ Proxy API requests
- ✅ Bypass CORS

### 9.2 Minimal Backend (BẮT BUỘC nếu muốn dùng WebSocket)

**Files to extract:**
```python
# main.py (minimal)
import asyncio
import json
import websockets
from fastapi import FastAPI, Request

app = FastAPI()
_CALLBACK_SECRET = "..."
_extension_ws = None
_pending = {}

async def ws_handler(websocket):
    global _extension_ws
    _extension_ws = websocket
    await websocket.send(json.dumps({"type": "callback_secret", "secret": _CALLBACK_SECRET}))
    async for raw in websocket:
        data = json.loads(raw)
        # Handle messages
        
@app.post("/api/ext/callback")
async def ext_callback(request: Request):
    data = await request.json()
    req_id = data.get("id")
    if req_id in _pending:
        _pending[req_id].set_result(data)
    return {"ok": True}
```

**Dependencies:**
- `fastapi`
- `uvicorn`
- `websockets`

### 9.3 Optional UI

**If needed:**
- `popup.html` - Simple status display
- `popup.js` - Minimal logic

**If NOT needed:**
- Remove `side_panel.html`, `side_panel.js`
- Remove UI permissions from manifest

---

## 10. API Endpoints Summary

### 10.1 Extension → Agent

**WebSocket Messages (ws://127.0.0.1:9222):**
```javascript
// Extension → Agent
{ type: "token_captured", flowKey: "ya29.xxx" }
{ type: "extension_ready", flowKeyPresent: true, tokenAge: 123456 }
{ type: "media_urls_refresh", urls: [...] }
{ type: "ping" }
{ type: "pong" }

// Agent → Extension
{ id: "uuid", method: "api_request", params: {...} }
{ id: "uuid", method: "trpc_request", params: {...} }
{ id: "uuid", method: "solve_captcha", params: {...} }
{ method: "get_status" }
{ type: "callback_secret", secret: "..." }
```

**HTTP Callback (POST http://127.0.0.1:8100/api/ext/callback):**
```javascript
{
  id: "uuid",
  status: 200,
  data: {...}  // or error: "..."
}
```

### 10.2 Google Flow API Endpoints

**Used by extension (via background.js proxy):**
- `POST /v1/projects/{project_id}/flowMedia:batchGenerateImages`
- `POST /v1/video:batchAsyncGenerateVideoStartImage`
- `POST /v1/video:batchAsyncGenerateVideoStartAndEndImage`
- `POST /v1/video:batchAsyncGenerateVideoReferenceImages`
- `POST /v1/video:batchAsyncGenerateVideoUpsampleVideo`
- `POST /v1/video:batchCheckAsyncVideoGenerationStatus`
- `POST /v1/flow/uploadImage`
- `GET /v1/media/{mediaId}`
- `GET /v1/flow/credits`

**All require:**
- ✅ Bearer token (from extension)
- ✅ reCAPTCHA token (solved by extension)
- ✅ Browser context (cookies, IP)

---

## 11. Message Passing Logic

### 11.1 Three-layer Communication

```
┌─────────────────────────────────────────────────────┐
│  INJECTED.JS (MAIN world)                           │
│  • Access window.grecaptcha                         │
│  • Intercept fetch()                                │
│  • No chrome.* APIs                                 │
└────────────────┬────────────────────────────────────┘
                 │ window.dispatchEvent()
                 │ window.addEventListener()
                 │
┌────────────────▼────────────────────────────────────┐
│  CONTENT.JS (ISOLATED world)                        │
│  • Bridge between injected and background           │
│  • CustomEvent listener/dispatcher                  │
│  • chrome.runtime.sendMessage()                     │
└────────────────┬────────────────────────────────────┘
                 │ chrome.runtime.sendMessage()
                 │ chrome.runtime.onMessage
                 │
┌────────────────▼────────────────────────────────────┐
│  BACKGROUND.JS (Service Worker)                     │
│  • WebSocket client                                 │
│  • HTTP fetch                                       │
│  • Token capture                                    │
│  • chrome.webRequest, chrome.storage               │
└─────────────────────────────────────────────────────┘
```

### 11.2 Event Flow Examples

**reCAPTCHA Solve:**
```
Agent → Background (WS): {method: "solve_captcha", params: {captchaAction: "VIDEO_GENERATION"}}
Background → Content (chrome.runtime): {type: "GET_CAPTCHA", requestId, pageAction}
Content → Injected (CustomEvent): GET_CAPTCHA
Injected → grecaptcha API: execute()
Injected → Content (CustomEvent): CAPTCHA_RESULT {token}
Content → Background (reply): {token}
Background → Agent (HTTP/WS): {id, result: {token}}
```

**TRPC URL Intercept:**
```
Injected (fetch intercept) → detect TRPC response with GCS URLs
Injected → Content (CustomEvent): TRPC_MEDIA_URLS {url, body}
Content → Background (chrome.runtime): {type: "TRPC_MEDIA_URLS", ...}
Background → Agent (WS): {type: "media_urls_refresh", urls: [...]}
Agent → DB: UPDATE scenes/characters SET *_url = ...
```

---

## 12. Kết luận

### 12.1 Phần tối thiểu để extension hoạt động độc lập

**CORE (không phụ thuộc gì):**
- ✅ manifest.json
- ✅ rules.json
- ✅ injected.js
- ✅ content.js
- ✅ background.js (nếu bỏ WebSocket code)

**BACKEND (nếu muốn queue + retry + database):**
- ✅ WebSocket server (40 dòng code)
- ✅ HTTP callback endpoint (20 dòng code)
- ✅ FlowClient wrapper (optional - có thể call trực tiếp)

**UI (optional):**
- ⚠️ popup.html/js (minimal status)
- ❌ side_panel.html/js (không cần nếu không dùng chat)

### 12.2 Khuyến nghị

**Option 2 (Extension + Minimal Backend)** là phương án tốt nhất:
- Giữ nguyên architecture hiện tại
- Code ít thay đổi
- Backend minimal (~100-200 dòng)
- Dễ maintain và mở rộng

**Files cần copy:**
```
extension/          → 100% (all files)
agent/main.py       → Extract WS + callback only
agent/config.py     → Minimal constants
agent/services/flow_client.py → Complete copy
```

**Không cần:**
- ❌ Database (db/)
- ❌ Worker (worker/)
- ❌ All API routers (api/)
- ❌ Dashboard WebSocket (if no UI)
- ❌ Skills, TTS, Materials, etc.

### 12.3 Entry Points

**Extension:**
- `manifest.json` - Manifest V3 declaration
- `background.js` - Service worker entry

**Backend:**
- `python -m uvicorn main:app --host 127.0.0.1 --port 8100`
- WebSocket starts automatically on port 9222

**Testing:**
1. Load extension: `chrome://extensions` → Load unpacked
2. Start backend: `python main.py`
3. Open Flow tab: https://labs.google/fx/tools/flow
4. Check connection: Extension badge should show green dot

---

## 13. Files quan trọng nhất (theo thứ tự)

1. **background.js** (759 lines) - Core logic, WebSocket client, token capture, API proxy
2. **manifest.json** (46 lines) - Extension declaration, permissions
3. **injected.js** (63 lines) - reCAPTCHA solver, TRPC interceptor
4. **content.js** (49 lines) - Message bridge
5. **rules.json** (25 lines) - CORS bypass rules
6. **agent/services/flow_client.py** (630 lines) - Backend API wrapper
7. **agent/main.py** (246 lines) - Backend server (extract WS + callback only)

**Total core extension code:** ~1,000 lines
**Total minimal backend code:** ~150-200 lines (extracted)

---

## Phụ lục: Command Reference

### Development
```bash
# Load extension
chrome://extensions → Developer mode → Load unpacked → select extension/

# Start backend (if using Option 2)
cd flow-extension/backend
python -m uvicorn main:app --host 127.0.0.1 --port 8100

# Test WebSocket
wscat -c ws://127.0.0.1:9222

# Test HTTP callback
curl -X POST http://127.0.0.1:8100/api/ext/callback \
  -H "Content-Type: application/json" \
  -d '{"id":"test","status":200,"data":{}}'
```

### Debugging
```bash
# Extension background console
chrome://extensions → Flow Kit → Inspect views: service worker

# Extension side panel console
Open side panel → Right click → Inspect

# Backend logs
tail -f logs/agent.log
```

---

**Tài liệu này cung cấp đầy đủ thông tin để tách extension thành project độc lập.**


