# SQLite Migration - Chromium Profile Manager

## Tổng quan / Overview

Dự án đã được nâng cấp để sử dụng **SQLite database** thay vì lưu trữ JSON cục bộ. Extension folder đã được copy vào project để tự quản lý.

The project has been upgraded to use **SQLite database** instead of local JSON storage. The extension folder has been copied into the project for self-management.

## Thay đổi chính / Major Changes

### 1. ✅ Extension được copy vào project
- **Trước (Before)**: Extension ở `D:\FreeLand\agent-flowkit\extension`
- **Sau (After)**: Extension ở `D:\FreeLand\chromium-profile-manager\extension`
- Config đã được cập nhật để trỏ đến extension folder nội bộ

### 2. ✅ SQLite Database thay thế JSON file storage
- **Thư viện**: `better-sqlite3`
- **Database file**: `data/profiles.db`
- **Tables**: 
  - `profiles` - Lưu thông tin profiles
  - `sessions` - Lưu cookies, localStorage, sessionStorage

### 3. ✅ Flow Session Management nâng cấp
Tự động lưu và khôi phục phiên đăng nhập Google Flow:
- **Cookies**: Tất cả cookies từ browser context
- **localStorage**: Tất cả key-value pairs
- **sessionStorage**: Tất cả key-value pairs
- **Timestamp**: Thời gian lưu/cập nhật

## Cấu trúc Database / Database Structure

### Table: profiles
```sql
CREATE TABLE profiles (
    id TEXT PRIMARY KEY,              -- UUID
    name TEXT NOT NULL,               -- Tên profile
    profilePath TEXT NOT NULL,        -- Đường dẫn thư mục profile
    metadata TEXT DEFAULT '{}',       -- JSON metadata
    createdAt TEXT NOT NULL,          -- Thời gian tạo (ISO 8601)
    updatedAt TEXT NOT NULL           -- Thời gian cập nhật (ISO 8601)
)
```

### Table: sessions
```sql
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,              -- UUID
    profileId TEXT NOT NULL,          -- Foreign key -> profiles.id
    cookies TEXT DEFAULT '[]',        -- JSON array of cookies
    localStorage TEXT DEFAULT '{}',   -- JSON object localStorage
    sessionStorage TEXT DEFAULT '{}', -- JSON object sessionStorage
    isActive INTEGER DEFAULT 0,       -- 0 = inactive, 1 = active
    createdAt TEXT NOT NULL,          -- Thời gian tạo
    updatedAt TEXT NOT NULL,          -- Thời gian cập nhật
    FOREIGN KEY (profileId) REFERENCES profiles(id) ON DELETE CASCADE
)
```

## API Endpoints mới / New API Endpoints

### Session Management APIs

#### 1. GET `/api/sessions/:profileId`
Lấy thông tin session của một profile cụ thể.

**Response:**
```json
{
  "success": true,
  "data": {
    "isActive": true,
    "extensionId": "mebbaklphoadjengbppndielbjcbnlbc",
    "savedSession": {
      "hasCookies": true,
      "hasLocalStorage": true,
      "hasSessionStorage": true,
      "lastSaved": "2026-06-15T11:30:00.000Z"
    }
  }
}
```

#### 2. POST `/api/sessions/:profileId/save`
Lưu session thủ công cho một profile đang mở.

**Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "uuid-here"
  },
  "message": "Session saved successfully"
}
```

## Workflow Flow Session / Flow Session Workflow

### Khi mở profile với Flow (`openFlow: true`):

1. **Khởi động browser** với profile đã chọn
2. **Mở Google Flow URL**: `https://labs.google/fx/tools/flow`
3. **Khôi phục session** (nếu có):
   - Restore cookies từ database
   - Restore localStorage từ database  
   - Restore sessionStorage từ database
   - Reload page để áp dụng
4. **Tự động lưu session** sau 30 giây (cho phép user đăng nhập)
5. **Lưu session khi đóng browser**:
   - Tự động lưu cookies, localStorage, sessionStorage
   - Đánh dấu session là inactive

### API Example:

```bash
# Mở profile với Flow session restoration
curl -X POST http://localhost:3000/api/profiles/open \
  -H "Content-Type: application/json" \
  -d '{
    "id": "profile-uuid",
    "openFlow": true
  }'

# Kiểm tra session info
curl http://localhost:3000/api/sessions/profile-uuid

# Lưu session thủ công
curl -X POST http://localhost:3000/api/sessions/profile-uuid/save
```

## File Structure

```
chromium-profile-manager/
├── extension/                    # ✨ NEW: Chrome extension (copied)
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   └── ...
├── data/                         # ✨ NEW: Database folder
│   └── profiles.db              # SQLite database
├── src/
│   ├── database/                # ✨ NEW: Database module
│   │   └── Database.ts
│   ├── profile-manager/         # ✅ Updated to use DB
│   │   └── ProfileManager.ts
│   ├── browser-manager/         # ✅ Updated to use DB
│   │   └── BrowserManager.ts
│   ├── flow-session/            # ✅ Updated to use DB
│   │   └── FlowSession.ts
│   ├── api/                     # ✅ Updated routes
│   │   └── routes.ts
│   └── main.ts                  # ✅ Initialize DB
└── ...
```

## Migration Benefits / Lợi ích

### 1. **Hiệu suất tốt hơn / Better Performance**
- Truy vấn nhanh với indexes
- Atomic transactions
- Concurrent access support

### 2. **Data Integrity**
- Foreign key constraints
- CASCADE delete (xóa profile → xóa sessions)
- ACID compliance

### 3. **Session Persistence**
- Lưu trữ đầy đủ cookies, localStorage, sessionStorage
- Tự động restore khi mở lại browser
- Không cần đăng nhập lại Google Flow

### 4. **Self-contained Extension**
- Không phụ thuộc vào project khác
- Dễ deploy và distribute
- Version control cho extension

## Testing

### 1. Build project:
```bash
npm run build
```

### 2. Start server:
```bash
npm run dev
```

### 3. Test Flow Session:
```bash
# Create profile
curl -X POST http://localhost:3000/api/profiles/create \
  -H "Content-Type: application/json" \
  -d '{"name": "Test Profile"}'

# Open with Flow (will restore session if exists)
curl -X POST http://localhost:3000/api/profiles/open \
  -H "Content-Type: application/json" \
  -d '{"id": "YOUR_PROFILE_ID", "openFlow": true}'

# Đăng nhập Google Flow trong browser
# Session sẽ tự động lưu sau 30 giây

# Đóng browser
curl -X POST http://localhost:3000/api/profiles/YOUR_PROFILE_ID/close

# Mở lại - session sẽ được restore!
curl -X POST http://localhost:3000/api/profiles/open \
  -H "Content-Type: application/json" \
  -d '{"id": "YOUR_PROFILE_ID", "openFlow": true}'
```

## Notes

- Database file tự động tạo khi server khởi động lần đầu
- Sessions được lưu trong SQLite, an toàn và persist
- Có thể backup database bằng cách copy file `data/profiles.db`
- Extension ID: `mebbaklphoadjengbppndielbjcbnlbc` (được phát hiện tự động)

---

**Date**: 2026-06-15  
**Status**: ✅ Completed and Tested
