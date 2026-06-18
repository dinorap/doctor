# FlowKit Standalone Modules

Các Python modules độc lập để tương tác với Google Flow API. Bạn có thể copy các modules này sang dự án khác để sử dụng mà không cần phụ thuộc vào toàn bộ FlowKit codebase.

## 📦 Modules

### 1. FlowClientWrapper - Base Client

WebSocket client wrapper cho Google Flow API.

**File:** `flow_client_wrapper.py`

**Features:**
- WebSocket communication với Chrome Extension
- Request/response pattern với pending futures
- Built-in timeout handling
- Support tất cả Flow API methods

**Usage:**
```python
from flow_client_wrapper import FlowClientWrapper

client = FlowClientWrapper()
# client.set_websocket(ws)  # Set từ Chrome Extension
# client.set_flow_key("your_flow_key")
```

---

### 2. FlowProjectCreator - Create Projects

Tạo project trên Google Flow với optional database persistence.

**File:** `flow_project_creator.py`

**Features:**
- Tạo project trên Google Flow
- Auto-detect user paygate tier
- Optional database adapter cho local storage
- Support tạo characters kèm theo

**Usage:**
```python
from flow_client_wrapper import FlowClientWrapper
from flow_project_creator import FlowProjectCreator

client = FlowClientWrapper()
creator = FlowProjectCreator(client, db_adapter=None)

project = await creator.create_project(
    name="My Project",
    description="Project description",
    story="Full story content",
    material="3d_pixar",
    characters=[
        {"name": "Alice", "description": "Main character"},
    ]
)
```

See `examples/example_create_project.py` for complete example.

---

### 3. FlowImageGenerator - Generate Images

Generate ảnh qua Google Flow API với auto-download support.

**File:** `flow_image_generator.py`

**Features:**
- Generate ảnh từ text prompt
- Support character reference (media IDs)
- Auto-download ảnh về local (optional)
- Aspect ratio support (Portrait/Landscape/Square)

**Usage:**
```python
from flow_client_wrapper import FlowClientWrapper
from flow_image_generator import FlowImageGenerator

client = FlowClientWrapper()
generator = FlowImageGenerator(client)

result = await generator.generate_image(
    prompt="A beautiful sunset over mountains",
    project_id="your_project_id",
    aspect_ratio="LANDSCAPE",
    download_to="./output.jpg",  # Optional
)

print(f"Media ID: {result['media_id']}")
print(f"URL: {result['url']}")
```

See `examples/example_generate_image.py` for complete example.

---

### 4. FlowImageUploader - Upload Images

Upload local images lên Google Flow.

**File:** `flow_image_uploader.py`

**Features:**
- Upload ảnh từ local filesystem
- Auto-detect MIME type
- Base64 encoding tự động

**Usage:**
```python
from flow_client_wrapper import FlowClientWrapper
from flow_image_uploader import FlowImageUploader

client = FlowClientWrapper()
uploader = FlowImageUploader(client)

result = await uploader.upload_image(
    file_path="./my_image.jpg",
    project_id="your_project_id",
    file_name="custom_name.jpg",  # Optional
)

print(f"Media ID: {result['media_id']}")
print(f"URL: {result['url']}")
```

See `examples/example_upload_image.py` for complete example.

---

### 5. FlowVideoGenerator - Generate Videos

Generate videos từ images với polling support.

**File:** `flow_video_generator.py`

**Features:**
- Generate video từ start/end images
- Camera movement prompts
- Auto-polling cho completion (optional)
- Manual status checking support

**Usage:**
```python
from flow_client_wrapper import FlowClientWrapper
from flow_video_generator import FlowVideoGenerator

client = FlowClientWrapper()
generator = FlowVideoGenerator(client)

# Option A: Wait for completion
result = await generator.generate_video(
    start_image_media_id="your_image_id",
    prompt="Camera zooms in slowly",
    project_id="your_project_id",
    scene_id="scene_1",
    aspect_ratio="PORTRAIT",
    wait_for_completion=True,
    poll_interval=10,
)

print(f"Media ID: {result['media_id']}")
print(f"URL: {result['url']}")

# Option B: Submit and check later
result = await generator.generate_video(
    start_image_media_id="your_image_id",
    prompt="Camera pans right",
    project_id="your_project_id",
    scene_id="scene_1",
    wait_for_completion=False,
)

operations = result['operations']
# Check status later
status = await generator.check_status(operations)
```

