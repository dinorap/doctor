"""
gemini_script.py
Tách từ tool_youtube - sinh kịch bản bằng Gemini API.
Dùng chung: google-genai, json, pathlib.
"""

import json
import re
import time
import mimetypes
from pathlib import Path
from typing import Any, Optional, Dict, List, Tuple

# ─── Gemini Import (websockets shim) ────────────────────────────────────────────
_GENAI_IMPORT_ERROR = ""
try:
    import importlib
    try:
        importlib.import_module("websockets.client")
    except Exception:
        for candidate in ("websockets.asyncio.client", "websockets.legacy.client"):
            try:
                sys.modules["websockets.client"] = importlib.import_module(candidate)
                break
            except Exception:
                continue
    genai = importlib.import_module("google.genai")
    types = importlib.import_module("google.genai.types")
except Exception as e:
    genai = None
    types = None
    _GENAI_IMPORT_ERROR = str(e)

import sys

# ─── Config ───────────────────────────────────────────────────────────────────
# 5 model cho phép
_ALLOWED_MODELS = (
    "models/gemini-3.5-flash",
    "models/gemini-3-flash-preview",
    "models/gemini-3.1-flash-lite-preview",
    "models/gemini-2.5-flash",
    "models/gemini-2.5-flash-lite",
)

# API Keys (bạn thay bằng cách đọc settings file hoặc env)
# ─── API Key helpers ───────────────────────────────────────────────────────────
def get_gemini_api_keys() -> List[str]:
    """
    Lấy danh sách key, key tại active_index đứng đầu.
    Bạn thay logic đọc settings file/env phù hợp dự án.
    """
    import os
    keys: List[str] = []

    env_multi = os.getenv("GEMINI_API_KEYS")
    if env_multi and str(env_multi).strip():
        return _split_key_string(env_multi)

    env_single = os.getenv("GEMINI_API_KEY")
    if env_single and str(env_single).strip():
        return _split_key_string(env_single)

    return []


def _split_key_string(raw: str) -> List[str]:
    parts = re.split(r"[\n;,]+", raw)
    out, seen = [], set()
    for p in parts:
        k = p.strip()
        if k and k not in seen:
            seen.add(k)
            out.append(k)
    return out


def normalize_model(name: Optional[str]) -> str:
    s = str(name or "").strip()
    if s in _ALLOWED_MODELS:
        return s
    if not s.startswith("models/") and s:
        prefixed = f"models/{s}"
        if prefixed in _ALLOWED_MODELS:
            return prefixed
    if s == "gemini-3.1-flash-lite":
        return "models/gemini-3.1-flash-lite-preview"
    return "models/gemini-2.5-flash"


# ─── JSON Parser ──────────────────────────────────────────────────────────────
def parse_json_output(raw_text: str) -> Any:
    """Bóc JSON khỏi output Gemini: thuần, khối ```json, hoặc có text dư trước/sau."""
    if raw_text is None:
        raise json.JSONDecodeError("Expecting value", "", 0)
    s = str(raw_text).strip()
    if s.startswith("\ufeff"):
        s = s[1:].strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    blobs: List[str] = []
    m = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", s, re.IGNORECASE)
    if m:
        blobs.append(m.group(1).strip())
    blobs.append(s)
    decoder = json.JSONDecoder()
    seen: set = set()
    for blob in blobs:
        if not blob or blob in seen:
            continue
        seen.add(blob)
        try:
            return json.loads(blob)
        except json.JSONDecodeError:
            pass
        for start_ch in ("{", "["):
            pos = blob.find(start_ch)
            if pos < 0:
                continue
            try:
                return decoder.raw_decode(blob, pos)[0]
            except json.JSONDecodeError:
                continue
    raise json.JSONDecodeError("Could not parse JSON from model output", s[:200], 0)


# ─── Upload file lên Gemini ────────────────────────────────────────────────────
def upload_files_to_gemini(client: "genai.Client", file_paths: List[Path]) -> Tuple[List[Any], bool]:
    """Upload nhiều file, đợi ACTIVE, trả (files, success)."""
    if not file_paths:
        return [], True
    uploaded = []
    for path in file_paths:
        mime_type, _ = mimetypes.guess_type(str(path))
        if not mime_type:
            mime_type = "application/octet-stream"
        with open(path, "rb") as f:
            uploaded_file = client.files.upload(
                file=path,
                config=dict(mime_type=mime_type),
            )
        # Đợi ACTIVE
        for _ in range(30):
            f = client.files.get(name=uploaded_file.name)
            if str(f.state) == "FileState.ACTIVE":
                break
            time.sleep(2)
        uploaded.append(uploaded_file)
    return uploaded, True


