2. Ví dụ sử dụng
from gemini_script import generate_script
# ── Reskin từ YouTube URL ──
data, err = generate_script(
    prompt_id="youtube-url",
    system_instruction="Bạn là AI biên kịch video...",
    response_schema={
        "type": "object",
        "required": ["meta", "character_profiles", "scenes"],
        "properties": {
            "meta": {"type": "object", "properties": {
                "total_scenes": {"type": "integer"},
                "total_duration": {"type": "string"},
            }},
            "character_profiles": {"type": "array", "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "visual_signature": {"type": "string"},
                }
            }},
            "scenes": {"type": "array", "items": {
                "type": "object",
                "properties": {
                    "scene_id": {"type": "integer"},
                    "image_prompt": {"type": "string"},
                    "tts_script": {"type": "string"},
                }
            }},
        },
    },
    language="vi",
    duration=60,
    youtube_url="https://youtube.com/...",
    api_key="YOUR_API_KEY_HERE",
    gemini_model="gemini-2.5-flash",
)
# ── Tự do từ topic ──
data, err = generate_script(
    prompt_id="topic-creative",
    system_instruction="Bạn là AI biên kịch...",
    response_schema={...},
    language="vi",
    duration=60,
    topic="Câu chuyện về người đàn ông mất tích",
    api_key="YOUR_API_KEY_HERE",
)
3. Phụ thuộc
pip install google-genai
Tóm tắt những gì tách ra
Thành phần	Mô tả
normalize_model()
Chuẩn hóa tên model (5 model + alias)
_split_key_string()
Tách nhiều key từ string
get_gemini_api_keys()
Lấy keys ưu tiên active
parse_json_output()
Bóc JSON từ Gemini output
upload_files_to_gemini()
Upload file + đợi ACTIVE
_call_single()
Gọi Gemini với 1 key
call_gemini_generate()
Wrapper có retry khi quá tải
generate_script()
Entry point chính cho dự án mới
Bạn chỉ cần thay get_gemini_api_keys() bằng cách đọc settings file/env của dự án mới là chạy được ngay.