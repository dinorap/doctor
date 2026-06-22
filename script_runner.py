from typing import Optional, Dict, Any, Tuple, List
from pathlib import Path
from datetime import datetime
import json
import mimetypes
import re
import time
import tempfile
import os
import unicodedata
import sys

_GENAI_IMPORT_ERROR = ""
try:
    import importlib
    # Compatibility shim for packaged environments where websockets layout differs.
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

from services.config_loader import get_prompt_config, get_style, get_gemini_api_keys, get_settings
from services.prompt_store import (
    DEFAULT_MASTER_CAST_IMAGE_PROMPT_TEXT,
    get_master_cast_image_prompt_prefix,
)
from services.scene_character import assign_scene_characters_from_profiles
from utils.path_helper import PROJECTS_DIR

# 🔥 Global rule cho nhân vật dẫn chuyện NARRATOR
NARRATOR_RULE = (
    "RULE: NARRATOR is voice-over only. "
    "Never render the narrator visually and never trigger lip-sync for narrator dialogue."
)


def _is_gemini_transient_unavailable_error(err_msg: Optional[str]) -> bool:
    """
    True khi lỗi mang tính tạm thời (model quá tải/UNAVAILABLE) — nên retry cùng key/model.
    """
    if not err_msg:
        return False
    s = str(err_msg).lower()
    needles = (
        "503",
        "unavailable",
        "high demand",
        "temporarily",
        "try again later",
        "service unavailable",
        "spikes in demand",
    )
    return any(n in s for n in needles)


GEMINI_MODEL_OVERLOAD_USER_MESSAGE = "Mô hình đang quá tải, vui lòng thử lại sau."


_GEMINI_SCRIPT_MODELS = (
    "models/gemini-3.5-flash",
    "models/gemini-3-flash-preview",
    "models/gemini-3.1-flash-lite-preview",
    "models/gemini-2.5-flash",
    "models/gemini-2.5-flash-lite",
)


def _normalize_gemini_model(model_name: Optional[str]) -> str:
    """Chuẩn hoá model Gemini cho sinh kịch bản (khớp allowlist settings)."""
    s = str(model_name or "").strip()
    if s in _GEMINI_SCRIPT_MODELS:
        return s
    if not s.startswith("models/") and s:
        prefixed = f"models/{s}"
        if prefixed in _GEMINI_SCRIPT_MODELS:
            return prefixed
    if s == "gemini-3.1-flash-lite":
        return "models/gemini-3.1-flash-lite-preview"
    return "models/gemini-2.5-flash"


def _parse_llm_json_output(raw_text: str) -> Any:
    """
    Bóc JSON từ output Gemini: JSON thuần, khối ```json```, hoặc text dư trước/sau JSON.
    """
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


def _coerce_bool(value: Any, default: bool = False) -> bool:
    """
    Chuẩn hoá input bool từ JSON/FormData.
    """
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    s = str(value).strip().lower()
    if s in ("true", "1", "yes", "y", "on"):
        return True
    if s in ("false", "0", "no", "n", "off", ""):
        return False
    return default


def _coerce_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _is_temp_file(file_path: Path) -> bool:
    """
    Kiểm tra xem file có phải là file tạm không.
    File tạm là file không nằm trong upload folder của projects.
    """
    try:
        file_path_str = str(file_path)
        # Kiểm tra xem file có nằm trong temp directory không
        temp_dir = tempfile.gettempdir()
        if file_path_str.startswith(temp_dir):
            return True
        
        # Kiểm tra xem file có nằm trong upload folder không
        # Nếu không nằm trong upload folder, thì có thể là file tạm
        if "upload" not in file_path_str:
            # Kiểm tra xem có nằm trong PROJECTS_DIR không
            projects_dir_str = str(PROJECTS_DIR)
            if projects_dir_str not in file_path_str:
                return True
        
        return False
    except:
        # Nếu có lỗi, giả định không phải file tạm để an toàn
        return False


def _upload_files_to_gemini(client: "genai.Client", file_paths: List[Path]) -> Tuple[List[Any], bool]:
    """
    Upload nhiều file lên Gemini File API và đợi chúng ACTIVE.
    
    Returns:
        Tuple[list_of_file_objects, success]: (files, True nếu OK, False nếu lỗi)
    """
    if not file_paths:
        return [], True
    
    uploaded_files = []
    for path in file_paths:
        mime_type, _ = mimetypes.guess_type(str(path))
        if not mime_type:
            if path.suffix.lower() == ".pdf":
                mime_type = "application/pdf"
            elif path.suffix.lower() == ".txt":
                mime_type = "text/plain"
            elif path.suffix.lower() in [".jpg", ".jpeg"]:
                mime_type = "image/jpeg"
            elif path.suffix.lower() == ".png":
                mime_type = "image/png"
            elif path.suffix.lower() == ".webp":
                mime_type = "image/webp"
            elif path.suffix.lower() == ".gif":
                mime_type = "image/gif"
            elif path.suffix.lower() == ".bmp":
                mime_type = "image/bmp"
            else:
                mime_type = "application/octet-stream"
        
        try:
            with path.open("rb") as f:
                file_obj = client.files.upload(file=f, config={"mime_type": mime_type})
            uploaded_files.append(file_obj)
        except Exception as e:
            print(f"[Script Runner] ❌ Lỗi upload file {path}: {e}")
            return uploaded_files, False
    
    # Đợi tất cả files ACTIVE
    for file_obj in uploaded_files:
        file = client.files.get(name=file_obj.name)
        while getattr(file.state, "name", "") == "PROCESSING":
            time.sleep(2)
            file = client.files.get(name=file_obj.name)
        
        if getattr(file.state, "name", "") != "ACTIVE":
            print(f"[Script Runner] ❌ File {file_obj.name} không ACTIVE: {getattr(file.state, 'name', 'UNKNOWN')}")
            return uploaded_files, False
    
    return uploaded_files, True


def _inject_cast_visuals_into_prompt(text: str, char_map: Dict[str, str]) -> str:
    """
    Thêm visual_signature sau tên nhân vật trong phần mô tả hình ảnh/video,
    nhưng:
    - KHÔNG đụng tới phần Audio / TTS ở cuối prompt.
    - KHÔNG thêm nếu scene đã có pattern `NAME (visual_signature)` rồi.
    - Xử lý TẤT CẢ các nhân vật và TẤT CẢ các lần xuất hiện của mỗi nhân vật.
    """
    if not text or not char_map:
        return text
    
    # Tách phần mô tả hình ảnh và phần Audio (nếu có)
    audio_match = re.search(r"\bAudio\b", text)
    if audio_match:
        head = text[: audio_match.start()]
        tail = text[audio_match.start() :]
    else:
        head, tail = text, ""
    
    for name, visual in char_map.items():
        if not name or not visual:
            continue

        # Nếu đã có đúng pattern NAME (visual_signature) thì bỏ qua name này
        marker = f"{name} ({visual}"
        if marker in head:
            continue

        # Chỉ inject visual_signature cho LẦN XUẤT HIỆN ĐẦU TIÊN của tên nhân vật
        # trong phần mô tả hình ảnh (trước Audio), và chỉ khi sau tên chưa có "("
        pattern = r"\b" + re.escape(name) + r"\b(?!\s*\()"
        m = re.search(pattern, head)
        if not m:
            continue
        replacement = f"{name} ({visual})"
        head = head[: m.start()] + replacement + head[m.end() :]
    
    return head + tail


def _apply_style_to_scenes(data: Dict[str, Any], style_prompt: str, prompt_id: str = None, yt_use_reference_image: bool = False, ai_use_reference_image: bool = False) -> Dict[str, Any]:
    """
    Áp dụng style cho scenes (image_prompt / video_prompt).
    KHÔNG còn ép uppercase tên nhân vật hoặc tạo master_cast_image_prompt tại đây nữa.
    Việc chuẩn hóa tên + tạo master_cast_image_prompt sẽ chạy ở bước cuối cùng (finalize) sau khi đã merge multi-pass.
    """
    # Kiểm tra tab
    is_youtube_tab = bool(prompt_id and prompt_id.startswith("youtube-"))
    is_ai_tab = bool(prompt_id and prompt_id.startswith("ai-"))

    # Map name -> visual_signature để có thể tự chèn vào video_prompt (AI tab)
    cast_profiles = data.get("cast_profiles", []) or []
    char_visual_map: Dict[str, str] = {}
    if cast_profiles and is_ai_tab:
        for char in cast_profiles:
            name = (char.get("name") or "").strip()
            desc = (char.get("visual_signature", "") or "").strip().rstrip(".")
            if name and desc:
                char_visual_map[name] = desc

    # Áp dụng style vào từng scene
    neg_suffix = (
        "STRICT RULE: ZERO visible text in the video. "
        "No letters, numbers, subtitles, captions, logos, watermarks, or UI elements anywhere in the frame."
    )

    # AI Tab (Veo3) video_prompt: luật chặt chẽ về audio, nhạc nền và ambient
    AI_VIDEO_STRICT_SUFFIX = (
        "STRICT AUDIO RULE: "
        "Only the character defined in the 'Audio:' tag may speak and lip-sync; all others keep their mouths closed. "
        "If 'Audio: no voice', enforce ZERO speech and ZERO lip movement. "
        "If 'STRICTLY NO BGM', generate NO music or soundtrack. "
        "Only sounds listed in 'ASMR:' may exist."
    )

    master_ref_text = (
        "STRICT CHARACTER RULE: "
        "Characters must match the master reference exactly (same face, body, outfit, and colors). "
        "Do not redesign characters. "
        "Only include characters explicitly named in the prompt. "
        "If no named character is present, show no people or only anonymous figures."
    )


    # YouTube: chèn master_ref_text khi yt_use_reference_image và có character/cast_profiles (finalize sẽ tạo master_cast)
    # Lưu ý: master_cast_image_prompt chưa tồn tại lúc này (tạo trong finalize), nên dùng char_profiles
    char_profiles = data.get("cast_profiles") or data.get("character_profiles") or []
    use_master_ref_yt = yt_use_reference_image and is_youtube_tab and bool(char_profiles)
    use_master_ref_ai = ai_use_reference_image and is_ai_tab and bool(char_visual_map)  # char_visual_map từ cast_profiles
    use_master_ref = use_master_ref_yt or use_master_ref_ai

    scenes = data.get("scenes", [])
    style_prefix = f"{style_prompt}. " if style_prompt else ""

    for scene in scenes:
        # YouTube: image_prompt
        if "image_prompt" in scene and scene.get("image_prompt"):
            original = scene["image_prompt"]
            clean_content = original.strip().rstrip(".")
            if use_master_ref_yt:
                # Luật ở cuối: mô tả → CHARACTER RULE → RULE ZERO TEXT
                scene["image_prompt"] = (
                    f"{style_prefix}{clean_content} {NARRATOR_RULE}. "
                    f"{master_ref_text} {neg_suffix}"
                )
            else:
                scene["image_prompt"] = (
                    f"{style_prefix}{clean_content} {NARRATOR_RULE}. {neg_suffix}"
                )
        
        # AI Video: video_prompt
        if "video_prompt" in scene and scene.get("video_prompt"):
            original = scene["video_prompt"]
            clean_content = original.replace("[Scene", "").replace("]", "").strip()
            if len(clean_content) > 0 and clean_content.split(" ", 1)[0].isdigit():
                try:
                    clean_content = clean_content.split(" ", 1)[1]
                except IndexError:
                    pass
            # AI tab: dùng cả neg_suffix (logo/text) + AI_VIDEO_STRICT_SUFFIX (audio/sub)
            # YouTube tab: chỉ dùng neg_suffix
            if is_ai_tab:
                video_neg = f"{neg_suffix}{AI_VIDEO_STRICT_SUFFIX}"
            else:
                video_neg = neg_suffix
            if use_master_ref:
                # Luật ở cuối: content trước, NARRATOR_RULE + master_ref + video_neg sau
                composed = f"{style_prefix}{clean_content} {NARRATOR_RULE}. {master_ref_text}{video_neg}"
            else:
                composed = f"{style_prefix}{clean_content} {NARRATOR_RULE}. {video_neg}"
            # Chỉ AI Tab mới auto chèn visual_signature vào mô tả nhân vật
            if is_ai_tab and char_visual_map:
                composed = _inject_cast_visuals_into_prompt(composed, char_visual_map)
            scene["video_prompt"] = composed
    
    return data


