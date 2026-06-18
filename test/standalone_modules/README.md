# Standalone Test Modules

Các file test độc lập để kiểm tra từng module của hệ thống.

## � Danh sách Tests

### 1. test-database.ts
Test các chức năng CRUD của DatabaseManager:
- ✅ Create/Read/Update/Delete profiles
- ✅ Create/Read/Update/Delete sessions  
- ✅ CASCADE delete (xóa profile → xóa sessions)
- ✅ Relationship giữa profiles và sessions

**Chạy test:**
```bash
cd standalone_modules
npx ts-node test-database.ts
```

### 2. test-profile-manager.ts
Test ProfileManager module:
- ✅ Create profile với/không metadata
- ✅ Get profile by ID
- ✅ List all profiles
- ✅ Update profile (touch)
- ✅ Delete profile

**Chạy test:**
```bash
cd standalone_modules
npx ts-node test-profile-manager.ts
```

### 3. test-browser-manager.ts
Test BrowserManager module:
- ✅ Launch browser với extension
- ✅ Check active sessions
- ✅ Create new pages
- ✅ Get all pages
- ✅ Close browser
- ✅ Auto cleanup khi browser đóng thủ công

**Chạy test:**
```bash
cd standalone_modules
npx ts-node test-browser-manager.ts
```

### 4. test-flow-session.ts
Test FlowSession module:
- ✅ Open Google Flow
- ✅ Save session (cookies, localStorage, sessionStorage)
- ✅ Close và reopen browser
- ✅ Restore session
- ✅ Clear session
- ✅ Deactivate session

**Chạy test:**
```bash
cd standalone_modules
npx ts-node test-flow-session.ts
```

### 5. test-api-endpoints.ts
Test REST API endpoints:
- ✅ Health check
- ✅ List profiles
- ✅ Create profile
- ✅ Open profile
- ✅ Close profile
- ✅ Delete profile

**Chạy test:**
```bash
# Terminal 1: Start server
npm start

# Terminal 2: Run test
cd standalone_modules
npx ts-node test-api-endpoints.ts
```

### 6. test-flow-create-project.ts
Test tạo project trong Google Flow:
- ✅ Create profile và restore session
- ✅ Open Google Flow
- ✅ Check login status
- ✅ Look for create project button
- ✅ Fill in project details
- ✅ Submit project creation
- ✅ Verify và save session

**Chạy test:**
```bash
cd standalone_modules
npx ts-node test-flow-create-project.ts
```

### 7. test-flow-upload-image.ts
Test upload ảnh vào Google Flow:
- ✅ Create profile và restore session
- ✅ Open Google Flow
- ✅ Navigate to project
- ✅ Look for upload button
- ✅ Upload test image
- ✅ Verify upload success
- ✅ Save session

**Chạy test:**
```bash
cd standalone_modules
npx ts-node test-flow-upload-image.ts
```

**Lưu ý:** Test sẽ tạo file `test-image.png` nếu chưa có (cần `canvas` package)

### 8. test-flow-generate-image.ts
Test generate ảnh AI trong Google Flow:
- ✅ Create profile và restore session
- ✅ Open Google Flow
- ✅ Navigate to generation feature
- ✅ Look for prompt input
- ✅ Enter generation prompt
- ✅ Wait for AI generation
- ✅ Verify và save session

**Chạy test:**
```bash
cd standalone_modules
npx ts-node test-flow-generate-image.ts
```

## � Chạy Tất Cả Tests

```bash
# Cài dependencies (nếu chưa có)
npm install

# Build project trước
npm run build

# Chạy từng test
cd standalone_modules
npx ts-node test-database.ts
npx ts-node test-profile-manager.ts
npx ts-node test-browser-manager.ts
npx ts-node test-flow-session.ts

# API test (cần server chạy)
npm start  # Terminal 1
npx ts-node standalone_modules/test-api-endpoints.ts  # Terminal 2
```

## � Test Data

Các test sẽ tự động:
- Tạo test databases trong `data/test_*.db`
- Tạo test profiles trong `data/profiles-test/`
- Cleanup sau khi test xong

## ⚠️ Lưu Ý

1. **Browser Tests** (test-browser-manager, test-flow-session):
   - Cần Chromium được cài bởi Playwright
   - Browser sẽ mở và đóng tự động
   - Có thể quan sát browser trong quá trình test

2. **API Tests** (test-api-endpoints):
   - Cần server đang chạy trên port 3000
   - Test qua HTTP requests thực tế

3. **Database Tests**:
   - Sử dụng test databases riêng
   - Không ảnh hưởng database chính

## 🐛 Debugging

Nếu test fail, kiểm tra:
- [ ] Dependencies đã cài đầy đủ: `npm install`
- [ ] Project đã build: `npm run build`  
- [ ] Extension folder tồn tại: `extension/`
- [ ] Port 3000 không bị chiếm (cho API tests)
- [ ] Playwright browsers đã cài: `npx playwright install chromium`

## 📊 Test Coverage

| Module | Tests | Status |
|--------|-------|--------|
| Database | 11 | ✅ |
| ProfileManager | 8 | ✅ |
| BrowserManager | 10 | ✅ |
| FlowSession | 11 | ✅ |
| API Endpoints | 6 | ✅ |
| Flow Create Project | 11 | ✅ |
| Flow Upload Image | 10 | ✅ |
| Flow Generate Image | 11 | ✅ |

**Total: 78 test cases**

## 🎯 Google Flow Tests

Các test mới cho Google Flow operations:

1. **test-flow-create-project.ts** - Tự động tạo project trong Flow
2. **test-flow-upload-image.ts** - Tự động upload ảnh vào project
3. **test-flow-generate-image.ts** - Tự động generate ảnh bằng AI

**Lưu ý khi chạy Flow tests:**
- Cần login Google Flow lần đầu (test sẽ đợi 60s)
- Session sẽ được lưu và restore cho lần sau
- Browser sẽ mở non-headless để load extension
- Screenshots được lưu trong `standalone_modules/` để debug
