# Chromium Profile Manager

Hệ thống quản lý Chromium profiles tự động với hỗ trợ Chrome Extension - được xây dựng bằng Node.js, TypeScript, và Playwright.

## 🎯 Mục tiêu

Tự động hóa việc quản lý nhiều Chromium profiles độc lập, mỗi profile tự động load Chrome Extension và có thể truy cập Google Flow mà không cần can thiệp thủ công.

## ✨ Tính năng

- ✅ **Tự động tạo Chromium profiles** - Mỗi profile hoàn toàn độc lập
- ✅ **Tự động load Chrome Extension** - Extension được load tự động khi khởi động
- ✅ **Session Management** - Lưu và khôi phục cookies, localStorage, sessionStorage
- ✅ **RESTful API** - Điều khiển profiles qua HTTP API
- ✅ **Multiple Profiles** - Chạy nhiều profiles song song
- ✅ **Production Ready** - Logging, error handling, graceful shutdown
- ✅ **TypeScript** - Type-safe code với đầy đủ type definitions

## 📋 Yêu cầu hệ thống

- Node.js >= 18.0.0
- npm hoặc pnpm
- Windows/Linux/macOS

## 🚀 Cài đặt

### 1. Clone hoặc tạo project

```bash
cd D:\FreeLand\chromium-profile-manager
```

### 2. Cài đặt dependencies

```bash
npm install
```

Playwright sẽ tự động tải Chromium browser.

### 3. Cấu hình Extension Path

Mặc định, extension path được cấu hình trong `src/config/index.ts`:

```typescript
paths: {
    extension: path.resolve(process.cwd(), '../chromium-profile-manager/extension'),
}
```

Bạn có thể thay đổi bằng environment variable:

```bash
EXTENSION_PATH=D:\FreeLand\chromium-profile-manager\extension
```

## 📂 Cấu trúc thư mục

```
chromium-profile-manager/
├── src/
│   ├── api/                    # REST API routes
│   │   └── routes.ts
│   ├── browser-manager/        # Quản lý browser instances
│   │   └── BrowserManager.ts
│   ├── config/                 # Configuration
│   │   └── index.ts
│   ├── extension-loader/       # Extension loading logic
│   │   └── ExtensionLoader.ts
│   ├── flow-session/           # Google Flow session management
│   │   └── FlowSession.ts
│   ├── profile-manager/        # Profile CRUD operations
│   │   └── ProfileManager.ts
│   ├── types/                  # TypeScript type definitions
│   │   └── index.ts
│   ├── utils/                  # Utilities (logger, etc.)
│   │   └── logger.ts
│   └── main.ts                 # Entry point
├── profiles/                   # Generated profiles (auto-created)
├── logs/                       # Application logs (auto-created)
├── package.json
├── tsconfig.json
└── README.md
```

## 🎮 Sử dụng

### Khởi động server

```bash
# Development mode (với hot reload)
npm run dev

# Production mode
npm start
```

Server sẽ chạy tại: `http://localhost:3000`

### API Endpoints

#### 1. Health Check

```bash
GET /api/health
```

#### 2. Tạo profile mới

```bash
POST /api/profiles/create
Content-Type: application/json

{
  "name": "My Profile",
  "metadata": {
    "description": "Test profile"
  }
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "My Profile",
    "userDataDir": "profiles/550e8400-e29b-41d4-a716-446655440000",
    "extensionPath": "../chromium-profile-manager/extension",
    "createdAt": "2026-06-15T10:42:00.000Z"
  },
  "message": "Profile created successfully"
}
```

#### 3. Mở profile (launch browser)

```bash
POST /api/profiles/open
Content-Type: application/json

{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "openFlow": true
}
```

**Response:**

```json
{
  "success": true,
  "data": {
    "profileId": "550e8400-e29b-41d4-a716-446655440000",
    "extensionId": "abcdefghijklmnop"
  },
  "message": "Profile opened successfully"
}
```

#### 4. Đóng profile

```bash
POST /api/profiles/:id/close
```

#### 5. Xóa profile

```bash
DELETE /api/profiles/:id
```

#### 6. Liệt kê tất cả profiles

```bash
GET /api/profiles
```

#### 7. Xem active sessions

