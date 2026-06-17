# Google Flow Tests Guide

Hướng dẫn sử dụng các test tự động cho Google Flow operations.

## 📋 Tổng Quan

Ba test files mới được tạo để tự động hóa các thao tác chính trong Google Flow:

1. **test-flow-create-project.ts** - Tạo project mới
2. **test-flow-upload-image.ts** - Upload ảnh vào project
3. **test-flow-generate-image.ts** - Generate ảnh bằng AI

## 🚀 Quick Start

### Bước 1: Build Project

```bash
npm run build
```

### Bước 2: Chạy Test Lần Đầu (Login)

Lần đầu chạy, bạn cần login Google Flow:

```bash
cd standalone_modules
npx ts-node test-flow-create-project.ts
```

- Browser sẽ mở Google Flow
- Đợi 60 giây để login thủ công
- Session sẽ được lưu tự động
- Các lần sau sẽ restore session, không cần login lại

### Bước 3: Chạy Các Tests

```bash
# Test tạo project
npx ts-node test-flow-create-project.ts

# Test upload ảnh
npx ts-node test-flow-upload-image.ts

# Test generate ảnh AI
npx ts-node test-flow-generate-image.ts
```

## 📝 Chi Tiết Từng Test

### 1. test-flow-create-project.ts

**Chức năng:**
- Tự động tìm nút "Create project" / "New project"
- Điền tên project (auto-generated với timestamp)
- Submit form và verify project được tạo
- Lưu session sau khi hoàn thành

**Output:**
- Screenshots: `flow-create-project-page.png`, `flow-project-created.png`
- Test database: `data/test_flow_create_project.db`
- Profile directory: `data/profiles-test-flow-create/`

**Khi nào dùng:**
- Test workflow tạo project mới
- Verify UI của project creation flow
- Debug project creation issues

### 2. test-flow-upload-image.ts

**Chức năng:**
- Tự động tạo test image (800x600 PNG với text)
- Tìm nút upload hoặc file input
- Upload ảnh test vào Flow
- Verify upload thành công

**Output:**
- Test image: `standalone_modules/test-image.png`
- Screenshots: `flow-projects-page.png`, `flow-after-upload.png`, `flow-upload-complete.png`
- Test database: `data/test_flow_upload_image.db`

**Requirements:**
- Package `canvas` (optional, để tạo test image)
- Nếu không có canvas, đặt ảnh test tại `standalone_modules/test-image.png`

**Khi nào dùng:**
- Test upload functionality
- Verify file input handling
- Test với different image formats

### 3. test-flow-generate-image.ts

**Chức năng:**
- Tìm image generation feature trong Flow
- Điền prompt: "A beautiful sunset over mountains, digital art"
- Trigger AI generation
- Đợi và verify kết quả

**Output:**
- Screenshots: `flow-generate-start.png`, `flow-generate-progress.png`, `flow-generate-complete.png`
- Test database: `data/test_flow_generate_image.db`

**Khi nào dùng:**
- Test AI generation workflow
- Verify generation UI
- Debug generation issues
- Test với different prompts

## 🎯 Workflow Tự Động

Các tests hoạt động theo flow:

```
1. Create Profile
   ↓
2. Launch Browser (with Extension)
   ↓
3. Restore Session (if exists)
   ↓
4. Open Google Flow
   ↓
5. Check Login Status
   ↓
6. Perform Operation (create/upload/generate)
   ↓
7. Verify Result (screenshots)
   ↓
8. Save Session
   ↓
9. Close Browser
   ↓
10. Cleanup
```

## 🔧 Customization

### Thay Đổi Test Prompts

Edit file `test-flow-generate-image.ts`:

```typescript
const testPrompt = 'Your custom prompt here';
```

### Thay Đổi Test Image

Đặt ảnh của bạn tại:
```
standalone_modules/test-image.png
```

### Thay Đổi Timeouts

Tìm và sửa các `waitForTimeout()`:

```typescript
await page.waitForTimeout(5000); // Đổi 5000 thành giá trị khác (ms)
```

## 📸 Screenshots

Mỗi test tạo screenshots tại các bước quan trọng:

- **Before**: Initial page state
- **During**: Action in progress
- **After**: Final result

Screenshots lưu trong `standalone_modules/` để dễ debug.

## 🐛 Troubleshooting

### Test Fail: "Could not find button"

**Nguyên nhân:** Google Flow UI thay đổi, selectors không match

**Giải pháp:**
1. Check screenshots để xem UI hiện tại
2. Update selectors trong test file:

```typescript
const createProjectSelectors = [
    'button:has-text("New project")',
    'your-new-selector-here',  // Thêm selector mới
];
```

### Test Fail: "Not logged in"

**Nguyên nhân:** Session expired hoặc chưa login

**Giải pháp:**
1. Chạy test lại
2. Đợi 60 giây và login thủ công
3. Session sẽ được lưu tự động

### Test Fail: "Upload button not found"

**Nguyên nhân:** Chưa navigate đến đúng project

**Giải pháp:**
1. Check screenshot `flow-projects-page.png`
2. Thủ công navigate đến project trong 30s timeout
3. Test sẽ tiếp tục

### Browser Không Đóng

**Nguyên nhân:** Test crashed trước khi cleanup

**Giải pháp:**
```bash
# Kill tất cả Chromium processes
taskkill /F /IM chrome.exe
```

## 💡 Tips

### Chạy Test Nhiều Lần

Session được persist, nên các lần sau chạy nhanh hơn:

```bash
# Lần 1: ~2-3 phút (có login)
# Lần 2+: ~30-60 giây (restore session)
```

### Debug Mode

Tăng timeout để có thời gian inspect:

```typescript
// Tại cuối test, trước khi close browser
await page.waitForTimeout(60000); // Đợi 60 giây
```

### Run Tests in Sequence

```bash
# Run all Flow tests
npx ts-node test-flow-create-project.ts && \
npx ts-node test-flow-upload-image.ts && \
npx ts-node test-flow-generate-image.ts
```

### Clean Test Data

```bash
# Xóa tất cả test data
rm -rf data/test_flow_*.db
rm -rf data/profiles-test-flow-*
rm standalone_modules/*.png
```

## 📊 Test Results

Mỗi test báo cáo kết quả:

```
═══════════════════════════════════════
📊 Test Summary
═══════════════════════════════════════
✅ Passed: 11
❌ Failed: 0
📈 Total:  11
═══════════════════════════════════════

🎉 All tests passed!
```

## 🔐 Security Notes

- Sessions được lưu trong SQLite database
- Cookies, localStorage, sessionStorage được encrypt (optional)
- Profile directories chỉ accessible locally
- Không commit session data vào Git

## 📚 Related Files

- `src/flow-session/FlowSession.ts` - Session management logic
- `src/browser-manager/BrowserManager.ts` - Browser control
- `src/profile-manager/ProfileManager.ts` - Profile management
- `standalone_modules/README.md` - All tests documentation

## 🎓 Học Thêm

Tham khảo các test khác:

```bash
# Core functionality tests
npx ts-node test-database.ts
npx ts-node test-profile-manager.ts
npx ts-node test-browser-manager.ts
npx ts-node test-flow-session.ts
```

---

**Tạo bởi:** Chromium Profile Manager
**Version:** 1.0.0
**Last Updated:** 2026-06-15