# ─── Core call (1 key, no retry) ──────────────────────────────────────────────
def _call_single(
    api_key: str,
    payload: Dict[str, Any],
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    if not genai or not types:
        return None, "Chưa cài đặt google-genai"
    if not str(api_key or "").strip():
        return None, "Thiếu API key"

    model = normalize_model(payload.get("gemini_model"))
    inp = payload.get("input", {})
    prompt_text = payload.get("system_instruction_text", "")
    response_schema = payload.get("response_schema", {})
    temperature = float(payload.get("temperature", 0.7))

    # Language
    lang_map = {
        "vi": "Vietnamese", "en": "English", "fr": "French",
        "de": "German", "ru": "Russian", "ja": "Japanese",
        "ko": "Korean", "zh": "Chinese", "hi": "Hindi",
        "ur": "Urdu", "it": "Italian", "es": "Spanish", "pt": "Portuguese",
    }
    target_lang = lang_map.get(inp.get("language", "vi"), "Vietnamese")
    if "{{language}}" in prompt_text:
        prompt_text = prompt_text.replace("{{language}}", target_lang)
    else:
        prompt_text = f"TARGET LANGUAGE FOR TTS/AUDIO: {target_lang}\n" + prompt_text

    client = genai.Client(api_key=api_key)
        types.SafetySetting(
            category=types.HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold=types.HarmBlockThreshold.BLOCK_NONE,
        ),
        types.SafetySetting(
            category=types.HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold=types.HarmBlockThreshold.BLOCK_NONE,
        ),
        types.SafetySetting(
            category=types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold=types.HarmBlockThreshold.BLOCK_NONE,
        ),
        types.SafetySetting(
            category=types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold=types.HarmBlockThreshold.BLOCK_NONE,
        ),
    ]

    contents = []
    youtube_url = inp.get("youtube_url")
    topic = inp.get("topic")
    upload_files = inp.get("upload_files", [])
    extracted_file = inp.get("extracted_file_path")

    if youtube_url and youtube_url.strip():
        contents.append(types.Part.from_uri(
            file_uri=youtube_url, mime_type="video/mp4"))
        user_prompt = f"Phân tích video theo system instruction.\n"
        user_prompt += f"TTS phải viết bằng {target_lang}.\n"
        user_prompt += "Output JSON theo schema."
        contents.append(types.Part.from_text(text=user_prompt))

    elif upload_files:
        paths = [Path(p) for p in upload_files if Path(p).exists()]
        uploaded, ok = upload_files_to_gemini(client, paths)
        if not ok:
            return None, "Lỗi upload files"
        for f in uploaded:
            contents.append(types.Part.from_uri(
                file_uri=f.uri, mime_type=f.mime_type))
        user_prompt = f"Phân tích file đã upload theo system instruction.\n"
        user_prompt += f"TTS phải viết bằng {target_lang}.\n"
        user_prompt += "Output JSON theo schema."
        contents.append(types.Part.from_text(text=user_prompt))

    elif extracted_file and Path(extracted_file).exists():
        paths = [Path(extracted_file)]
        uploaded, ok = upload_files_to_gemini(client, paths)
        if not ok:
            return None, "Lỗi upload file"
        f = uploaded[0]
        contents.append(types.Part.from_uri(file_uri=f.uri, mime_type=f.mime_type))
        user_prompt = f"Phân tích nội dung file theo system instruction.\n"
        user_prompt += f"TTS phải viết bằng {target_lang}.\n"
        user_prompt += "Output JSON theo schema."
        contents.append(types.Part.from_text(text=user_prompt))

    elif topic and topic.strip():
        duration = inp.get("duration", 60)
        user_prompt = (
            f"CHỦ ĐỀ: {topic}\n"
            f"THỜI LƯỢNG MỤC TIÊU: {duration} giây.\n"
            f"TTS phải viết bằng {target_lang}.\n"
            "Output JSON theo schema."
        )
        contents.append(types.Part.from_text(text=user_prompt))

    else:
        return None, "Thiếu đầu vào (cần YouTube URL, Topic, hoặc Upload Files)"

    try:
        resp = client.models.generate_content(
            model=model,
            config=types.GenerateContentConfig(
                system_instruction=prompt_text,
                temperature=temperature,
                response_mime_type="application/json",
                response_schema=response_schema,
                safety_settings=safety_settings,
                max_output_tokens=65535,  # Cap tối đa, model tự sinh bao nhiêu tùy nội dung
            ),
            contents=contents,
        )
        raw_text = getattr(resp, "text", None) or ""
        if not raw_text or not raw_text.strip():
            return None, "Gemini trả response rỗng"
        data = parse_json_output(raw_text.strip())
        return data, None
    except Exception as e:
        return None, str(e)