See `examples/example_generate_video.py` for complete example.

---

## 🚀 Installation

### Option 1: Copy modules individually
```bash
cp flow_client_wrapper.py your_project/
cp flow_project_creator.py your_project/
# Copy other modules as needed
```

### Option 2: Copy entire package
```bash
cp -r standalone_modules/ your_project/
```

### Install dependencies
```bash
cd standalone_modules
pip install -r requirements.txt
```

**Dependencies:**
- `aiohttp>=3.8.0` (only for image downloads)

---

## 📚 Examples

Check out the `examples/` directory for complete working examples:

- **`example_create_project.py`** - Tạo project với characters
- **`example_generate_image.py`** - Generate và download ảnh
- **`example_upload_image.py`** - Upload ảnh local
- **`example_generate_video.py`** - Generate video với polling
- **`example_full_workflow.py`** - Complete workflow: Project → Image → Video
- **`example_with_database.py`** - Tích hợp với database adapter

### Running Examples

```bash
cd standalone_modules/examples
python example_create_project.py
```

**Note:** Examples cần WebSocket connection và Flow API key để chạy. Xem phần Integration bên dưới.

---

## 🔌 Integration with WebSocket

Các modules này cần WebSocket connection tới Chrome Extension để giao tiếp với Google Flow API.

Example setup with aiohttp:

```python
from aiohttp import web
import aiohttp
import json

app = web.Application()
client = FlowClientWrapper()

async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)
    
    # Set WebSocket và Flow key
    client.set_websocket(ws)
    client.set_flow_key("your_flow_key_from_extension")
    
    async for msg in ws:
        if msg.type == aiohttp.WSMsgType.TEXT:
            data = json.loads(msg.data)
            await client.handle_response(data)
    
    return ws

app.router.add_get('/ws', websocket_handler)
web.run_app(app, port=8000)
```

---

## 📦 Package Import

You can also import from the package:

```python
from standalone_modules import (
    FlowClientWrapper,
    FlowProjectCreator,
    FlowImageGenerator,
    FlowImageUploader,
    FlowVideoGenerator,
)
```

---

## 🗂️ File Structure

```
standalone_modules/
├── README.md                      # This file
├── requirements.txt               # Python dependencies
├── __init__.py                    # Package exports
│
├── flow_client_wrapper.py         # Base WebSocket client
├── flow_project_creator.py        # Project creation
├── flow_image_generator.py        # Image generation
├── flow_image_uploader.py         # Image upload
├── flow_video_generator.py        # Video generation
│
└── examples/                      # Usage examples
    ├── example_create_project.py
    ├── example_generate_image.py
    ├── example_upload_image.py
    ├── example_generate_video.py
    ├── example_full_workflow.py
    └── example_with_database.py
```

---

## 📝 Notes

- ✅ Tất cả modules đều async/await
- ✅ FlowClientWrapper cần WebSocket connection từ Chrome Extension
- ✅ FlowProjectCreator có thể hoạt động với hoặc không có database adapter
- ✅ FlowImageGenerator tự động download ảnh nếu được yêu cầu
- ✅ FlowVideoGenerator hỗ trợ polling tự động hoặc manual status checking
- ✅ Minimal dependencies: chỉ cần `aiohttp` cho image downloads
- ✅ No FlowKit dependencies - hoàn toàn standalone

---

## 🎯 Use Cases

1. **Tạo tool riêng** - Copy modules để build công cụ riêng tương tác với Flow API
2. **Integration vào app khác** - Thêm Flow capabilities vào existing apps
3. **Automation scripts** - Tạo scripts tự động generate content
4. **Custom workflows** - Build custom pipelines cho video production
5. **Testing & prototyping** - Rapid prototyping với Flow API

---

## 🤝 Database Adapter

`FlowProjectCreator` support optional database adapter. Adapter cần implement 3 methods:

```python
class YourDBAdapter:
    async def save_project(self, project_data: dict):
        """Save project to database."""
        pass
    
    async def save_character(self, character_data: dict) -> str:
        """Save character, return character ID."""
        pass
    
    async def link_character(self, project_id: str, character_id: str):
        """Link character to project."""
        pass
```

Xem `examples/example_with_database.py` cho implementation example.

---

## 📄 License

Same as FlowKit project.
