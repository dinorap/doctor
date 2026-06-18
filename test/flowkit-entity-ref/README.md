# FlowKit Entity Reference Module

Module độc lập để **tạo reference images cho các entity** (character, location, creature, visual_asset, generic_troop, faction) qua Google Flow API.

---

## Mục lục

- [Quick Start](#quick-start)
- [Cài đặt](#cài-đặt)
- [Entity Types](#entity-types)
- [Materials](#materials)
- [API Reference](#api-reference)
- [Examples](#examples)
- [Cấu trúc thư mục](#cấu-trúc-thư-mục)

---

## Quick Start

```bash
pip install aiohttp

python -c "
import asyncio
from flow_entity_ref import EntityRefGenerator, FlowClientWrapper

async def main():
    client = FlowClientWrapper()
    # client.set_websocket(ws)       # Từ Chrome Extension
    # client.set_flow_key('...')    # Flow API key

    generator = EntityRefGenerator(client)

    result = await generator.generate_entity_ref(
        name='Hero Warrior',
        description='A brave knight in silver armor',
        entity_type='character',
        material_id='3d_pixar',
        project_id='your_project_id',
    )

    print(f'Media ID: {result.media_id}')
    print(f'URL: {result.url}')

asyncio.run(main())
```

---

## Cài đặt

```bash
# Copy folder vào project mới
cp -r flow_entity_ref/ your_new_project/

# Cài dependencies
cd your_new_project
pip install -r requirements.txt
```

---

## Entity Types

Module hỗ trợ **6 loại entity**:

| Entity Type | Mô tả | Aspect Ratio |
|-------------|--------|--------------|
| `character` | Nhân vật (người, nhân vật) | Portrait |
| `location` | Địa điểm, môi trường | Landscape |
| `creature` | Sinh vật (quái vật, thú) | Portrait |
| `visual_asset` | Vật phẩm (prop, xe, vũ khí) | Portrait |
| `generic_troop` | Quân đội, lính | Portrait |
| `faction` | Phe phái, nhóm | Portrait |

Mỗi entity type có **4-panel design sheet layout** riêng:

### Character
1. Body shots (full body, half body, three-quarter, close-up)
2. Multi-angle turnaround (front, side, back)
3. Expression sheet (emotional states)
4. Pose sheet (typical actions)

### Location
1. Master establishing shot (wide angle)
2. Alternate angle (different perspective)
3. Detail callouts (architectural details)
4. Lighting/Mood variation (different lighting conditions)

### Creature
1. Body shots (full body, close-up face/head)
2. Multi-angle turnaround (front, side, back)
3. Action/Movement poses (stance, locomotion, attack)
4. Detail callouts (claws, scales, wings)

### Visual Asset
1. Main beauty shot (three-quarter perspective)
2. Orthographic views (top, front, side)
3. Functional/Mechanical views (how it opens, moves)
4. Material/Texture detail (surface materials)

### Troop/Faction
1. Uniform turnaround (front, side, back)
2. Gear breakdown (weapons, armor, equipment)
3. Rank/Class variations (different roles)
4. Action poses (combat stance)

---

## Materials

Có **13 built-in materials**:

| Material ID | Name | Mô tả |
|-------------|------|--------|
| `realistic` | Photorealistic | Ảnh thật, Canon EOS R5 |
| `3d_pixar` | 3D Pixar | Phong cách Pixar 3D |
| `anime` | Anime | Phong cách anime Nhật |
| `ghibli` | Studio Ghibli | Phong cách Ghibli |
| `stop_motion` | Felt & Wood | Stop-motion Laika |
| `minecraft` | Minecraft | Voxel blocky style |
| `oil_painting` | Oil Painting | Tranh sơn dầu cổ điển |
| `watercolor` | Watercolor | Tranh màu nước |
| `comic_book` | Comic Book | Marvel/DC style |
| `cyberpunk` | Cyberpunk | Blade Runner aesthetic |
| `claymation` | Claymation | Wallace & Gromit |
| `lego` | LEGO | LEGO minifigure style |
| `retro_vhs` | Retro VHS | 80s VHS aesthetic |

---

## API Reference

### EntityRefGenerator

Class chính để generate reference images.

```python
from flow_entity_ref import EntityRefGenerator, FlowClientWrapper

client = FlowClientWrapper()
generator = EntityRefGenerator(client)

result = await generator.generate_entity_ref(
    name="Hero Warrior",           # Tên entity
    description="A brave knight",   # Mô tả visual
    story="Hero of the kingdom",  # Optional: context
    entity_type="character",       # Loại entity
    material_id="3d_pixar",       # Material style
    project_id="project_id",      # Flow project ID
    download_to="./output.jpg",    # Optional: save locally
)
```

**Parameters:**

| Parameter | Type | Default | Mô tả |
|-----------|------|---------|--------|
| `name` | str | **required** | Tên entity |
| `description` | str | `None` | Mô tả visual |
| `story` | str | `None` | Optional story context |
| `entity_type` | str | `"character"` | Loại entity |
| `material_id` | str | `"3d_pixar"` | Material style |
| `project_id` | str | `""` | Flow project ID |
| `user_paygate_tier` | str | `"PAYGATE_TIER_TWO"` | User tier |
| `download_to` | str | `None` | Path để save local |

**Returns:** `GenerationResult`

```python
@dataclass
class GenerationResult:
    success: bool
    media_id: Optional[str] = None   # UUID media ID
    url: Optional[str] = None        # GCS URL
    local_path: Optional[str] = None # Local file path
    error: Optional[str] = None
```

---

### Profile Builder

Build prompt mà không cần gọi API.

```python
from flow_entity_ref import build_entity_profile

profile = build_entity_profile(
    name="Hero Warrior",
    description="A brave knight in silver armor",
    story="Hero of the kingdom",
    entity_type="character",
    material_id="3d_pixar",
)

print(profile['description'])   # Full description with story
print(profile['image_prompt'])  # Complete prompt for generation
```

---

### Scene Prompt Builder

Build prompt cho scene images.

```python
from flow_entity_ref import build_scene_prompt

prompt = build_scene_prompt(
    scene_description="A hero stands on a mountain",
    material_id="3d_pixar",
)
```

---

### Materials API

```python
from flow_entity_ref import get_material, list_materials, register_material

# Get single material
mat = get_material("3d_pixar")
print(mat['style_instruction'])

# List all materials
for m in list_materials():
    print(f"{m['id']}: {m['name']}")

# Register custom material
register_material({
    "id": "my_custom",
    "name": "My Custom Style",
    "style_instruction": "...",
    "negative_prompt": "...",
    "scene_prefix": "...",
    "lighting": "...",
})
```

---

### Composition API

```python
from flow_entity_ref import get_aspect_ratio, get_composition, ENTITY_TYPES

# Get aspect ratio for entity type
ratio = get_aspect_ratio("location")  # "IMAGE_ASPECT_RATIO_LANDSCAPE"
ratio = get_aspect_ratio("character") # "IMAGE_ASPECT_RATIO_PORTRAIT"

# Get composition guidelines
comp = get_composition("character")

# List all entity types
print(ENTITY_TYPES)
```

---

## Examples

### Generate Character Reference

```python
result = await generator.generate_entity_ref(
    name="Hero Warrior",
    description="A brave knight in gleaming silver armor",
    entity_type="character",
    material_id="3d_pixar",
    project_id=project_id,
    download_to="./output/hero.jpg",
)

if result.success:
    print(f"Generated: {result.media_id}")
```

### Generate Location Reference

```python
result = await generator.generate_entity_ref(
    name="Enchanted Forest",
    description="Mystical forest with ancient trees and glowing mushrooms",
    entity_type="location",
    material_id="3d_pixar",
    project_id=project_id,
)
```

### Generate with Different Materials

```python
# Anime style
result = await generator.generate_entity_ref(
    name="Ninja",
    entity_type="character",
    material_id="anime",
    ...
)

# Realistic
result = await generator.generate_entity_ref(
    name="Realistic Hero",
    entity_type="character",
    material_id="realistic",
    ...
)

# Ghibli
result = await generator.generate_entity_ref(
    name="Ghibli Character",
    entity_type="character",
    material_id="ghibli",
    ...
)
```

### Complete Workflow Example

```python
import asyncio
from flow_entity_ref import EntityRefGenerator, FlowClientWrapper

async def main():
    client = FlowClientWrapper()
    generator = EntityRefGenerator(client)

    # Generate multiple entities for a project
    entities = [
        {"name": "Hero", "type": "character", "desc": "The main protagonist"},
        {"name": "Villain", "type": "character", "desc": "The dark lord"},
        {"name": "Castle", "type": "location", "desc": "An ancient castle on a cliff"},
        {"name": "Dragon", "type": "creature", "desc": "A fearsome fire dragon"},
    ]

    results = []
    for e in entities:
        result = await generator.generate_entity_ref(
            name=e["name"],
            description=e["desc"],
            entity_type=e["type"],
            material_id="3d_pixar",
            project_id="my_project",
        )
        results.append((e["name"], result))

    # Print summary
    print("\n=== Generation Summary ===")
    for name, result in results:
        if result.success:
            print(f"✓ {name}: {result.media_id}")
        else:
            print(f"✗ {name}: {result.error}")

asyncio.run(main())
```

---

## Cấu trúc thư mục

```
flowkit-entity-ref/
├── README.md                        # File này
├── requirements.txt                 # Dependencies
├── example_usage.py                 # Full usage example
│
└── flow_entity_ref/                 # Package chính
    ├── __init__.py                 # Exports
    ├── materials.py                # 13 built-in materials
    ├── composition.py              # Entity types + composition guidelines
    ├── profile_builder.py           # Prompt building logic
    ├── entity_ref_generator.py      # Main generator class
    ├── flow_client_wrapper.py       # WebSocket client
    ├── media_downloader.py          # Download utilities
    └── parsing.py                   # Response parsing
```

---

## Notes

- Tất cả methods đều là `async/await`
- `FlowClientWrapper` cần WebSocket connection từ Chrome Extension
- Module không phụ thuộc vào phần còn lại của FlowKit
- **media_id luôn ở format UUID** (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`)
- URL từ Flow API sẽ hết hạn sau ~1 giờ

---

## Troubleshooting

### "Flow client not connected"
Đảm bảo:
1. Chrome Extension đã được bật và kết nối
2. `client.set_websocket(ws)` đã được gọi
3. `client.set_flow_key("...")` đã được gọi

### "Unknown material"
Kiểm tra `material_id` có trong danh sách 13 materials không.

### Image generation failed
- Kiểm tra Flow API key có hợp lệ không
- Kiểm tra user có đủ credits không
- Kiểm tra project ID có tồn tại không

---

## License

Same as FlowKit project.