```bash
GET /api/sessions
```

## 🏗️ Kiến trúc hệ thống

```
┌─────────────────────────────────────────────┐
│            REST API Server                   │
│          (Express + TypeScript)              │
└────────────────┬────────────────────────────┘
                 │
        ┌────────▼────────┐
        │ ProfileManager  │ ◄─── Quản lý CRUD profiles
        └────────┬────────┘
                 │
        ┌────────▼────────┐
        │ BrowserManager  │ ◄─── Launch/Close browsers
        └────────┬────────┘
                 │
        ┌────────▼────────┐
        │ExtensionLoader  │ ◄─── Load extension tự động
        └────────┬────────┘
                 │
        ┌────────▼────────┐
        │  FlowSession    │ ◄─── Quản lý Google Flow session
        └────────┬────────┘
                 │
        ┌────────▼────────┐
        │   Playwright    │
        │    Chromium     │
        │   + Extension   │
        └─────────────────┘
```

## 🔧 Configuration

File `src/config/index.ts` chứa tất cả cấu hình:

```typescript
export const CONFIG = {
  server: {
    port: 3000,
    host: 'localhost',
  },
  paths: {
    profiles: './profiles',
    extension: '../chromium-profile-manager/extension',
    logs: './logs',
  },
  browser: {
    headless: false,  // Extension yêu cầu non-headless
    devtools: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      // ... các args khác
    ],
  },
  flow: {
    url: 'https://labs.google/fx/tools/flow',
    sessionTimeout: 1800000, // 30 phút
  },
};
```

### Environment Variables

```bash
# Server
PORT=3000
HOST=localhost

# Paths
EXTENSION_PATH=D:\FreeLand\chromium-profile-manager\extension

# Browser
HEADLESS=false
DEVTOOLS=false
SLOW_MO=0

# Logging
LOG_LEVEL=info
```

## 📝 Ví dụ sử dụng

### Example 1: Tạo và mở profile với Flow

```bash
# 1. Tạo profile
curl -X POST http://localhost:3000/api/profiles/create \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Profile 1"}'

# 2. Mở profile và Google Flow
curl -X POST http://localhost:3000/api/profiles/open \
  -H "Content-Type: application/json" \
  -d '{"id":"<profile-id>","openFlow":true}'
```

### Example 2: Quản lý nhiều profiles

```bash
# Xem tất cả profiles
curl http://localhost:3000/api/profiles

# Xem active sessions
curl http://localhost:3000/api/sessions

# Đóng profile
curl -X POST http://localhost:3000/api/profiles/<profile-id>/close

# Xóa profile
curl -X DELETE http://localhost:3000/api/profiles/<profile-id>
```

## 🧪 Development

```bash
# Build project
npm run build

# Watch mode (development)
npm run dev

# Clean build artifacts
npm run clean

# Lint code
npm run lint

# Format code
npm run format
```

## 📊 Logging

Logs được lưu trong thư mục `logs/`:

- `combined.log` - Tất cả logs
- `error.log` - Chỉ errors

Console output có màu sắc để dễ đọc.

## 🔒 Security Notes

- Browser được launch với các flags để bypass automation detection
- Extension được load từ local filesystem
- Không lưu trữ sensitive data (passwords, tokens) trong code
- Session data được lưu trong memory, không persist to disk by default

## 🛠️ Troubleshooting

### Extension không load

1. Kiểm tra extension path trong config
2. Verify manifest.json tồn tại
3. Check logs trong `logs/combined.log`

### Browser không khởi động

1. Đảm bảo Playwright đã được install: `npx playwright install chromium`
2. Check port 3000 không bị sử dụng
3. Xem logs để biết thêm chi tiết

### Port already in use

```bash
# Change port
PORT=3001 npm start
```

## 🎯 Next Steps

Sau khi hệ thống chạy được:

1. ✅ Test tạo profile
2. ✅ Test launch browser với extension
3. ✅ Test mở Google Flow
4. ✅ Implement WebSocket cho real-time communication
5. ✅ Integrate với FlowKit backend
6. ✅ Add authentication/authorization
7. ✅ Implement profile templates
8. ✅ Add profile cloning functionality

## 📄 License

MIT

## 👨‍💻 Author

FlowKit Team
