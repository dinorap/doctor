# Hướng Dẫn Sử Dụng Chi Tiết

## Giới thiệu

Chromium Profile Manager là hệ thống tự động hóa hoàn toàn để quản lý Chromium profiles với Chrome Extension tích hợp sẵn.

## 🎯 Mục đích chính

✅ Tự tạo Chromium profile mới  
✅ Tự khởi động Chromium bằng Playwright  
✅ Tự động load Chrome Extension từ thư mục local  
✅ KHÔNG sử dụng Chrome cá nhân của người dùng  
✅ KHÔNG yêu cầu cài extension thủ công  
✅ Mỗi profile hoạt động độc lập  
✅ Có thể chạy nhiều profile song song  

## Cài đặt

### 1. Di chuyển vào thư mục

```bash
cd D:\FreeLand\chromium-profile-manager
```

### 2. Đã cài đặt dependencies

Bạn đã chạy `npm install` thành công với 286 packages.

### 3. Cấu hình

Copy file `.env.example` thành `.env`:

```bash
copy .env.example .env
```

File `.env` mặc định:

```env
PORT=3000
HOST=localhost
EXTENSION_PATH=D:\FreeLand\agent-flowkit\extension
HEADLESS=false
DEVTOOLS=false
SLOW_MO=0
LOG_LEVEL=info
```

## Khởi động hệ thống

### Development mode (khuyến nghị)

```bash
npm run dev
```

Chế độ này có hot reload, code thay đổi sẽ tự động restart server.

### Production mode

```bash
npm run build
npm start
```

## API Usage

### 1. Health Check

Kiểm tra server đang chạy:

```bash
curl http://localhost:3000/api/health
```

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "healthy",
    "timestamp": "2026-06-15T10:42:00.000Z"
  }
}
```

### 2. Tạo Profile

```bash
curl -X POST http://localhost:3000/api/profiles/create ^
  -H "Content-Type: application/json" ^
  -d "{\"name\":\"Profile Test 1\"}"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "name": "Profile Test 1",
    "userDataDir": "profiles/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "extensionPath": "D:\\FreeLand\\agent-flowkit\\extension",
    "createdAt": "2026-06-15T10:42:00.000Z",
    "metadata": {}
  },
  "message": "Profile created successfully"
}
```

⚠️ **LƯU Ý:** Lưu lại `id` này để sử dụng cho các bước tiếp theo!

### 3. Mở Profile (Launch Chromium)

```bash
curl -X POST http://localhost:3000/api/profiles/open ^
  -H "Content-Type: application/json" ^
  -d "{\"id\":\"a1b2c3d4-e5f6-7890-abcd-ef1234567890\"}"
```

Chromium sẽ tự động:
- ✅ Mở với profile đã tạo
- ✅ Load extension từ `D:\FreeLand\agent-flowkit\extension`
- ✅ Sẵn sàng sử dụng

**Mở profile VÀ Google Flow:**

```bash
curl -X POST http://localhost:3000/api/profiles/open ^
  -H "Content-Type: application/json" ^
  -d "{\"id\":\"a1b2c3d4-e5f6-7890-abcd-ef1234567890\",\"openFlow\":true}"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "profileId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "extensionId": "abcdefghijklmnop"
  },
  "message": "Profile opened successfully"
}
```

### 4. Liệt kê tất cả Profiles

```bash
curl http://localhost:3000/api/profiles
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "name": "Profile Test 1",
      "userDataDir": "profiles/a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "extensionPath": "D:\\FreeLand\\agent-flowkit\\extension",
      "createdAt": "2026-06-15T10:42:00.000Z",
      "lastUsed": "2026-06-15T10:45:00.000Z"
    }
  ]
}
```

### 5. Xem Active Sessions

```bash
curl http://localhost:3000/api/sessions
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "profileId": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "profileName": "Profile Test 1",
      "isActive": true,
      "extensionId": "abcdefghijklmnop"
    }
  ]
}
```

### 6. Đóng Profile

```bash
curl -X POST http://localhost:3000/api/profiles/a1b2c3d4-e5f6-7890-abcd-ef1234567890/close
```

### 7. Xóa Profile

```bash
curl -X DELETE http://localhost:3000/api/profiles/a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

⚠️ **Cảnh báo:** Profile sẽ bị xóa vĩnh viễn cùng với tất cả dữ liệu!

## Workflow thông thường

### Quy trình cơ bản

```
1. Tạo profile
   ↓
2. Mở profile (launch Chromium)
   ↓
3. Extension tự động load
   ↓
4. (Optional) Mở Google Flow
   ↓
5. Làm việc với browser
   ↓
6. Đóng profile khi xong
```

### Quy trình với nhiều profiles

```bash
# Tạo nhiều profiles
curl -X POST http://localhost:3000/api/profiles/create -H "Content-Type: application/json" -d "{\"name\":\"Profile 1\"}"
curl -X POST http://localhost:3000/api/profiles/create -H "Content-Type: application/json" -d "{\"name\":\"Profile 2\"}"
curl -X POST http://localhost:3000/api/profiles/create -H "Content-Type: application/json" -d "{\"name\":\"Profile 3\"}"

# Mở tất cả cùng lúc
curl -X POST http://localhost:3000/api/profiles/open -H "Content-Type: application/json" -d "{\"id\":\"profile-1-id\"}"
curl -X POST http://localhost:3000/api/profiles/open -H "Content-Type: application/json" -d "{\"id\":\"profile-2-id\"}"
curl -X POST http://localhost:3000/api/profiles/open -H "Content-Type: application/json" -d "{\"id\":\"profile-3-id\"}"

# Xem tất cả sessions
curl http://localhost:3000/api/sessions
```