def _append_strict_ai_video_rules(
    data: Dict[str, Any],
    prompt_id: str,
    ai_use_reference_image: bool = False,
) -> Dict[str, Any]:
    """
    Hậu xử lý BẮT BUỘC cho AI tab: nối bộ luật NARRATOR + CHARACTER + AUDIO + ZERO TEXT
    vào cuối mọi video_prompt của scene AI-video / AI-story, kể cả khi style/apply_style
    trước đó không chạy như mong đợi.
    """
    if not data or not isinstance(data, dict):
        return data

    if not (prompt_id and prompt_id.startswith("ai-") and ("video" in prompt_id or "story" in prompt_id)):
        return data

    scenes = data.get("scenes") or []
    if not isinstance(scenes, list):
        return data

    # Bộ rule giống trong _apply_style_to_scenes, nhưng dùng ở bước cuối cho chắc chắn.
    neg_suffix = (
        "STRICT RULE: ZERO visible text in the video. "
        "No letters, numbers, subtitles, captions, logos, watermarks, or UI elements anywhere in the frame."
    )
    audio_suffix = (
        "STRICT AUDIO RULE: "
        "Only the character defined in the 'Audio:' tag may speak and lip-sync; all others keep their mouths closed. "
        "If 'Audio: no voice', enforce ZERO speech and ZERO lip movement. "
        "If 'STRICTLY NO BGM', generate NO music or soundtrack. "
        "Only sounds listed in 'ASMR:' may exist."
    )
    master_ref_text = (
        "STRICT CHARACTER RULE: "
        "Characters must match the master reference exactly (same face, body, outfit, and colors). "
        "Do not redesign characters. "
        "Only include characters explicitly named in the prompt. "
        "If no named character is present, show no people or only anonymous figures."
    )

    for scene in scenes:
        vp = scene.get("video_prompt")
        if not isinstance(vp, str) or not vp.strip():
            continue
        # Nếu đã có STRICT RULE thì coi như đã nối, bỏ qua để tránh lặp nhiều lần.
        if "STRICT RULE: ZERO visible text" in vp:
            continue

        suffix_parts: List[str] = []
        # NARRATOR rule luôn có
        base = f"{vp.strip()} {NARRATOR_RULE}."
        # Nếu dùng ảnh tham chiếu: thêm CHARACTER RULE
        if ai_use_reference_image:
            suffix_parts.append(master_ref_text)
        suffix_parts.append(audio_suffix)
        suffix_parts.append(neg_suffix)
        full_suffix = " ".join(suffix_parts)
        scene["video_prompt"] = f"{base} {full_suffix}"

    data["scenes"] = scenes
    return data


def _rewrite_scene_duration_text(text: str, seconds: int) -> str:
    """
    Đổi các cụm "8s / 8 giây / 8-second" trong prompt sang thời lượng scene thực tế.
    Chỉ dùng cho AI + Grok để tránh ảnh hưởng flow Veo cũ.
    """
    if not isinstance(text, str) or not text:
        return text

    out = text
    out = re.sub(r"\bVIDEO\s*8S\b", f"VIDEO {seconds}S", out)
    out = re.sub(r"\bvideo\s*8s\b", f"video {seconds}s", out)
    out = re.sub(r"\b8S\b", f"{seconds}S", out)
    out = re.sub(r"\b8s\b", f"{seconds}s", out)
    out = re.sub(r"\b8\s*GIÂY\b", f"{seconds} GIÂY", out)
    out = re.sub(r"\b8\s*giây\b", f"{seconds} giây", out)
    out = re.sub(r"\b8\s*giay\b", f"{seconds} giay", out)
    out = re.sub(r"\b8\s*-\s*second(s)?\b", lambda m: f"{seconds}-second{m.group(1) or ''}", out, flags=re.IGNORECASE)
    out = re.sub(r"\b8\s+second(s)?\b", lambda m: f"{seconds} second{m.group(1) or ''}", out, flags=re.IGNORECASE)
    # Các dạng công thức scene count thường gặp trong prompt: duration / 8, /8
    out = re.sub(r"(\bduration\b\s*/\s*)8\b", rf"\g<1>{seconds}", out, flags=re.IGNORECASE)
    out = re.sub(r"(\bSố lượng scene\s*=\s*[^=\n]*/\s*)8\b", rf"\g<1>{seconds}", out, flags=re.IGNORECASE)
    out = re.sub(r"(\bso luong scene\s*=\s*[^=\n]*/\s*)8\b", rf"\g<1>{seconds}", out, flags=re.IGNORECASE)
    # Dạng "scene = 8" hoặc "mỗi scene = 8"
    out = re.sub(r"(\bmỗi\s+scene\s*=\s*)8\b", rf"\g<1>{seconds}", out, flags=re.IGNORECASE)
    out = re.sub(r"(\bscene\s*=\s*)8\b", rf"\g<1>{seconds}", out, flags=re.IGNORECASE)
    return out


def _rewrite_scene_duration_in_obj(value: Any, seconds: int) -> Any:
    """
    Deep-rewrite cho schema/prompt object để mọi mô tả chứa 8s đều đổi theo duration.
    """
    if isinstance(value, str):
        return _rewrite_scene_duration_text(value, seconds)
    if isinstance(value, list):
        return [_rewrite_scene_duration_in_obj(v, seconds) for v in value]
    if isinstance(value, dict):
        return {k: _rewrite_scene_duration_in_obj(v, seconds) for k, v in value.items()}
    return value


def _build_grok_pacing_instruction(scene_duration_seconds: int, target_language: str) -> str:
    """
    Rule tăng chất lượng script cho Grok:
    - TTS đủ độ dài theo 6s/10s
    - Hành động có nhịp theo timeline, tránh cảnh đứng im dài
    """
    if scene_duration_seconds <= 6:
        tts_target = "khoảng 10-16 từ (hoặc độ dài tương đương theo ngôn ngữ đích)"
        tts_min = "KHÔNG dưới 8 từ"
        action_steps = "ít nhất 2 micro-actions liên tiếp"
        beat_hint = "nhịp gợi ý: mở hành động (0-2s) -> phát triển/chuyển động chính (2-5s) -> chốt nhịp (5-6s)"
    else:
        tts_target = "khoảng 18-30 từ (hoặc độ dài tương đương theo ngôn ngữ đích)"
        tts_min = "KHÔNG dưới 14 từ"
        action_steps = "ít nhất 3 micro-actions liên tiếp"
        beat_hint = "nhịp gợi ý: mở cảnh (0-2s) -> hành động 1 (2-5s) -> hành động 2/biến đổi cảm xúc (5-8s) -> chốt cảnh (8-10s)"

    return (
        f"\n\n🎬 GROK PACING & DIALOGUE QUALITY (STRICT FOR {scene_duration_seconds}S/SCENE):\n"
        f"- Mỗi scene dài {scene_duration_seconds} giây phải có nhịp động rõ ràng, tránh đứng im kéo dài.\n"
        f"- Với scene có thoại (tts_script không rỗng): độ dài thoại mục tiêu = {tts_target}; {tts_min} trừ trường hợp cố ý ngắt nhịp cảm xúc.\n"
        f"- Nếu nội dung gốc quá ngắn, được phép diễn đạt tự nhiên thành 2 vế/câu ngắn tương đương ý nghĩa để lấp đầy nhịp thoại, KHÔNG đổi thông điệp.\n"
        f"- video_prompt phải mô tả {action_steps}; mỗi micro-action là thay đổi quan sát được (động tác, ánh mắt, vị trí, camera, phản ứng).\n"
        f"- {beat_hint}.\n"
        f"- Cấm 1 hành động đơn lẻ kéo dài gần hết scene mà không có biến đổi.\n"
        f"- Nếu tts_script kết thúc sớm, phần thời gian còn lại vẫn phải có chuyển động hình ảnh có chủ đích (reaction, camera drift, environmental interaction), không để khoảng lặng chết.\n"
        f"- TTS_SCRIPT phải viết bằng {target_language}; mô tả hình ảnh/video vẫn giữ tiếng Anh.\n"
    )


def _rewrite_grok_quality_rules(text: str, scene_duration_seconds: int) -> str:
    """
    Rewrite các rule "chất lượng nhịp" theo duration cho Grok (6s/10s),
    không chỉ thay số 8 cơ học.
    """
    if not isinstance(text, str) or not text:
        return text

    if scene_duration_seconds <= 6:
        speech_window = "4-5s"
        main_action_range = "2-4 giây"
        split_threshold = "6s"
        split_threshold_vi = "6 giây"
    else:
        speech_window = "7-8s"
        main_action_range = "3-7 giây"
        split_threshold = "10s"
        split_threshold_vi = "10 giây"

    out = text
    # Rule thoại/hành động quá tải một scene
    out = re.sub(
        r"Một scene KHÔNG ĐƯỢC chứa lượng thoại vượt quá khả năng phát trong \d+\s*giây\.",
        f"Một scene KHÔNG ĐƯỢC chứa lượng thoại vượt quá khả năng phát trong {split_threshold_vi}.",
        out,
    )
    out = re.sub(
        r"NẾU thoại hoặc hành động >\s*\d+\s*s\s*→\s*BẮT BUỘC tách thành 2 hoặc nhiều scene nối tiếp\.",
        f"NẾU thoại hoặc hành động > {split_threshold} → BẮT BUỘC tách thành 2 hoặc nhiều scene nối tiếp.",
        out,
    )

    # Nhịp thoại mục tiêu
    out = re.sub(
        r"Mục tiêu nhịp tốt:\s*~\d+\s*[–-]\s*\d+\s*s thoại/scene để video có không gian chuyển động\.",
        f"Mục tiêu nhịp tốt: ~{speech_window} thoại/scene để video có không gian chuyển động.",
        out,
    )

    # Hành động chính trong scene
    out = re.sub(
        r"Scene \d+\s*giây có thể gồm:\s*\n\s*\+\s*hành động chính\s*\([^)]+\)",
        f"Scene {scene_duration_seconds} giây có thể gồm:\n  + hành động chính ({main_action_range})",
        out,
        flags=re.IGNORECASE,
    )

    return out


