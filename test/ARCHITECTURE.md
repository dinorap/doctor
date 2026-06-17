# Chromium Profile Manager - Architecture

## System Overview

Chromium Profile Manager là hệ thống tự động hóa quản lý Chromium profiles với tích hợp Chrome Extension, được thiết kế để chạy Google Flow mà không cần can thiệp thủ công.

## Core Components

### 1. ProfileManager
**Location:** `src/profile-manager/ProfileManager.ts`

**Responsibility:** Quản lý CRUD operations cho profiles

**Key Methods:**
- `createProfile(request)` - Tạo profile mới với UUID và user data directory
- `getProfile(id)` - Lấy thông tin profile
- `listProfiles()` - Liệt kê tất cả profiles
- `deleteProfile(id)` - Xóa profile và cleanup
- `updateLastUsed(id)` - Cập nhật timestamp sử dụng lần cuối

**Data Storage:** JSON file (`profiles/profiles.json`)

### 2. BrowserManager
**Location:** `src/browser-manager/BrowserManager.ts`

**Responsibility:** Quản lý browser lifecycle và active sessions

**Key Methods:**
- `launchProfile(profile, options)` - Launch Chromium với persistent context
- `closeProfile(profileId)` - Đóng browser instance
- `getActiveSessions()` - Lấy danh sách sessions đang hoạt động
- `closeAll()` - Graceful shutdown tất cả browsers

**State Management:** In-memory Map<profileId, ProfileState>

### 3. ExtensionLoader
**Location:** `src/extension-loader/ExtensionLoader.ts`

**Responsibility:** Load và validate Chrome Extension

**Key Methods:**
- `validateExtension()` - Kiểm tra extension hợp lệ
- `getExtensionId(context)` - Lấy extension ID sau khi load
- `waitForExtension(context)` - Đợi extension load thành công
- `getExtensionPath()` - Trả về đường dẫn extension

**Loading Strategy:** 
- Load extension qua Playwright launch args
- Monitor service workers để detect extension

### 4. FlowSession
**Location:** `src/flow-session/FlowSession.ts`

**Responsibility:** Quản lý Google Flow sessions

**Key Methods:**
- `openFlow()` - Mở Google Flow URL
- `isLoggedIn()` - Kiểm tra trạng thái đăng nhập
- `waitForLogin(timeout)` - Đợi user login
- `saveSession()` - Lưu cookies và storage
- `restoreSession(data)` - Khôi phục session

**Session Data:** Cookies, localStorage, sessionStorage

### 5. API Routes
**Location:** `src/api/routes.ts`

**Responsibility:** RESTful API endpoints

**Endpoints:**
- `GET /api/health` - Health check
- `GET /api/profiles` - List profiles
- `POST /api/profiles/create` - Create profile
- `POST /api/profiles/open` - Launch browser
- `POST /api/profiles/:id/close` - Close browser
- `DELETE /api/profiles/:id` - Delete profile
- `GET /api/sessions` - Active sessions

## Data Flow

### Creating and Launching a Profile

```
1. Client Request
   POST /api/profiles/create

2. ProfileManager.createProfile()
   ├── Generate UUID
   ├── Create user data directory
   ├── Save profile metadata
   └── Return ProfileConfig

3. Client Request
   POST /api/profiles/open

4. BrowserManager.launchProfile()
   ├── ExtensionLoader.validateExtension()
   ├── chromium.launchPersistentContext()
   │   └── Load extension via args
   ├── ExtensionLoader.waitForExtension()
   ├── ExtensionLoader.getExtensionId()
   └── Store ProfileState

5. (Optional) FlowSession.openFlow()
   ├── Navigate to Google Flow
   └── Wait for user interaction
```

### Session Persistence

```
User Login
   ↓
FlowSession.saveSession()
   ├── context.cookies()
   ├── page.evaluate() → localStorage
   └── page.evaluate() → sessionStorage
   ↓
Store in ProfileState (memory)
   ↓
On Profile Reopen
   ↓
FlowSession.restoreSession()
   ├── context.addCookies()
   └── page.evaluate() → restore storage
```

## Technology Stack

- **Runtime:** Node.js 18+
- **Language:** TypeScript
- **Browser Automation:** Playwright
- **Web Framework:** Express.js
- **Logging:** Winston
- **UUID Generation:** uuid

## Directory Structure

```
chromium-profile-manager/
├── src/
│   ├── api/              # HTTP API
│   ├── browser-manager/  # Browser lifecycle
│   ├── config/           # Configuration
│   ├── extension-loader/ # Extension handling
│   ├── flow-session/     # Flow session mgmt
│   ├── profile-manager/  # Profile CRUD
│   ├── types/            # TypeScript types
│   ├── utils/            # Utilities
│   └── main.ts           # Entry point
├── profiles/             # Runtime profiles
└── logs/                 # Application logs
```

## Configuration

**File:** `src/config/index.ts`

Key configurations:
- Server port and host
- Extension path
- Browser launch args
- Flow URL and timeout
- Logging settings

Environment variables override defaults via `.env` file.

## Security Considerations

1. **Extension Loading:** Extension loaded from local filesystem only
2. **Profile Isolation:** Each profile has separate user data directory
3. **Session Data:** Stored in memory, not persisted to disk by default
4. **API Security:** No authentication by default (add as needed)
5. **Browser Flags:** Anti-detection flags to bypass automation checks

## Scalability

- **Multiple Profiles:** Support nhiều profiles song song
- **Resource Management:** Graceful shutdown closes all browsers
- **Logging:** Structured logging với rotation
- **Error Handling:** Try-catch ở tất cả async operations

## Extension Integration

Extension được load tự động qua Playwright args:

```typescript
args: [
  `--disable-extensions-except=${extensionPath}`,
  `--load-extension=${extensionPath}`,
]
```

Extension ID được detect qua service workers:

```typescript
const workers = context.serviceWorkers();
for (const worker of workers) {
  if (worker.url().startsWith('chrome-extension://')) {
    const id = worker.url().split('/')[2];
    return id;
  }
}
```

## Future Enhancements

1. **WebSocket Support** - Real-time communication
2. **Profile Templates** - Pre-configured profiles
3. **Profile Cloning** - Duplicate existing profiles
4. **Authentication** - API security layer
5. **Database Storage** - Replace JSON with SQLite/PostgreSQL
6. **Docker Support** - Containerization
7. **Metrics & Monitoring** - Prometheus/Grafana integration

## Troubleshooting

### Extension Not Loading
- Verify extension path
- Check manifest.json exists
- Review logs for errors

### Browser Crashes
- Check Chromium is installed
- Verify sufficient memory
- Review browser launch args

### Port Conflicts
- Change PORT environment variable
- Check for other services on port 3000

## API Examples

See README.md for complete API documentation and examples.