## Kiểm tra Extension đã load

Sau khi mở profile:

1. Trong Chromium đã mở, nhấn `F12` hoặc `Ctrl+Shift+I`
2. Vào tab **Console**
3. Kiểm tra xem có log từ extension không

Hoặc:

1. Click icon Extensions (puzzle piece) trên toolbar
2. Tìm "Flow Kit" trong danh sách
3. Verify extension đang active

## Logs và Debugging

### Xem logs

Logs được lưu trong thư mục `logs/`:

```bash
# Xem tất cả logs
type logs\combined.log

# Xem chỉ errors
type logs\error.log

# Theo dõi logs real-time (PowerShell)
Get-Content logs\combined.log -Wait -Tail 50
```

### Log levels

- `error` - Chỉ errors
- `warn` - Warnings và errors
- `info` (mặc định) - Thông tin chính
- `debug` - Chi tiết debug

Thay đổi trong `.env`:
```
LOG_LEVEL=debug
```

## Thư mục quan trọng

```
chromium-profile-manager/
├── src/                    # Source code TypeScript
├── dist/                   # Compiled JavaScript (sau khi build)
├── profiles/               # Profiles được tạo tự động
│   ├── <uuid-1>/          # Profile 1 data
│   ├── <uuid-2>/          # Profile 2 data
│   └── profiles.json      # Metadata của profiles
├── logs/                   # Application logs
│   ├── combined.log       # Tất cả logs
│   └── error.log          # Chỉ errors
└── node_modules/           # Dependencies
```

## Troubleshooting

### Extension không load

**Kiểm tra:**
```bash
# Verify extension path
dir D:\FreeLand\agent-flowkit\extension\manifest.json
```

**Giải pháp:**
- Đảm bảo `EXTENSION_PATH` trong `.env` đúng
- Verify manifest.json tồn tại
- Check logs trong `logs/combined.log`

### Browser không mở

**Kiểm tra:**
```bash
# Verify Playwright Chromium installed
npx playwright install chromium
```

**Giải pháp:**
- Cài lại Chromium: `npx playwright install chromium`
- Check logs để xem lỗi chi tiết
- Verify không có antivirus block Chromium

### Port đã được sử dụng

**Error:** `EADDRINUSE: address already in use`

**Giải pháp:**
```bash
# Option 1: Đổi port
set PORT=3001
npm run dev

# Option 2: Tìm và kill process đang dùng port 3000
netstat -ano | findstr :3000
taskkill /PID <PID> /F
```

### TypeScript errors

**Giải pháp:**
```bash
# Clean và rebuild
npm run clean
npm run build
```

### Profile không xóa được

**Nguyên nhân:** Browser vẫn đang mở

**Giải pháp:**
```bash
# Đóng profile trước
curl -X POST http://localhost:3000/api/profiles/<profile-id>/close

# Sau đó xóa
curl -X DELETE http://localhost:3000/api/profiles/<profile-id>
```

## Advanced Usage

### Sử dụng với backend của bạn

```javascript
// Example: Node.js client
const axios = require('axios');

const API_BASE = 'http://localhost:3000/api';

async function createAndLaunchProfile(name) {
  // Create profile
  const { data: createResponse } = await axios.post(`${API_BASE}/profiles/create`, {
    name: name,
    metadata: { createdBy: 'my-app' }
  });
  
  const profileId = createResponse.data.id;
  console.log('Created profile:', profileId);
  
  // Launch browser
  const { data: openResponse } = await axios.post(`${API_BASE}/profiles/open`, {
    id: profileId,
    openFlow: true
  });
  
  console.log('Browser launched with extension:', openResponse.data.extensionId);
  
  return profileId;
}

// Usage
createAndLaunchProfile('Auto Profile 1');
```

### Quản lý Session

Extension tự động lưu session khi user đăng nhập Google Flow. Session được duy trì trong profile directory.

## Scripts hữu ích

### Tạo nhiều profiles nhanh

```batch
@echo off
REM create-profiles.bat

for /L %%i in (1,1,5) do (
  echo Creating Profile %%i...
  curl -X POST http://localhost:3000/api/profiles/create ^
    -H "Content-Type: application/json" ^
    -d "{\"name\":\"Auto Profile %%i\"}"
)
```

### Xóa tất cả profiles

```batch
@echo off
REM cleanup-profiles.bat

for /f %%i in ('curl -s http://localhost:3000/api/profiles ^| jq -r ".data[].id"') do (
  echo Deleting profile %%i...
  curl -X DELETE http://localhost:3000/api/profiles/%%i
)
```

## Next Steps

1. ✅ Test tạo và mở profile
2. ✅ Verify extension load thành công
3. ✅ Test Google Flow
4. 🔄 Tích hợp với FlowKit backend
5. 🔄 Thêm WebSocket cho real-time updates
6. 🔄 Implement authentication nếu cần

## Support

Nếu gặp vấn đề:

1. Check logs trong `logs/combined.log`
2. Đọc ARCHITECTURE.md để hiểu cách hoạt động
3. Review README.md cho API details
4. Check GitHub issues (nếu có)

---

**Chúc bạn sử dụng thành công! 🚀**