def _normalize_copy_ratio(copy_ratio: int) -> int:
    return max(50, min(100, int(copy_ratio)))


def _copy_ratio_tier(copy_ratio: int) -> str:
    """
    Tier khớp UI sidebar: 100 | 99 | 90 | 80 | 70 | 50-69.
    """
    cr = _normalize_copy_ratio(copy_ratio)
    if cr == 100:
        return "mirror"
    if cr >= 99:
        return "verbatim"
    if cr >= 90:
        return "high"
    if cr >= 80:
        return "high_balanced"
    if cr >= 70:
        return "balanced"
    return "partial"


def _temperature_for_copy_ratio(copy_ratio: int) -> float:
    """Copy ratio cao → temperature thấp. Các mốc: 100, 90, 80, 70, 50."""
    cr = _normalize_copy_ratio(copy_ratio)
    if cr == 100:
        return 0.10
    if cr >= 90:
        return 0.10 + (100 - cr) * 0.01  # 99→0.11, 90→0.20
    if cr >= 80:
        return 0.20 + (90 - cr) * 0.01  # 89→0.21, 80→0.30
    if cr >= 70:
        return 0.30 + (80 - cr) * 0.015  # 79→0.315, 70→0.45
    return 0.45 + (70 - cr) * 0.0125  # 69→0.4625, 50→0.70


def _preservation_mode_label(copy_ratio: int) -> str:
    tier = _copy_ratio_tier(copy_ratio)
    return {
        "mirror": "FULL PRESERVATION MODE",
        "verbatim": "FULL PRESERVATION MODE",
        "high": "HIGH PRESERVATION MODE",
        "high_balanced": "HIGH-BALANCED COPY MODE",
        "balanced": "BALANCED COPY MODE",
        "partial": "PARTIAL COPY MODE",
    }[tier]


def _build_role_task_block(copy_ratio: int) -> str:
    cr = _normalize_copy_ratio(copy_ratio)
    creative = 100 - cr
    tier = _copy_ratio_tier(cr)
    if tier == "mirror":
        return (
            "TUYỆT ĐỐI:\n"
            "- KHÔNG sáng tác, KHÔNG bịa, KHÔNG thêm ý.\n"
            f"- Giữ ≈{cr}% nội dung transcript gốc.\n"
            "- Giữ nguyên thứ tự sự kiện và logic nhân–quả."
        )
    if tier in ("verbatim", "high"):
        return (
            f"NGUỒN VIDEO GỐC (copy_ratio = {cr}%):\n"
            f"- Copy/paraphrase sát ≈{cr}% transcript: ưu tiên giữ wording gốc, chỉ chỉnh dấu câu và nhịp đọc.\n"
            f"- Phần còn lại ({creative}%) chỉ tách scene hoặc rút gọn câu rất nhẹ; KHÔNG thêm fact mới.\n"
            "- Giữ nguyên thứ tự sự kiện và logic nhân–quả."
        )
    if tier == "high_balanced":
        return (
            f"NGUỒN VIDEO GỐC (copy_ratio = {cr}%):\n"
            f"- Giữ ≈{cr}% ý/câu gốc ở các beat chính; ưu tiên giữ câu thoại gốc khi có thể.\n"
            f"- {creative}% còn lại: paraphrase nhẹ, gom câu, làm mượt nhịp; KHÔNG thêm fact/plot mới.\n"
            "- Timeline và nhân-quả chính phải khớp video gốc."
        )
    if tier == "balanced":
        return (
            f"NGUỒN VIDEO GỐC (copy_ratio = {cr}%):\n"
            f"- Giữ ≈{cr}% nội dung/ý chính từ transcript (fact, thứ tự sự kiện lớn, thông điệp).\n"
            f"- {creative}% còn lại: paraphrase, làm rõ, gọn hơn; KHÔNG thêm plot twist hay fact mới.\n"
            "- Timeline và nhân-quả chính phải khớp video gốc."
        )
    return (
        f"NGUỒN VIDEO GỐC (copy_ratio = {cr}%):\n"
        f"- Giữ ≈{cr}% beat/fact/ý chính từ transcript; có thể BỎ QUA chi tiết phụ, ví dụ lặp, cảnh phụ.\n"
        f"- {creative}% còn lại: viết lại cách diễn đạt, gom/bỏ scene phụ; KHÔNG đổi kết cục hay thông điệp chính.\n"
        "- Vẫn giữ mạch nhân–quả và thứ tự sự kiện QUAN TRỌNG của video gốc."
    )


def _build_ai_video_absolute_line(copy_ratio: int) -> str:
    """Dòng tuyệt đối trong prompt ai-video-url (format 1 dòng, khác youtube-url)."""
    cr = _normalize_copy_ratio(copy_ratio)
    creative = 100 - cr
    tier = _copy_ratio_tier(cr)
    if tier in ("mirror", "verbatim"):
        return "TUYỆT ĐỐI KHÔNG sáng tác, KHÔNG bịa, KHÔNG thêm ý, KHÔNG đổi thông điệp."
    if tier == "high":
        return (
            f"Copy ≈{cr}% từ video gốc; chỉ paraphrase nhẹ hoặc tách scene, "
            f"phần còn lại ({creative}%) không thêm fact/plot mới."
        )
    if tier == "high_balanced":
        return (
            f"Copy ≈{cr}% ý/fact chính; {creative}% paraphrase nhẹ hoặc gom câu, "
            "không đổi thông điệp hay kết cục."
        )
    if tier == "balanced":
        return (
            f"Copy ≈{cr}% ý/fact chính từ video; {creative}% còn lại paraphrase/lược bỏ chi tiết phụ, "
            "không đổi thông điệp hay kết cục."
        )
    return (
        f"Copy ≈{cr}% beat/fact chính; {creative}% còn lại viết lại cách diễn đạt, "
        "có thể bỏ scene phụ; không đổi thông điệp hay nhân-quả cốt lõi."
    )


def _build_tts_preservation_line(copy_ratio: int) -> str:
    cr = _normalize_copy_ratio(copy_ratio)
    creative = 100 - cr
    tier = _copy_ratio_tier(cr)
    if tier in ("mirror", "verbatim", "high"):
        return f"- GIỮ ≈{cr}% nội dung câu gốc. KHÔNG ngoặc kép, KHÔNG chỉ dẫn sân khấu."
    if tier == "high_balanced":
        return (
            f"- GIỮ ≈{cr}% ý/câu gốc; {creative}% còn lại paraphrase nhẹ trong cùng fact. "
            "KHÔNG ngoặc kép, KHÔNG chỉ dẫn sân khấu."
        )
    if tier == "balanced":
        return (
            f"- GIỮ ≈{cr}% ý/câu gốc; phần còn lại paraphrase gọn trong cùng fact. "
            "KHÔNG ngoặc kép, KHÔNG chỉ dẫn sân khấu."
        )
    return (
        f"- GIỮ ≈{cr}% ý chính từ câu gốc; phần còn lại rút gọn/paraphrase, có thể bỏ chi tiết phụ. "
        "KHÔNG ngoặc kép, KHÔNG chỉ dẫn sân khấu."
    )


def _build_copy_ratio_tier_hint(copy_ratio: int) -> str:
    """Gợi ý ngắn chèn vào system instruction theo tier."""
    cr = _normalize_copy_ratio(copy_ratio)
    tier = _copy_ratio_tier(cr)
    hints = {
        "mirror": "- Chế độ mirror 100%: không paraphrase, không lược beat.\n",
        "verbatim": "- Chế độ 99%: gần nguyên văn, chỉ chỉnh nhịp/dấu câu.\n",
        "high": f"- Chế độ 90–98% (hiện {cr}%): giữ wording gốc tối đa.\n",
        "high_balanced": (
            f"- Chế độ 80–89% (hiện {cr}%): copy phần lớn, paraphrase nhẹ ~{100 - cr}%, "
            "vẫn ưu tiên câu gốc ở beat chính.\n"
        ),
        "balanced": (
            f"- Chế độ 70–79% (hiện {cr}%): paraphrase vừa, có thể lược chi tiết phụ.\n"
        ),
        "partial": (
            f"- Chế độ 50–69% (hiện {cr}%): giữ beat chính, viết lại/lược bỏ phần phụ.\n"
        ),
    }
    return hints.get(tier, "")


def _append_copy_ratio_user_instructions(user_prompt: str, copy_ratio: int) -> str:
    """Bổ sung hướng dẫn copy_ratio vào user prompt (YouTube URL)."""
    cr = _normalize_copy_ratio(copy_ratio)
    creative = 100 - cr
    tier = _copy_ratio_tier(cr)
    user_prompt += (
        f"\n📊 TỶ LỆ COPY NỘI DUNG (CONTENT COPY RATIO = {cr}%):\n"
        f"- Copy {cr}% nội dung từ video gốc (transcript, thứ tự sự kiện, logic nhân-quả, thông điệp chính).\n"
        f"- Sáng tạo thêm {creative}%: paraphrase/lược bỏ trong giới hạn trên, KHÔNG đổi thông điệp hay fact cốt lõi.\n"
    )
    if tier == "mirror":
        user_prompt += (
            "\n🔒 COPY_RATIO = 100 (MIRROR MODE):\n"
            "- CẤM thêm ý mới, CẤM đổi timeline, CẤM đổi nguyên nhân-kết quả.\n"
            "- Chỉ cho phép chỉnh dấu câu, ngắt nhịp hoặc tách scene kỹ thuật mà không đổi nghĩa.\n"
        )
    elif tier == "verbatim":
        user_prompt += (
            "\n🎯 COPY_RATIO = 99 (NEAR-VERBATIM):\n"
            "- BẮT BUỘC giữ thứ tự sự kiện theo timeline video gốc.\n"
            "- Không paraphrase mạnh; ưu tiên giữ wording gốc ở mức tối đa.\n"
        )
    elif tier == "high":
        user_prompt += (
            f"\n🎯 COPY_RATIO = {cr}% (HIGH PRESERVATION):\n"
            "- Giữ wording gốc ở hầu hết câu thoại; paraphrase rất nhẹ nếu cần.\n"
            "- Không thêm fact/plot; giữ timeline như video gốc.\n"
        )
    elif tier == "high_balanced":
        user_prompt += (
            f"\n🧭 COPY_RATIO = {cr}% (HIGH-BALANCED — mức 80%):\n"
            f"- Giữ ~{cr}% ý/câu gốc; ~{creative}% paraphrase nhẹ hoặc gom câu.\n"
            "- Không thêm nhân vật/plot; có thể rút gọn câu phụ, không lược beat chính.\n"
        )
    elif tier == "balanced":
        user_prompt += (
            f"\n🧭 COPY_RATIO = {cr}% (BALANCED — mức 70%):\n"
            "- Có thể paraphrase và rút gọn; giữ fact cốt lõi, thứ tự sự kiện lớn, thông điệp chính.\n"
            "- Không thêm nhân vật/plot twist; có thể bỏ chi tiết phụ, ví dụ lặp.\n"
        )
    else:
        user_prompt += (
            f"\n🧭 COPY_RATIO = {cr}% (PARTIAL COPY — mức 50–60%):\n"
            f"- Chỉ giữ ~{cr}% beat/ý chính; phần còn lại viết lại hoặc lược bỏ cảnh phụ.\n"
            "- KHÔNG đổi kết cục, thông điệp chính, hoặc quan hệ nhân-quả cốt lõi.\n"
            "- tts_script phải khác rõ so với verbatim 99% (paraphrase, gọn hơn, hoặc ít scene hơn).\n"
        )
    return user_prompt