# ─── Public: gọi với auto key + retry tạm quá tải ────────────────────────────
def call_gemini_generate(payload: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    if not genai or not types:
        return None, "Chưa cài đặt google-genai"

    keys = payload.get("api_keys") or payload.get("api_key")
    if not keys:
        keys = get_gemini_api_keys()
    if isinstance(keys, str):
        keys = [keys]
    keys = [str(k).strip() for k in keys if k and str(k).strip()]
    if not keys:
        return None, "Thiếu GEMINI_API_KEY"

    TRANSIENT_ERRORS = ("503", "unavailable", "high demand", "temporarily", "try again later")
    api_key = keys[0]
    last_err: Optional[str] = None
    for attempt, sleep_s in enumerate((0, 2), start=1):
        if attempt > 1:
            print(f"[Gemini] Retry lần {attempt}/2 sau {sleep_s}s...")
            time.sleep(sleep_s)
        result, err = _call_single(api_key, payload)
        if result is not None:
            return result, None
        last_err = err
        err_lower = str(err or "").lower()
        if not any(tok in err_lower for tok in TRANSIENT_ERRORS):
            break

    if last_err and any(tok in str(last_err).lower() for tok in TRANSIENT_ERRORS):
        return None, "Gemini đang quá tải, vui lòng thử lại sau."
    return None, last_err


# ─── Entry point chính ───────────────────────────────────────────────────────
def generate_script(
    prompt_id: str,
    system_instruction: str,
    response_schema: Dict[str, Any],
    language: str = "vi",
    duration: int = 60,
    youtube_url: str = None,
    topic: str = None,
    upload_files: List[str] = None,
    extracted_file_path: str = None,
    additional_description: str = None,
    temperature: float = 0.7,
    api_key: str = None,
    api_keys: List[str] = None,
    gemini_model: str = None,
) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    """
    Sinh kịch bản bằng Gemini.

    Args:
        prompt_id:       ID prompt để track
        system_instruction: Toàn bộ system instruction
        response_schema:  JSON Schema trả về
        language:        Mã ngôn ngữ ('vi', 'en', ...)
        duration:        Thời lượng video target (giây)
        youtube_url:     Link YouTube (reskin)
        topic:           Chủ đề tự do (creative)
        upload_files:    List đường dẫn file upload lên Gemini
        extracted_file_path: Đường dẫn file đã extract
        additional_description: Mô tả thêm cho AI
        temperature:     Temperature model
        api_key:         1 API key
        api_keys:        Nhiều API keys
        gemini_model:    Tên model (sẽ normalize)

    Returns:
        Tuple[data, error]
    """
    payload = {
        "api_keys": api_keys,
        "api_key": api_key,
        "gemini_model": normalize_model(gemini_model),
        "prompt_id": prompt_id,
        "temperature": temperature,
        "system_instruction_text": system_instruction,
        "system_instruction_addendum_text": "",
        "system_instruction_addendum_text_extra": "",
        "response_schema": response_schema,
        "input": {
            "youtube_url": youtube_url,
            "topic": topic,
            "language": language,
            "duration": duration,
            "enable_custom_duration": False,
            "scene_count": None,  # Sẽ tính từ duration bên trong _call_single
            "upload_files": upload_files or [],
            "extracted_file_path": extracted_file_path,
            "additional_description": additional_description or "",
        },
    }
    return call_gemini_generate(payload)