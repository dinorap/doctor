# Quick Start Guide

Hướng dẫn nhanh để chạy Chromium Profile Manager trong 5 phút.

## Bước 1: Cài đặt Dependencies

```bash
cd D:\FreeLand\chromium-profile-manager
npm install
```

Lệnh này sẽ:
- Cài đặt tất cả Node.js packages
- Tải Playwright Chromium browser

## Bước 2: Cấu hình Extension Path

Tạo file `.env`:

```bash
copy .env.example .env
```

Chỉnh sửa `.env` nếu cần thay đổi extension path:

```
EXTENSION_PATH=D:\FreeLand\agent-flowkit\extension
```

## Bước 3: Khởi động Server

```bash
npm run dev
```

Server sẽ chạy tại: http://localhost:3000

## Bước 4: Test API

### 1. Health Check

```bash
curl http://localhost:3000/api/health
```

### 2. Tạo Profile

```bash
curl -X POST http://localhost:3000/api/profiles/create ^
  -H "Content-Type: application/json" ^
  -d "{\"name\":\"My First Profile\"}"
```

Lưu lại `id` từ response!

### 3. Mở Profile (Launch Browser)

```bash
curl -X POST http://localhost:3000/api/profiles/open ^
  -H "Content-Type: application/json" ^
  -d "{\"id\":\"YOUR_PROFILE_ID\",\"openFlow\":true}"
```

Chromium sẽ mở với:
- ✅ Extension đã được load
- ✅ Google Flow đã được mở
- ✅ Profile persistence

## Bước 5: Verify Extension

Trong browser đã mở:
1. Nhấn `Ctrl+Shift+I` để mở DevTools
2. Vào tab Console
3. Check xem extension có load không

Hoặc click vào extension icon trên toolbar.

## Bước 6: Quản lý Profiles

### Xem tất cả profiles

```bash
curl http://localhost:3000/api/profiles
```

### Xem active sessions

```bash
curl http://localhost:3000/api/sessions
```

### Đóng profile

```bash
curl -X POST http://localhost:3000/api/profiles/YOUR_PROFILE_ID/close
```

### Xóa profile

```bash
curl -X DELETE http://localhost:3000/api/profiles/YOUR_PROFILE_ID
```

## Commands Tóm tắt

```bash
# Development
npm run dev          # Start với hot reload

# Production
npm run build        # Build TypeScript
npm start            # Run production

# Utilities
npm run clean        # Clean build artifacts
npm run lint         # Check code
npm run format       # Format code
```

## Thư mục quan trọng

```
chromium-profile-manager/
├── profiles/        # Auto-generated profiles
├── logs/            # Application logs
│   ├── combined.log
│   └── error.log
└── src/             # Source code
```

## Troubleshooting Nhanh

**Extension không load?**
```bash
# Verify extension path
dir D:\FreeLand\agent-flowkit\extension\manifest.json
```

**Port đã được sử dụng?**
```bash
# Đổi port
set PORT=3001
npm run dev
```

**Browser không mở?**
```bash
# Cài lại Chromium
npx playwright install chromium
```

## Next Steps

1. Đọc [README.md](README.md) để hiểu đầy đủ API
2. Đọc [ARCHITECTURE.md](ARCHITECTURE.md) để hiểu kiến trúc
3. Customize config trong `src/config/index.ts`
4. Tích hợp với backend của bạn

## Ví dụ: Script tự động

```bash
# create-and-launch.bat
@echo off
echo Creating profile...
curl -X POST http://localhost:3000/api/profiles/create -H "Content-Type: application/json" -d "{\"name\":\"Auto Profile\"}" > profile.json

echo Launching browser...
for /f "tokens=2 delims=:," %%a in ('findstr "id" profile.json') do set PROFILE_ID=%%a
curl -X POST http://localhost:3000/api/profiles/open -H "Content-Type: application/json" -d "{\"id\":%PROFILE_ID%,\"openFlow\":true}"

echo Done!
```

Chúc bạn thành công! 🚀