def _apply_copy_ratio_to_prompt(prompt_text: str, copy_ratio: int) -> str:
    """Ghi đè rule FULL PRESERVATION cứng trong prompt youtube-url và ai-video-url."""
    cr = _normalize_copy_ratio(copy_ratio)
    pt = prompt_text

    mode = _preservation_mode_label(cr)
    # Chỉ đổi 1 lần ở tiêu đề; thứ tự dài → ngắn để không match "BALANCED" trong "HIGH-BALANCED"
    pt = re.sub(
        r"(HIGH-BALANCED COPY MODE|FULL PRESERVATION MODE|HIGH PRESERVATION MODE|BALANCED COPY MODE|PARTIAL COPY MODE)",
        mode,
        pt,
        count=1,
    )

    pt = re.sub(r"≈99%", f"≈{cr}%", pt)
    pt = re.sub(r"Giữ ≈99%", f"Giữ ≈{cr}%", pt)
    pt = re.sub(r"≈99% nội dung", f"≈{cr}% nội dung", pt)
    pt = re.sub(r"≈99\.9%", f"≈{cr}%", pt)
    if "{{copy_ratio}}" in pt:
        pt = pt.replace("{{copy_ratio}}", str(cr))

    pt = re.sub(
        r"TUYỆT ĐỐI:\s*\n- KHÔNG sáng tác[^\n]*\n- Giữ ≈\d+% nội dung transcript gốc\.\s*\n- Giữ nguyên thứ tự sự kiện và logic nhân–quả\.",
        _build_role_task_block(cr),
        pt,
        count=1,
    )
    pt = re.sub(
        r"NGUỒN VIDEO GỐC \(copy_ratio = \d+%\):[\s\S]*?- (?:Giữ nguyên thứ tự|Timeline và nhân-quả|Vẫn giữ mạch)[^\n]*\.",
        _build_role_task_block(cr),
        pt,
        count=1,
    )

    pt = re.sub(
        r"- GIỮ ≈\d+% nội dung câu gốc\. KHÔNG ngoặc kép, KHÔNG chỉ dẫn sân khấu\.",
        _build_tts_preservation_line(cr),
        pt,
        count=1,
    )
    pt = re.sub(
        r"- GIỮ ≈\d+% [^\n]+\n",
        _build_tts_preservation_line(cr) + "\n",
        pt,
        count=1,
    )

    if cr < 99:
        p0 = (
            f"\n\n📌 P0 — COPY_RATIO = {cr}% (GHI ĐÈ FULL PRESERVATION):\n"
            f"- Mọi quy tắc 'KHÔNG sáng tác' / 'FULL PRESERVATION' CHỈ áp dụng trong phạm vi {cr}% copy.\n"
            f"- Phần sáng tạo ({100 - cr}%) PHẢI tuân ROLE & TASK và QUY TẮC TỶ LỆ COPY (bổ sung bên dưới).\n"
            "- Transcript vẫn là nguồn sự thật; sáng tạo = paraphrase/lọc beat, KHÔNG bịa fact mới.\n"
        )
        if "FOUNDATION PRINCIPLE" in pt:
            pt = pt.replace("FOUNDATION PRINCIPLE", f"FOUNDATION PRINCIPLE{p0}", 1)
        else:
            pt = p0.lstrip() + pt

    if cr < 90:
        pt = re.sub(
            r"- Transcript là NGUỒN SỰ THẬT DUY NHẤT\. KHÔNG thêm địa danh, tên người, kết luận mới\.",
            "- Transcript là NGUỒN SỰ THẬT DUY NHẤT. Không thêm fact/plot mới; có thể bỏ chi tiết phụ nếu cần đạt copy_ratio.",
            pt,
            count=1,
        )

    # ai-video-url (tab Veo3 — tạo video từ link YouTube)
    if cr < 100:
        pt = re.sub(
            r"TUYỆT ĐỐI KHÔNG sáng tác, KHÔNG bịa, KHÔNG thêm ý, KHÔNG đổi thông điệp\.",
            _build_ai_video_absolute_line(cr),
            pt,
            count=1,
        )
        pt = re.sub(
            r"- KHÔNG thêm tình tiết, KHÔNG đổi ý nghĩa, KHÔNG diễn giải lại\.",
            (
                f"- Phần sáng tạo ({100 - cr}%): được paraphrase hoặc lược bỏ chi tiết phụ; "
                "KHÔNG thêm plot/fact mới, KHÔNG đổi thông điệp chính."
            ),
            pt,
            count=1,
        )
        pt = re.sub(
            r"- Giữ ≈\d+% nội dung video gốc\.",
            (
                f"- Giữ ≈{cr}% nội dung video gốc "
                "(ý chính/beat; phần còn lại paraphrase trong giới hạn copy_ratio)."
            ),
            pt,
            count=1,
        )
    if cr < 70:
        pt = re.sub(
            r"- KHÔNG sáng tác hành động mới\.",
            (
                "- Chỉ mô tả hành động có trong nguồn hoặc biến thể nhỏ phục vụ paraphrase; "
                "không bịa hành động/plot mới."
            ),
            pt,
            count=1,
        )

    return pt


