# Hướng Dẫn Tạo Project Chromium Profile Manager

## Bước 1: Khởi tạo project

```bash
# Tạo thư mục project
mkdir chromium-profile-manager
cd chromium-profile-manager

# Khởi tạo npm project
npm init -y
```

## Bước 2: Cài đặt dependencies

```bash
# Dependencies chính
npm install express playwright cors winston uuid better-sqlite3

# Dev dependencies
npm install -D typescript @types/node @types/express @types/cors tsx @types/better-sqlite3
```

## Bước 3: Tạo tsconfig.json

```json
{
    "compilerOptions": {
        "target": "ES2022",
        "module": "commonjs",
        "lib": ["ES2022", "DOM"],
        "outDir": "./dist",
        "rootDir": "./src",
        "strict": true,
        "esModuleInterop": true,
        "skipLibCheck": true,
        "forceConsistentCasingInFileNames": true,
        "resolveJsonModule": true,
        "moduleResolution": "node",
        "declaration": true,
        "declarationMap": true,
        "sourceMap": true,
        "noUnusedLocals": false,
        "noUnusedParameters": false,
        "noImplicitReturns": false,
        "noFallthroughCasesInSwitch": true
    },
    "include": ["src/**/*"],
    "exclude": ["node_modules", "dist"]
}
```

## Bước 4: Cập nhật package.json scripts

```json
{
  "scripts": {
    "dev": "tsx watch src/main.ts",
    "build": "tsc",
    "start": "node dist/main.js"
  }
}
```

## Bước 5: Tạo cấu trúc thư mục

```
src/
├── types/           # TypeScript interfaces
├── config/          # Configuration
├── utils/           # Utilities (logger)
├── profile-manager/ # Profile management
├── browser-manager/ # Browser lifecycle
├── extension-loader/# Extension loading
├── flow-session/    # Session management
├── api/             # REST API routes
└── main.ts          # Entry point
```

## Bước 6: Cài đặt Playwright browsers

```bash
npx playwright install chromium
```

## Bước 7: Chạy project

```bash
# Development mode
npm run dev

# Production mode
npm run build
npm start
```

## API Endpoints

Server chạy tại `http://localhost:3000`

- `GET /api/health` - Health check
- `GET /api/profiles` - Lấy danh sách profiles
- `POST /api/profiles/create` - Tạo profile mới
- `POST /api/profiles/open` - Mở browser với profile
- `POST /api/profiles/:id/close` - Đóng browser
- `DELETE /api/profiles/:id` - Xóa profile
- `GET /api/sessions` - Lấy danh sách sessions đang chạy

## Cấu trúc Project Đầy Đủ

Xem các file sau để hiểu rõ hơn về kiến trúc:
- `ARCHITECTURE.md` - Kiến trúc tổng quan
- `README.md` - Hướng dẫn sử dụng (English)
- `HUONG_DAN_SU_DUNG.md` - Hướng dẫn chi tiết (Tiếng Việt)
- `QUICKSTART.md` - Quick start guide