def _call_gemini_generate_single_key(api_key: str, payload: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    if not genai or not types:
        return None, "Chưa cài đặt thư viện google-genai"

    api_key = str(api_key or "").strip()
    if not api_key:
        return None, "Thiếu GEMINI_API_KEY"

    prompt_id = payload.get("prompt_id") or ""
    model_name = _normalize_gemini_model(payload.get("gemini_model"))

    # 1. Lấy thông tin Input
    inp = payload.get("input", {})
    youtube_url = inp.get("youtube_url")
    topic = inp.get("topic")
    duration = _coerce_int(inp.get("duration", 60), 60)
    enable_custom_duration = _coerce_bool(inp.get("enable_custom_duration", False), default=False)  # Toggle tùy chỉnh thời lượng
    news_url = inp.get("news_url")  # [MỚI] Link bài báo
    upload_files = inp.get("upload_files", [])  # [MỚI] List các file paths cần upload
    extracted_file_path = inp.get("extracted_file_path")  # [MỚI] File đã extract (_news.txt, _story.txt, _comic.pdf)
    additional_description = inp.get("additional_description", "")  # [MỚI] Mô tả thêm
    copy_ratio = _normalize_copy_ratio(_coerce_int(inp.get("copy_ratio", 99), 99))
    ai_video_tool = str(inp.get("ai_video_tool") or "").strip().lower()
    grok_video_duration = str(inp.get("grok_video_duration") or "").strip().lower()
    is_ai_video_prompt = bool(prompt_id and prompt_id.startswith("ai-") and ("video" in prompt_id or "story" in prompt_id))
    scene_duration_seconds = 8
    if is_ai_video_prompt and ai_video_tool == "grok":
        if grok_video_duration in ("6", "6s"):
            scene_duration_seconds = 6
        elif grok_video_duration in ("10", "10s"):
            scene_duration_seconds = 10
    
    # 2. Xử lý Ngôn ngữ (Quan trọng)
    raw_lang = inp.get("language", "vi")
    # Map từ mã ngắn sang tên tiếng Anh đầy đủ để AI hiểu rõ nhất
    lang_map = {
        "vi": "Vietnamese",
        "en": "English",
        "fr": "French",
        "de": "German",
        "ru": "Russian",
        "ja": "Japanese",
        "ko": "Korean",
        "zh": "Chinese",
        "hi": "Hindi",
        "ur": "Urdu",
        "it": "Italian",
        "es": "Spanish",
        "pt": "Portuguese",
    }
    target_language = lang_map.get(raw_lang, "Vietnamese")  # Mặc định Vietnamese

    # 3. Xử lý System Instruction
    prompt_text = payload.get("system_instruction_text", "")
    addendum_parts = [
        payload.get("system_instruction_addendum_text", "") or "",
        payload.get("system_instruction_addendum_text_extra", "") or "",
    ]
    addendum_text = "\n\n".join([p.strip() for p in addendum_parts if p and p.strip()])
    if addendum_text.strip():
        # Addendum đặt ở cuối để không làm mất logic hiện có, chỉ bổ sung thêm luật.
        prompt_text = (prompt_text.rstrip() + "\n\n" + addendum_text.strip()).strip()
    
    # Thay thế placeholder {{language}} trong prompt JSON bằng ngôn ngữ thực tế
    if "{{language}}" in prompt_text:
        prompt_text = prompt_text.replace("{{language}}", target_language)
    else:
        # Nếu prompt chưa có placeholder, ta nối thêm luật vào đầu để chắc chắn
        prompt_text = f"TARGET LANGUAGE FOR TTS/AUDIO: {target_language}\n" + prompt_text

    # AI + Grok: đổi toàn bộ luật 8s trong prompt gốc thành 6s/10s theo lựa chọn người dùng.
    if is_ai_video_prompt and ai_video_tool == "grok":
        prompt_text = _rewrite_scene_duration_text(prompt_text, scene_duration_seconds)
        prompt_text = _rewrite_grok_quality_rules(prompt_text, scene_duration_seconds)
        prompt_text += _build_grok_pacing_instruction(scene_duration_seconds, target_language)
    
    # Ghi đè FULL PRESERVATION / ≈99% theo copy_ratio (chỉ YouTube URL)
    if youtube_url and youtube_url.strip():
        prompt_text = _apply_copy_ratio_to_prompt(prompt_text, copy_ratio)

        # Xử lý enable_custom_duration: override thời lượng
        if enable_custom_duration:
            # Thay thế phần "PHÂN TÍCH chính xác tổng thời lượng video gốc" bằng instruction dùng duration đã nhập
            duration_override_instruction = (
                f"\n\n⏱️ QUY TẮC THỜI LƯỢNG (DURATION RULE - OVERRIDE MODE):\n"
                f"- TỔNG THỜI LƯỢNG VIDEO MỤC TIÊU = {duration} GIÂY (TUYỆT ĐỐI TUÂN THỦ).\n"
                f"- KHÔNG phân tích thời lượng video gốc. Bỏ qua thời lượng thực tế của video YouTube.\n"
                f"- PHẢI cân bằng lại nội dung để viết kịch bản đúng {duration} giây.\n"
                f"- Chia video thành các scene LIÊN TIẾP, mỗi scene = CHÍNH XÁC {scene_duration_seconds} GIÂY.\n"
                f"- Số lượng scene = {duration} / {scene_duration_seconds} = {duration // scene_duration_seconds} scene (làm tròn lên nếu cần).\n"
                f"- Nếu video gốc dài hơn {duration}s: CHỌN LỌC và TÓM TẮT nội dung quan trọng nhất để fit vào {duration}s.\n"
                f"- Nếu video gốc ngắn hơn {duration}s: MỞ RỘNG và LÀM RÕ nội dung (giữ nguyên thông điệp chính) để đủ {duration}s.\n"
                f"- ƯU TIÊN: Giữ nguyên thông điệp chính, logic nhân-quả, và mạch truyện của video gốc.\n"
            )
            # Tìm và thay thế phần về phân tích thời lượng video gốc
            if "PHÂN TÍCH chính xác tổng thời lượng video gốc" in prompt_text:
                prompt_text = prompt_text.replace(
                    "PHÂN TÍCH chính xác tổng thời lượng video gốc",
                    f"TUÂN THỦ THỜI LƯỢNG MỤC TIÊU {duration} GIÂY (KHÔNG phân tích thời lượng video gốc)"
                )
            # Chèn instruction vào sau CORE OBJECTIVES hoặc MỤC TIÊU CỐT LÕI
            if "CORE OBJECTIVES" in prompt_text:
                idx = prompt_text.find("CORE OBJECTIVES")
                next_newline = prompt_text.find("\n", idx)
                if next_newline != -1:
                    prompt_text = prompt_text[:next_newline+1] + duration_override_instruction + prompt_text[next_newline+1:]
                else:
                    prompt_text = prompt_text.replace("CORE OBJECTIVES", f"CORE OBJECTIVES{duration_override_instruction}")
            elif "MỤC TIÊU CỐT LÕI:" in prompt_text:
                prompt_text = prompt_text.replace("MỤC TIÊU CỐT LÕI:", f"MỤC TIÊU CỐT LÕI:{duration_override_instruction}")
            else:
                # Thêm vào đầu prompt sau ROLE & TASK
                if "ROLE & TASK" in prompt_text:
                    prompt_text = prompt_text.replace("ROLE & TASK", f"ROLE & TASK{duration_override_instruction}")
                else:
                    prompt_text = duration_override_instruction + "\n" + prompt_text
        
        # Thêm câu rõ ràng về tỷ lệ copy vào system instruction
        creative_ratio = 100 - copy_ratio
        copy_instruction = (
            f"\n\n📊 QUY TẮC TỶ LỆ COPY NỘI DUNG (CONTENT COPY RATIO = {copy_ratio}%):\n"
            f"- Copy {copy_ratio}% nội dung từ video gốc (transcript, thứ tự sự kiện, logic nhân-quả, thông điệp chính).\n"
            f"- Phần còn lại ({creative_ratio}%) sáng tạo trong giới hạn: paraphrase/lược bỏ, giữ nguyên thông điệp và fact cốt lõi.\n"
            f"- Khi copy_ratio = 100%: Copy hoàn toàn, không sáng tạo thêm.\n"
            f"- Khi copy_ratio < 100%: Không thêm plot/fact mới, không đảo logic nhân-quả chính.\n"
            f"{_build_copy_ratio_tier_hint(copy_ratio)}"
        )
        # Chèn vào sau phần MỤC TIÊU CỐT LÕI hoặc CORE OBJECTIVES để dễ nhìn thấy
        if "MỤC TIÊU CỐT LÕI:" in prompt_text:
            # Chèn sau dòng đầu tiên của phần MỤC TIÊU CỐT LÕI
            prompt_text = prompt_text.replace("MỤC TIÊU CỐT LÕI:", f"MỤC TIÊU CỐT LÕI:{copy_instruction}")
        elif "CORE OBJECTIVES" in prompt_text:
            # Chèn sau CORE OBJECTIVES và dòng đầu tiên
            # Tìm vị trí sau dòng đầu tiên của CORE OBJECTIVES (sau dấu xuống dòng đầu tiên)
            idx = prompt_text.find("CORE OBJECTIVES")
            if idx != -1:
                # Tìm dấu xuống dòng đầu tiên sau CORE OBJECTIVES
                next_newline = prompt_text.find("\n", idx)
                if next_newline != -1:
                    prompt_text = prompt_text[:next_newline+1] + copy_instruction + prompt_text[next_newline+1:]
                else:
                    prompt_text = prompt_text.replace("CORE OBJECTIVES", f"CORE OBJECTIVES{copy_instruction}")
            else:
                prompt_text = prompt_text.replace("CORE OBJECTIVES", f"CORE OBJECTIVES{copy_instruction}")
        else:
            # Nếu không tìm thấy, thêm vào đầu prompt sau FOUNDATION PRINCIPLE hoặc ROLE & TASK
            if "FOUNDATION PRINCIPLE" in prompt_text:
                prompt_text = prompt_text.replace("FOUNDATION PRINCIPLE", f"FOUNDATION PRINCIPLE{copy_instruction}")
            elif "ROLE & TASK" in prompt_text:
                prompt_text = prompt_text.replace("ROLE & TASK", f"ROLE & TASK{copy_instruction}")
            else:
                # Thêm vào đầu prompt
                prompt_text = copy_instruction + "\n" + prompt_text

        if prompt_id in ("ai-video-url", "ai-video-custom"):
            prompt_text += (
                "\n\n CINEMATIC CONTINUITY & DENSITY RULE (P0 FOR AI VIDEO 8S):\n"
                "- Mỗi scene 8 giây KHÔNG nên chỉ có 1 hành động đơn lẻ; ưu tiên 2-3 chuyển biến liên tiếp có quan hệ nhân-quả. Nếu không có hành động nhân vật, dùng chuyển biến môi trường/camera/ánh sáng/thời tiết để tạo tiến triển tự nhiên.\n"
                "- Cấu trúc gợi ý trong 8s: setup ngắn -> hành động chính -> phản ứng/kết quả nhỏ (micro-payoff).\n"
                "- Scene sau phải kế thừa trạng thái scene trước (vị trí nhân vật, hướng nhìn, đạo cụ, cảm xúc, ánh sáng/thời tiết), tránh reset bối cảnh đột ngột.\n"
                "- Đảm bảo có cầu nối hình ảnh giữa các scene (camera progression, subject progression, hoặc action progression) để khi ghép 8s thành video dài vẫn mượt.\n"
                "- Tránh các cặp scene liên tiếp gần như trùng hệt nhau; scene mới phải có tiến triển rõ ràng.\n"
                "- Nếu một beat quan trọng dài hơn 8s, chia thành nhiều scene LIÊN TIẾP và giữ continuity chặt chẽ, không nhảy cóc.\n"
                "\nAUDIO SANITY RULE (ANTI-RANDOM DIALOGUE):\n"
                "- KHÔNG được sinh thoại linh tinh, KHÔNG bịa câu thoại chỉ để lấp đầy 8s.thoại chỉ dựa vào nguồn duy nhất là video , sẽ như sau video có thoại thì sinh thoại nếu không có thì để thoại trống là được\n"
            )

    temperature = payload.get("temperature", 0.7)

    client = genai.Client(api_key=api_key)
    safety_settings = [
        types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold=types.HarmBlockThreshold.BLOCK_NONE),
        types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_HARASSMENT, threshold=types.HarmBlockThreshold.BLOCK_NONE),
        types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold=types.HarmBlockThreshold.BLOCK_NONE),
        types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold=types.HarmBlockThreshold.BLOCK_NONE),
    ]

    contents = []

    # 4. Xây dựng User Prompt (Nhắc lại yêu cầu ngôn ngữ lần nữa)
    if youtube_url and youtube_url.strip():
        # Case 1: YouTube URL (Reskin)
        contents.append(types.Part.from_uri(file_uri=youtube_url, mime_type="video/mp4"))
        user_prompt = "Phân tích video theo system instruction.\n"
        user_prompt = _append_copy_ratio_user_instructions(user_prompt, copy_ratio)
        if additional_description and additional_description.strip():
            user_prompt += (
                f"\n🔥 QUAN TRỌNG - MÔ TẢ THÊM (ADDITIONAL DESCRIPTION):\n"
                f"{additional_description}\n"
                f"\nYÊU CẦU:\n"
                f"- PHẢI phân tích mô tả thêm này để hiểu yêu cầu về phong cách, bối cảnh, cách trình bày, hoặc nhân vật.\n"
                f"- Nếu mô tả đề cập đến NHÂN VẬT: TẠO cast_profiles và đảm bảo nhân vật xuất hiện trong các scene.\n"
                f"- Nếu mô tả về PHONG CÁCH/BỐI CẢNH/CÁCH TRÌNH BÀY: Áp dụng trực tiếp vào image_prompt/video_prompt, KHÔNG cần cast_profiles.\n"
                f"- Mô tả thêm này là ƯU TIÊN CAO NHẤT, phải được tích hợp vào toàn bộ kịch bản.\n"
            )
        # Thêm instruction về duration nếu enable_custom_duration = true
        if enable_custom_duration:
            user_prompt += (
                f"\n\n⏱️ THỜI LƯỢNG MỤC TIÊU (TARGET DURATION - OVERRIDE MODE):\n"
                f"- TỔNG THỜI LƯỢNG VIDEO = {duration} GIÂY (TUYỆT ĐỐI TUÂN THỦ).\n"
                f"- KHÔNG dùng thời lượng thực tế của video YouTube. Bỏ qua thời lượng video gốc.\n"
                f"- PHẢI cân bằng lại nội dung để viết kịch bản đúng {duration} giây.\n"
                f"- Chia thành {duration // scene_duration_seconds} scene (mỗi scene = {scene_duration_seconds} giây).\n"
                f"- Nếu video gốc dài: CHỌN LỌC nội dung quan trọng nhất.\n"
                f"- Nếu video gốc ngắn: MỞ RỘNG nội dung (giữ nguyên thông điệp chính).\n"
            )
        user_prompt += (
            f"\nYÊU CẦU NGÔN NGỮ (LANGUAGE REQUIREMENT):\n"
            f"- TTS_SCRIPT / Dialogues: MUST BE written in {target_language} (Tuyệt đối tuân thủ).\n"
            f"- Visual Descriptions / Prompts: Keep in English.\n"
            "Output JSON theo schema."
        )
        contents.append(types.Part.from_text(text=user_prompt))

    elif upload_files:
        # [MỚI] Case: Upload files từ folder upload lên Gemini
        file_paths = [Path(p) for p in upload_files if Path(p).exists()]
        if not file_paths:
            return None, "Không tìm thấy file nào để upload"
        
        uploaded_files, success = _upload_files_to_gemini(client, file_paths)
        if not success:
            return None, "Lỗi upload files lên Gemini"
        
        for file_obj in uploaded_files:
            contents.append(types.Part.from_uri(file_uri=file_obj.uri, mime_type=file_obj.mime_type))
        
        user_prompt = "Phân tích các file đã upload theo system instruction.\n"
        if "story-comic" in prompt_id:
            user_prompt += (
                "\nCOMIC INPUT (STRICT):\n"
                "- Đây là truyện tranh (PDF/ảnh). PHẢI đọc đủ mọi trang và mọi bubble thoại.\n"
                "- Tạo scene KHÔNG được trộn thoại giữa các trang.\n"
            )
        elif "story-text" in prompt_id:
            user_prompt += (
                "\nSTORY TEXT (TRUYỆN CHỮ) INPUT (STRICT):\n"
                "- Đây là truyện chữ: có thể là PDF, ảnh (PNG/JPG/WebP/… chứa chữ/scan), hoặc TXT.\n"
                "- PHẢI đọc toàn bộ nội dung (mọi trang/ảnh/file) và tạo scene theo mạch truyện.\n"
                "- Giữ ≈99% nội dung, thứ tự sự kiện và quan hệ nhân–quả; KHÔNG sáng tác thêm.\n"
            )
        if additional_description and additional_description.strip():
            user_prompt += (
                f"\n🔥 QUAN TRỌNG - MÔ TẢ THÊM (ADDITIONAL DESCRIPTION):\n"
                f"{additional_description}\n"
                f"\nYÊU CẦU:\n"
                f"- PHẢI phân tích mô tả thêm này để hiểu yêu cầu về phong cách, bối cảnh, cách trình bày, hoặc nhân vật.\n"
                f"- Nếu mô tả đề cập đến NHÂN VẬT: TẠO cast_profiles và đảm bảo nhân vật xuất hiện trong các scene.\n"
                f"- Nếu mô tả về PHONG CÁCH/BỐI CẢNH/CÁCH TRÌNH BÀY: Áp dụng trực tiếp vào image_prompt/video_prompt, KHÔNG cần cast_profiles.\n"
                f"- Mô tả thêm này là ƯU TIÊN CAO NHẤT, phải được tích hợp vào toàn bộ kịch bản.\n"
            )
        user_prompt += (
            f"YÊU CẦU NGÔN NGỮ (LANGUAGE REQUIREMENT):\n"
            f"- TTS_SCRIPT / Dialogues: MUST BE written in {target_language} (Tuyệt đối tuân thủ).\n"
            f"- Visual Descriptions / Prompts: Keep in English.\n"
        )
        if prompt_id and prompt_id.startswith("ai-") and ("video" in prompt_id or "story" in prompt_id):
            user_prompt += (
                f"\nQUAN TRỌNG (VIDEO {scene_duration_seconds}S): Mỗi scene {scene_duration_seconds} giây phải có chuyển động hoặc thay đổi rõ (camera/nhân vật/cảm xúc). "
                "Tránh cảnh tĩnh hoặc lặp lại. Khi ghép lại toàn bộ video phải liền mạch, có nhịp điệu, không rời rạc.\n"
            )
            if ai_video_tool == "grok":
                user_prompt += _build_grok_pacing_instruction(scene_duration_seconds, target_language)
        user_prompt += "Output JSON theo schema."
        contents.append(types.Part.from_text(text=user_prompt))

    elif extracted_file_path:
        # [MỚI] Case: File đã extract (_news.txt, _story.txt, _comic.pdf) - Upload lên Gemini
        file_path = Path(extracted_file_path)
        if not file_path.exists():
            return None, f"File đã extract không tồn tại: {extracted_file_path}"
        
        # Kiểm tra xem file có phải là file tạm không (không nằm trong upload folder)
        is_temp_file = _is_temp_file(file_path)
        
        print(f"[Script Runner] 📤 Upload file lên Gemini: {file_path}")
        if is_temp_file:
            print(f"[Script Runner] ⚠️ Đây là file tạm, sẽ xóa sau khi upload xong")
        
        uploaded_files, success = _upload_files_to_gemini(client, [file_path])
        if not success:
            # Xóa file tạm nếu upload thất bại
            if is_temp_file:
                try:
                    file_path.unlink()
                    print(f"[Script Runner] 🗑️ Đã xóa file tạm sau khi upload thất bại")
                except:
                    pass
            return None, "Lỗi upload file đã extract lên Gemini"
        
        file_obj = uploaded_files[0]
        print(f"[Script Runner] ✅ File đã upload: {file_obj.uri}")
        contents.append(types.Part.from_uri(file_uri=file_obj.uri, mime_type=file_obj.mime_type))
        
        # Xóa file tạm sau khi upload thành công
        if is_temp_file:
            try:
                file_path.unlink()
                print(f"[Script Runner] 🗑️ Đã xóa file tạm sau khi upload thành công")
            except Exception as e:
                print(f"[Script Runner] ⚠️ Không thể xóa file tạm: {e}")
        
        user_prompt = "Phân tích nội dung file đã upload theo system instruction.\n"
        if "story-comic" in prompt_id:
            user_prompt += (
                "\nCOMIC INPUT (STRICT):\n"
                "- Đây là truyện tranh (PDF/ảnh). PHẢI đọc đủ mọi trang và mọi bubble thoại.\n"
                "- Tạo scene KHÔNG được trộn thoại giữa các trang.\n"
            )
        elif "story-text" in prompt_id:
            user_prompt += (
                "\nSTORY TEXT (TRUYỆN CHỮ) INPUT (STRICT):\n"
                "- Đây là truyện chữ: có thể là PDF, ảnh (PNG/JPG/WebP/… chứa chữ/scan), hoặc TXT.\n"
                "- PHẢI đọc toàn bộ nội dung (mọi trang/ảnh/file) và tạo scene theo mạch truyện.\n"
                "- Giữ ≈99% nội dung, thứ tự sự kiện và quan hệ nhân–quả; KHÔNG sáng tác thêm.\n"
            )
        if additional_description and additional_description.strip():
            user_prompt += (
                f"\n🔥 QUAN TRỌNG - MÔ TẢ THÊM (ADDITIONAL DESCRIPTION):\n"
                f"{additional_description}\n"
                f"\nYÊU CẦU:\n"
                f"- PHẢI phân tích mô tả thêm này để hiểu yêu cầu về phong cách, bối cảnh, cách trình bày, hoặc nhân vật.\n"
                f"- Nếu mô tả đề cập đến NHÂN VẬT: TẠO cast_profiles và đảm bảo nhân vật xuất hiện trong các scene.\n"
                f"- Nếu mô tả về PHONG CÁCH/BỐI CẢNH/CÁCH TRÌNH BÀY: Áp dụng trực tiếp vào image_prompt/video_prompt, KHÔNG cần cast_profiles.\n"
                f"- Mô tả thêm này là ƯU TIÊN CAO NHẤT, phải được tích hợp vào toàn bộ kịch bản.\n"
            )
        user_prompt += (
            f"YÊU CẦU NGÔN NGỮ (LANGUAGE REQUIREMENT):\n"
            f"- TTS_SCRIPT / Dialogues: MUST BE written in {target_language} (Tuyệt đối tuân thủ).\n"
            f"- Visual Descriptions / Prompts: Keep in English.\n"
        )
        if prompt_id and prompt_id.startswith("ai-") and ("video" in prompt_id or "story" in prompt_id):
            user_prompt += (
                f"\nQUAN TRỌNG (VIDEO {scene_duration_seconds}S): Mỗi scene {scene_duration_seconds} giây phải có chuyển động hoặc thay đổi rõ (camera/nhân vật/cảm xúc). "
                "Tránh cảnh tĩnh hoặc lặp lại. Khi ghép lại toàn bộ video phải liền mạch, có nhịp điệu, không rời rạc.\n"
            )
            if ai_video_tool == "grok":
                user_prompt += _build_grok_pacing_instruction(scene_duration_seconds, target_language)
        user_prompt += "Output JSON theo schema."
        contents.append(types.Part.from_text(text=user_prompt))

    elif topic and topic.strip():
        # Case 2: Custom Topic (Creative)
        user_prompt = (
            f"CHỦ ĐỀ (TOPIC): {topic}\n"
            f"THỜI LƯỢNG MỤC TIÊU: {duration} giây.\n"
            f"YÊU CẦU NGÔN NGỮ (LANGUAGE REQUIREMENT):\n"
            f"- TTS_SCRIPT / Dialogues: MUST BE written in {target_language} (Tuyệt đối tuân thủ).\n"
            f"- Visual Descriptions / Prompts: Keep in English.\n"
        )
        if prompt_id and prompt_id.startswith("ai-") and ("video" in prompt_id or "story" in prompt_id):
            user_prompt += (
                f"\nQUAN TRỌNG (VIDEO {scene_duration_seconds}S): Mỗi scene {scene_duration_seconds} giây phải có chuyển động hoặc thay đổi rõ (camera/nhân vật/cảm xúc). "
                "Tránh cảnh tĩnh hoặc lặp lại. Khi ghép lại toàn bộ video phải liền mạch, có nhịp điệu, không rời rạc.\n"
            )
            if ai_video_tool == "grok":
                user_prompt += _build_grok_pacing_instruction(scene_duration_seconds, target_language)
        if prompt_id in ("ai-video-url", "ai-video-custom"):
            user_prompt += (
                "\n🎬 CONTINUITY RULE (AI VIDEO 8S):\n"
                "- Mỗi scene 8s nên có nhiều hơn 1 chuyển biến nhỏ (hành động -> phản ứng -> trạng thái mới).\n"
                "- Scene i+1 phải nối tiếp trực tiếp từ scene i, không reset bối cảnh hay cảm xúc vô lý.\n"
                "- Khi ghép toàn bộ scene thành video dài, mạch hành động và camera phải trôi chảy như một sequence liên tục.\n"
                "- Hạn chế lặp bố cục/hành động giữa các scene liên tiếp; mỗi scene cần có tiến triển mới.\n"
                "\n🔇 ANTI-RANDOM AUDIO:\n"
                "- Không tự bịa thoại cho nhân vật nếu không có căn cứ.\n"
                "- Ưu tiên `Audio: no voice` + `tts_script` rỗng cho các scene không cần thoại.\n"
            )
        user_prompt += "Output JSON theo schema."
        contents.append(types.Part.from_text(text=user_prompt))
    
    else:
        return None, "Thiếu đầu vào (Cần YouTube URL, Topic, News URL, Upload Files, hoặc Extracted File)"

    try:
        print(
            f"[Script Runner] 🧠 Gemini generate using model: {model_name} "
            f"(prompt_id={prompt_id!r}, temperature={temperature}, copy_ratio={copy_ratio}%)"
        )
        resp = client.models.generate_content(
            model=model_name,
            config=types.GenerateContentConfig(
                system_instruction=prompt_text,
                temperature=temperature,
                response_mime_type="application/json",
                safety_settings=safety_settings,
            ),
            contents=contents,
        )
        raw_text = getattr(resp, "text", None) or ""
        if not raw_text or not raw_text.strip():
            err_msg = "Gemini trả về response rỗng (không có text). Kiểm tra model hoặc prompt."
            print(f"[Script Runner] ❌ {err_msg}")
            return None, err_msg
        raw_text = raw_text.strip()
        try:
            data = _parse_llm_json_output(raw_text)
        except json.JSONDecodeError as je:
            print(f"[Script Runner] ❌ Parse JSON thất bại. Lỗi: {je}. Đoạn response (500 ký tự): {raw_text[:500]!r}")
            return None, f"Response không phải JSON hợp lệ: {je}"
        return data, None
    except Exception as e:
        print(f"[Script Runner] ❌ Lỗi gọi/parse Gemini: {e}")
        return None, str(e)


def call_gemini_generate(payload: Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
    if not genai or not types:
        return None, "Chưa cài đặt thư viện google-genai"

    keys = payload.get("api_keys")
    if keys is None:
        single = payload.get("api_key")
        if single:
            keys = [single]
        else:
            keys = get_gemini_api_keys()
    elif isinstance(keys, (list, tuple)):
        keys = list(keys)
    else:
        keys = [keys]

    keys = [str(k).strip() for k in keys if k is not None and str(k).strip()]
    if not keys:
        return None, "Thiếu GEMINI_API_KEY"

    api_key = keys[0]
    last_err: Optional[str] = None
    for attempt, sleep_s in enumerate((0, 2), start=1):
        if attempt > 1:
            print(f"[Script Runner] ⚠️ Gemini tạm quá tải, retry lần {attempt}/2 sau {sleep_s}s...")
            time.sleep(sleep_s)
        result, err = _call_gemini_generate_single_key(api_key, payload)
        if result is not None:
            return result, None
        last_err = err
        if not _is_gemini_transient_unavailable_error(err):
            break

    if last_err and _is_gemini_transient_unavailable_error(last_err):
        print(f"[Script Runner] ⚠️ {GEMINI_MODEL_OVERLOAD_USER_MESSAGE}")
        return None, GEMINI_MODEL_OVERLOAD_USER_MESSAGE
    return None, last_err


def generate_and_save_script(
    style_key: str, 
    language: str, 
    prompt_id: str, 
    youtube_url: str = None, 
    topic: str = None,
    duration: int = 60,
    enable_custom_duration: bool = False,  # Toggle tùy chỉnh thời lượng
    news_url: str = None,  # [MỚI] Link bài báo
    upload_files: List[str] = None,  # [MỚI] List các file paths cần upload
    extracted_file_path: str = None,  # [MỚI] File đã extract (_news.txt, _story.txt, _comic.pdf)
    additional_description: str = None,  # [MỚI] Mô tả thêm
    yt_use_reference_image: bool = False,  # YouTube: bật ảnh tham chiếu → ghép master_ref vào image_prompt
    ai_use_reference_image: bool = False,  # AI: bật ảnh tham chiếu → tạo master_cast, ghép master_ref vào video_prompt
    copy_ratio: int = 99,  # Tỷ lệ copy nội dung từ video gốc (100, 99, 90, 80, ..., 50)
    ai_video_tool: Optional[str] = None,  # AI tool: veo|grok
    grok_video_duration: Optional[str] = None,  # Grok scene duration: 6s|10s
    ai_enable_background_music: bool = True,  # AI tab: bật/tắt sinh nhạc nền (BGM) trong video_prompt
) -> Tuple[Optional[Dict[str, Any]], Optional[str], Optional[str]]:
    """
    Generate script và apply style
    
    Returns:
        Tuple[data, saved, err]: (script_data, saved_path, error_message)
    """
    prompt_cfg = get_prompt_config(prompt_id)
    if not prompt_cfg:
        return None, None, f"Prompt '{prompt_id}' không hợp lệ."

    style_cfg = get_style(style_key)
    if not style_cfg:
        return None, None, "Style không hợp lệ."

    # Điều chỉnh temperature dựa trên copy_ratio (chỉ cho YouTube URL)
    base_temperature = prompt_cfg.get("temperature", 0.2)
    if youtube_url and youtube_url.strip():
        adjusted_temperature = _temperature_for_copy_ratio(copy_ratio)
        adjusted_temperature = max(0.1, min(0.7, adjusted_temperature))
    else:
        adjusted_temperature = base_temperature
    
    payload = {
        "api_keys": get_gemini_api_keys(),
        "gemini_model": _normalize_gemini_model((get_settings() or {}).get("GEMINI_MODEL")),
        "prompt_id": prompt_id,
        "temperature": adjusted_temperature,
        "system_instruction_text": prompt_cfg.get("system_instruction_text"),
        "system_instruction_addendum_text": prompt_cfg.get("system_instruction_addendum_text"),
        "system_instruction_addendum_text_extra": prompt_cfg.get("system_instruction_addendum_text_extra"),
        "style": {
            "key": style_key,
            "name": style_cfg.get("name"),
            "description": style_cfg.get("description"),
            "prompt": style_cfg.get("prompt"),
        },
        "input": {
            "youtube_url": youtube_url,
            "topic": topic,
            "language": language,
            "duration": duration,
            "enable_custom_duration": enable_custom_duration,
            "news_url": news_url,
            "upload_files": upload_files or [],
            "extracted_file_path": extracted_file_path,
            "additional_description": additional_description or "",
            "copy_ratio": copy_ratio,
            "ai_video_tool": ai_video_tool,
            "grok_video_duration": grok_video_duration,
            "ai_enable_background_music": ai_enable_background_music,
        },
    }

    result, err = call_gemini_generate(payload)
    if err or not result:
        return None, None, f"Lỗi Gemini: {err}"

    if youtube_url and youtube_url.strip() and isinstance(result, dict):
        _cr = _normalize_copy_ratio(_coerce_int(copy_ratio, 99))
        meta = result.get("meta")
        if not isinstance(meta, dict):
            meta = {}
        meta["content_preservation"] = f"≈{_cr}%"
        result["meta"] = meta

    style_prompt = payload["style"]["prompt"]
    result = _apply_style_to_scenes(
        result,
        style_prompt,
        prompt_id=prompt_id,
        yt_use_reference_image=yt_use_reference_image,
        ai_use_reference_image=ai_use_reference_image,
    )

    # AI Tab: xử lý riêng phần BGM nếu tắt nhạc nền
    if prompt_id and prompt_id.startswith("ai-") and (
        "video" in prompt_id or "story" in prompt_id
    ):
        # Nếu tắt nhạc nền: ép BGM thành thông điệp no‑BGM rõ ràng
        if not ai_enable_background_music:
            import re

            scenes = result.get("scenes") or []
            for scene in scenes:
                vp = scene.get("video_prompt")
                if not isinstance(vp, str) or "BGM:" not in vp:
                    continue
                new_vp = re.sub(
                    r"BGM:\s*.*",
                    "BGM: No background music, no soundtrack, no score. Use only natural sounds from the scene if any.",
                    vp,
                )
                scene["video_prompt"] = new_vp
            result["scenes"] = scenes

        # Hậu xử lý lần cuối: nối bộ luật STRICT cho mọi scene AI video/story
        result = _append_strict_ai_video_rules(
            result,
            prompt_id=prompt_id,
            ai_use_reference_image=ai_use_reference_image,
        )

    return result, None, None


def merge_script_results(results: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Gộp nhiều JSON kịch bản (cùng schema) thành một:
    - cast_profiles: gộp và loại trùng theo name
    - voice_bank: gộp và loại trùng theo id
    - scenes: nối tiếp và renumber scene_id từ 1..N
    - meta: lấy từ kết quả đầu tiên, cập nhật lại total_scenes
    """
    if not results:
        return {}

    # Khởi tạo meta từ kết quả đầu tiên
    base = results[0] or {}
    final_meta = dict(base.get("meta") or {})

    cast_by_name: Dict[str, Dict[str, Any]] = {}
    voice_by_id: Dict[str, Dict[str, Any]] = {}
    all_scenes: List[Dict[str, Any]] = []

    for res in results:
        if not res:
            continue

        for cp in res.get("cast_profiles") or []:
            name = cp.get("name")
            if not name or name in cast_by_name:
                continue
            cast_by_name[name] = cp

        for vb in res.get("voice_bank") or []:
            vid = vb.get("id")
            if not vid or vid in voice_by_id:
                continue
            voice_by_id[vid] = vb

        for sc in res.get("scenes") or []:
            all_scenes.append(sc)

    # Renumber scene_id liên tục
    merged_scenes: List[Dict[str, Any]] = []
    for idx, sc in enumerate(all_scenes, start=1):
        sc_copy = dict(sc)
        try:
            sc_copy["scene_id"] = int(idx)
        except Exception:
            sc_copy["scene_id"] = idx
        merged_scenes.append(sc_copy)

    final_meta["total_scenes"] = len(merged_scenes)

    merged: Dict[str, Any] = {
        "meta": final_meta,
        "cast_profiles": list(cast_by_name.values()),
        "voice_bank": list(voice_by_id.values()),
        "scenes": merged_scenes,
    }

    # Giữ lại các field khác (nếu có) từ base
    for key, value in base.items():
        if key in merged:
            continue
        merged[key] = value

    return merged


def _normalize_name_key(name: str) -> str:
    """
    Chuẩn hóa khóa so sánh tên nhân vật:
    - strip khoảng trắng
    - bỏ dấu (unicode accent)
    - lower-case
    → Dùng để gom các biến thể \"TINH HA\", \"Tinh Hà\", \"tinh ha\" vào cùng một nhóm.
    """
    if not isinstance(name, str):
        return ""
    raw = name.strip()
    if not raw:
        return ""
    # Bỏ dấu
    nfkd = unicodedata.normalize("NFKD", raw)
    no_accents = "".join(ch for ch in nfkd if not unicodedata.combining(ch))
    # Chuẩn hóa: coi khoảng trắng, gạch dưới, gạch ngang và ký tự không chữ/số là giống nhau
    # → \"Tinh Hà\", \"Tinh_Ha\", \"TINH-HA\" đều về cùng 1 key.
    cleaned_chars = []
    for ch in no_accents:
        if ch.isalnum():
            cleaned_chars.append(ch.lower())
        # các ký tự khác (space, _, -, ...) bị bỏ qua hoàn toàn
    return "".join(cleaned_chars)


def _pick_canonical_name(variants: List[str]) -> str:
    """
    Chọn 1 tên chuẩn dùng xuyên suốt:
    - Ưu tiên biến thể CÓ dấu tiếng Việt (nếu có).
    - Nếu không có dấu, lấy biến thể đầu tiên.
    """
    if not variants:
        return ""

    def has_accent(s: str) -> bool:
        # Có ký tự kết hợp hoặc ký tự Việt thường gặp
        for ch in s:
            if unicodedata.combining(ch):
                return True
            codepoint = ord(ch)
            # Dải ký tự Latin bổ sung thường chứa chữ có dấu (đủ tốt cho heuristic)
            if 0x00C0 <= codepoint <= 0x024F:
                return True
        return False

    accented = [v for v in variants if has_accent(v)]
    if accented:
        return accented[0]
    return variants[0]


def _contains_minor_signal(text: str) -> bool:
    if not text:
        return False

    low = text.lower()

    # Ưu tiên bắt mẫu tuổi rõ ràng (<18)
    if re.search(r"\b([0-9]|1[0-7])\s*[- ]?year[- ]?old\b", low):
        return True
    if re.search(r"\b([0-9]|1[0-7])\s*tuoi\b", low) or re.search(r"\b([0-9]|1[0-7])\s*tuổi\b", low):
        return True

    # Heuristic từ khóa dưới tuổi vị thành niên
    minor_keywords = (
        "minor",
        "underage",
        "child",
        "kid",
        "toddler",
        "preteen",
        "teen",
        "teenage",
        "schoolboy",
        "schoolgirl",
        "trẻ em",
        "thiếu niên",
        "vị thành niên",
        "em bé",
        "bé trai",
        "bé gái",
    )
    return any(token in low for token in minor_keywords)


def _is_underage_character_profile(char: Dict[str, Any]) -> bool:
    if not isinstance(char, dict):
        return False

    age_value = str(char.get("age", "") or "")
    visual_signature = str(char.get("visual_signature", "") or "")
    profile_text = str(char.get("description", "") or "")
    name = str(char.get("name", "") or "")
    combined = " | ".join([name, age_value, profile_text, visual_signature])
    return _contains_minor_signal(combined)


def _resolve_master_cast_prompt_prefix() -> str:
    """Lấy prefix từ prompts.enc (master-cast-image); lỗi → default trong code."""
    try:
        return get_master_cast_image_prompt_prefix()
    except Exception as e:
        print(f"[Master Prompt] FALLBACK built-in default: {e}")
        return DEFAULT_MASTER_CAST_IMAGE_PROMPT_TEXT


def _build_master_cast_image_prompt(joined_chars: str, style_prompt: str = "") -> str:
    """Ghép style (nếu có) + prompt master (prompts.enc / fallback) + danh sách nhân vật."""
    core = f"{_resolve_master_cast_prompt_prefix()}{joined_chars}."
    style = (style_prompt or "").strip().rstrip(".")
    if style:
        return f"{style}. {core}"
    return core


def finalize_script_output(
    data: Dict[str, Any],
    style_key: str,
    prompt_id: str,
    yt_use_reference_image: bool = False,
    ai_use_reference_image: bool = False,
    restrict_minor_reference_violation: bool = False,
) -> Dict[str, Any]:
    """
    BƯỚC CUỐI CÙNG:
    - Sau khi đã gọi Gemini (có thể multi-pass + merge) và áp style cho scenes.
    - Chuẩn hóa TÊN NHÂN VẬT cho đồng bộ ở mọi nơi.
    - Gộp trùng cast_profiles / voice_bank sau khi chuẩn hóa.
    - Tạo master_cast_image_prompt: AI tab từ cast_profiles; YouTube tab (khi yt_use_reference_image) từ character_profiles.
    """
    if not data:
        return data

    # 1. Gom tất cả biến thể tên nhân vật từ cast_profiles + voice_bank
    cast_profiles = data.get("cast_profiles") or []
    voice_bank = data.get("voice_bank") or []

    groups: Dict[str, List[str]] = {}

    for cp in cast_profiles:
        name = (cp.get("name") or "").strip()
        if not name:
            continue
        key = _normalize_name_key(name)
        if not key:
            continue
        groups.setdefault(key, [])
        if name not in groups[key]:
            groups[key].append(name)

    for vb in voice_bank:
        vid = (vb.get("id") or "").strip()
        if not vid or vid.upper() == "NARRATOR":
            continue
        key = _normalize_name_key(vid)
        if not key:
            continue
        groups.setdefault(key, [])
        if vid not in groups[key]:
            groups[key].append(vid)

    # 2. Xây map từ mọi biến thể -> tên chuẩn
    variant_to_canonical: Dict[str, str] = {}
    for key, variants in groups.items():
        canonical = _pick_canonical_name(variants)
        for v in variants:
            variant_to_canonical[v] = canonical
            # Thêm luôn các biến thể upper-case để bắt được TINH HÀ, TINH_HA trong video/tts
            variant_to_canonical[v.upper()] = canonical

    # 3. Áp map vào cast_profiles
    normalized_cast: Dict[str, Dict[str, Any]] = {}
    for cp in cast_profiles:
        name = (cp.get("name") or "").strip()
        if not name:
            continue
        canonical = variant_to_canonical.get(name, name)
        new_cp = dict(cp)
        new_cp["name"] = canonical
        # Nếu trùng tên chuẩn, ưu tiên giữ entry đầu tiên
        if canonical not in normalized_cast:
            normalized_cast[canonical] = new_cp

    # 4. Áp map vào voice_bank
    normalized_voice: Dict[str, Dict[str, Any]] = {}
    for vb in voice_bank:
        vid = (vb.get("id") or "").strip()
        if not vid:
            continue
        if vid.upper() == "NARRATOR":
            # Giữ nguyên narrator
            normalized_voice["NARRATOR"] = dict(vb, id="NARRATOR")
            continue
        canonical = variant_to_canonical.get(vid, vid)
        new_vb = dict(vb)
        new_vb["id"] = canonical
        if canonical not in normalized_voice:
            normalized_voice[canonical] = new_vb

    data["cast_profiles"] = list(normalized_cast.values())
    data["voice_bank"] = list(normalized_voice.values())

    # 5. Thay thế tên trong scenes (video_prompt + tts_script) cho đồng bộ
    scenes = data.get("scenes") or []
    if variant_to_canonical:
        # Duyệt từng mapping, replace chuỗi thô (đủ an toàn vì tên thường là cụm riêng)
        for scene in scenes:
            vp = scene.get("video_prompt")
            ts = scene.get("tts_script")
            if isinstance(vp, str):
                for old, new in variant_to_canonical.items():
                    if old != new and old in vp:
                        vp = vp.replace(old, new)
                scene["video_prompt"] = vp
            if isinstance(ts, str):
                for old, new in variant_to_canonical.items():
                    if old != new and old in ts:
                        ts = ts.replace(old, new)
                scene["tts_script"] = ts

    data["scenes"] = scenes

    # 6. Tạo master_cast_image_prompt: AI tab (khi ai_use_reference_image) từ cast_profiles;
    #    YouTube tab (khi yt_use_reference_image) từ character_profiles
    is_ai_tab = bool(prompt_id and prompt_id.startswith("ai-"))
    is_youtube_tab = bool(prompt_id and prompt_id.startswith("youtube-"))
    char_profiles = data.get("cast_profiles") or data.get("character_profiles") or []
    need_master_prompt = char_profiles and (
        (is_ai_tab and ai_use_reference_image)
        or (is_youtube_tab and yt_use_reference_image)
    )
    if need_master_prompt:
        style_cfg = get_style(style_key)
        style_prompt = (style_cfg or {}).get("prompt") or ""
        char_descriptions: List[str] = []
        for char in char_profiles:
            name = (char.get("name") or "").strip()
            desc = (char.get("visual_signature", "") or "").strip().rstrip(".")
            if not name or not desc:
                continue
            if restrict_minor_reference_violation and _is_underage_character_profile(char):
                print(f"[Master Prompt] ⛔ Bỏ nhân vật vị thành niên khỏi ảnh tham chiếu: {name}")
                continue
            char_descriptions.append(f"{name} ( {desc}. )")
        if char_descriptions:
            joined_chars = ". ".join(char_descriptions)
            data["master_cast_image_prompt"] = _build_master_cast_image_prompt(
                joined_chars, style_prompt
            )

    assign_scene_characters_from_profiles(data)
    return data


def sanitize_scenes(scenes: list[Dict[str, Any]]) -> Tuple[Optional[list[Dict[str, Any]]], Optional[str]]:
    """
    Sanitize một hoặc nhiều scene để fix policy violations
    
    Args:
        scenes: List các scene cần sanitize (format đầy đủ từ JSON)
    
    Returns:
        Tuple[Optional[list], Optional[str]]: (sanitized_scenes, error_message)
    """
    if not genai or not types:
        return None, "Chưa cài đặt thư viện google-genai"
    
    keys = get_gemini_api_keys()
    if not keys:
        return None, "Thiếu GEMINI_API_KEY"
    api_key = str(keys[0]).strip()
    if not api_key:
        return None, "Thiếu GEMINI_API_KEY"
    
    model_name = _normalize_gemini_model((get_settings() or {}).get("GEMINI_MODEL"))

    # 1. Lấy prompt config
    prompt_cfg = get_prompt_config("sanitize-scenes")
    if not prompt_cfg:
        return None, "Prompt 'sanitize-scenes' không tồn tại"
    
    system_instruction = prompt_cfg.get("system_instruction_text", "")
    addendum_text = prompt_cfg.get("system_instruction_addendum_text", "") or ""
    if addendum_text.strip():
        system_instruction = (system_instruction.rstrip() + "\n\n" + addendum_text.strip()).strip()
    temperature = prompt_cfg.get("temperature", 0.3)
    
    # 2. Xây dựng user prompt
    user_prompt = f"Viết lại scene(s) sau để tránh vi phạm chính sách:\n\n{json.dumps(scenes, ensure_ascii=False, indent=2)}"
    
    # 3. Gọi Gemini
    try:
        client = genai.Client(api_key=api_key)
        print(f"[Script Runner] 🧽 Gemini sanitize using model: {model_name}")
        safety_settings = [
            types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold=types.HarmBlockThreshold.BLOCK_NONE),
            types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_HARASSMENT, threshold=types.HarmBlockThreshold.BLOCK_NONE),
            types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold=types.HarmBlockThreshold.BLOCK_NONE),
            types.SafetySetting(category=types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold=types.HarmBlockThreshold.BLOCK_NONE),
        ]
        
        resp = client.models.generate_content(
            model=model_name,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=temperature,
                response_mime_type="application/json",
                safety_settings=safety_settings,
            ),
            contents=[types.Part.from_text(text=user_prompt)],
        )
        
        raw_text = getattr(resp, "text", None)
        if raw_text is None:
            return None, "Sanitize failed: model returned empty response text"
        raw_text = raw_text.strip()
        if not raw_text:
            return None, "Sanitize failed: model returned blank JSON"

        try:
            sanitized_scenes = _parse_llm_json_output(raw_text)
        except json.JSONDecodeError as e:
            return None, f"Sanitize failed: invalid JSON from model: {e}"
        if not isinstance(sanitized_scenes, list):
            return None, "Sanitize failed: response is not a JSON array"
        return sanitized_scenes, None
        
    except Exception as e:
        return None, str(e)
