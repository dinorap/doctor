import os
import subprocess
import json
import logging
import tempfile
import random
import datetime
import re
import sys
from typing import List, Optional

# Setup Logger
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger("MediaEngine")

# --- FFMPEG PATH (prefer bundled for EXE stability) ---
def _get_ffmpeg_path() -> str:
    """
    Priority:
    1) Bundled ffmpeg next to exe: <exe_dir>/ffmpeg/ffmpeg.exe
    2) imageio-ffmpeg managed binary
    3) system ffmpeg in PATH
    """
    try:
        exe_dir = os.path.dirname(sys.executable) if getattr(sys, "frozen", False) else None
        if exe_dir:
            bundled = os.path.join(exe_dir, "ffmpeg", "ffmpeg.exe")
            if os.path.isfile(bundled):
                return bundled
    except Exception:
        pass

    try:
        import imageio_ffmpeg  # type: ignore
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


FFMPEG_PATH = _get_ffmpeg_path()


def _ffmpeg_lists_encoder(encoder: str) -> bool:
    try:
        res = subprocess.run([FFMPEG_PATH, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=8)
        return encoder in (res.stdout or "")
    except Exception:
        return False


def _ffmpeg_lists_filter(filter_name: str) -> bool:
    try:
        res = subprocess.run([FFMPEG_PATH, "-hide_banner", "-filters"], capture_output=True, text=True, timeout=8)
        return filter_name in (res.stdout or "")
    except Exception:
        return False


def _test_nvenc_encode() -> bool:
    """
    Real runtime test to avoid: "detected" -> fail during render.
    Encode ~1s synthetic video using h264_nvenc, discard output.
    """
    try:
        # Use lavfi testsrc and discard to null muxer.
        # -f null - works across platforms; ffmpeg will still initialize NVENC.
        cmd = [
            FFMPEG_PATH,
            "-hide_banner",
            "-loglevel", "error",
            "-f", "lavfi",
            "-i", "testsrc=size=1280x720:rate=30",
            "-t", "1",
            "-c:v", "h264_nvenc",
            "-preset", "p4",
            "-f", "null",
            "-",
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=12)
        if res.returncode == 0:
            return True
        err = (res.stderr or "").strip()
        # Log a short reason for easier support.
        if err:
            logger.warning(f"⚠️ NVENC runtime test failed: {err.splitlines()[-1]}")
        return False
    except subprocess.TimeoutExpired:
        logger.warning("⚠️ NVENC runtime test timeout. Using CPU encoder.")
        return False
    except Exception as e:
        logger.warning(f"⚠️ NVENC runtime test error: {e}. Using CPU encoder.")
        return False

def _check_gpu():
    """
    Stable GPU detect:
    - First: check ffmpeg lists encoder (compile-time support)
    - Then: run a real 1s NVENC encode test (runtime support)
    """
    try:
        if not _ffmpeg_lists_encoder("h264_nvenc"):
            logger.info("ℹ️ NVIDIA GPU encoder not found in FFmpeg. Using CPU encoder (libx264).")
            return False

        if _test_nvenc_encode():
            logger.info("✅ NVIDIA GPU encoder (h264_nvenc) OK. Will use GPU with CPU fallback.")
            return True

        logger.info("ℹ️ NVENC present but not usable at runtime. Using CPU encoder (libx264).")
        return False
    except Exception as e:
        logger.warning(f"⚠️ GPU check error: {e}. Using CPU encoder.")
        return False

HAS_GPU = _check_gpu()


def _check_cuda_filters() -> bool:
    """
    Check CUDA filter availability for GPU-accelerated scaling in filter graph.
    """
    if not HAS_GPU:
        return False

    required = ["scale_cuda", "hwupload_cuda", "hwdownload"]
    missing = [f for f in required if not _ffmpeg_lists_filter(f)]
    if missing:
        logger.info(f"ℹ️ CUDA filters missing ({', '.join(missing)}). Using CPU filters.")
        return False

    logger.info("✅ CUDA filters OK. Will use GPU scaling for zoom/pan.")
    return True


HAS_CUDA_FILTERS = _check_cuda_filters()

class MediaEngine:
    # [ĐÃ XÓA CHỮ 'a' THỪA Ở ĐÂY]

    @staticmethod
    def _safe_mp4_settings(include_audio: bool = True) -> List[str]:
        """
        MP4 settings ưu tiên tương thích playback (Windows Media Player, v.v.)
        - ép pix_fmt yuv420p để tránh High 4:4:4 Predictive / yuv444p
        - +faststart để metadata nằm đầu file (stream-friendly)
        - audio AAC phổ biến
        """
        settings: List[str] = [
            *MediaEngine._get_encode_settings(),
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
        ]
        if include_audio:
            settings.extend(["-c:a", "aac", "-b:a", "192k"])
        return settings

    @staticmethod
    def _run(cmd: List[str], fallback_to_cpu: bool = True) -> bool:
        """
        Chạy FFmpeg command với fallback tự động sang CPU nếu GPU lỗi
        """
        try:
            # Debug command: luôn log khi ffmpeg fail để dễ truy vết filtergraph/codec
            cmd_preview = " ".join(cmd)
            res = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
            if res.returncode != 0:
                # Kiểm tra nếu lỗi do GPU encoder
                stderr = res.stderr
                gpu_errors = ['nvcuda.dll', 'Error opening encoder', 'Cannot load nvcuda', 'Cannot load nvenc']
                
                cmd_str = cmd_preview
                # Chỉ fallback nếu đang dùng h264_nvenc và gặp lỗi GPU
                if fallback_to_cpu and 'h264_nvenc' in cmd_str and any(err in stderr for err in gpu_errors):
                    logger.warning("⚠️ GPU encoder failed. Retrying with CPU encoder (libx264)...")
                    # Thay thế h264_nvenc bằng libx264 và các preset tương ứng
                    new_cmd = []
                    skip_next = False
                    for i, arg in enumerate(cmd):
                        if skip_next:
                            skip_next = False
                            continue
                        if arg == '-c:v' and i + 1 < len(cmd) and cmd[i + 1] == 'h264_nvenc':
                            new_cmd.append('-c:v')
                            new_cmd.append('libx264')
                            skip_next = True
                        elif arg == '-preset' and i + 1 < len(cmd) and cmd[i + 1] in ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']:
                            new_cmd.append('-preset')
                            new_cmd.append('ultrafast')  # CPU preset nhanh
                            skip_next = True
                        elif arg == '-rc' and i + 1 < len(cmd) and cmd[i + 1] == 'vbr':
                            # Bỏ qua -rc vbr cho CPU, thay bằng -crf
                            skip_next = True
                            if i + 2 >= len(cmd) or cmd[i + 2] != '-crf':
                                new_cmd.append('-crf')
                                new_cmd.append('23')
                        else:
                            new_cmd.append(arg)
                    
                    # Thử lại với CPU encoder
                    res = subprocess.run(new_cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
                    if res.returncode == 0:
                        logger.info("✅ Successfully encoded with CPU encoder.")
                        return True
                    else:
                        logger.error(f"❌ FFmpeg Error (CPU fallback also failed).\nCMD: {cmd_str}\n{res.stderr}")
                        return False
                else:
                    logger.error(f"❌ FFmpeg Error.\nCMD: {cmd_str}\n{stderr}")
                    return False
            return True
        except Exception as e:
            logger.error(f"❌ Exception: {e}")
            return False

    @staticmethod
    def _get_encode_settings():
        if HAS_GPU: return ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'vbr']
        return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23']

    @staticmethod
    def get_duration(path: str) -> float:
        """
        Lấy độ dài file bằng FFMPEG (không cần ffprobe) để tránh lỗi thiếu tool.
        """
        if not os.path.exists(path):
            # Avoid printing unicode to non-UTF8 consoles
            logger.warning(f"[Check Duration] File not found: {path}")
            return 0.0
        
        try:
            # Cách 1: Dùng ffmpeg -i và parse stderr (Chắc chắn chạy được nếu ffmpeg chạy được)
            cmd = [FFMPEG_PATH, '-hide_banner', '-i', path]
            res = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
            
            # Tìm chuỗi: Duration: 00:00:05.32
            match = re.search(r"Duration:\s*(\d{2}):(\d{2}):(\d{2}\.\d{2})", res.stderr)
            if match:
                h, m, s = match.groups()
                total_seconds = int(h) * 3600 + int(m) * 60 + float(s)
                return total_seconds
            
            return 0.0
        except Exception as e:
            print(f"❌ Lỗi lấy duration file {path}: {e}")
            return 0.0

    @staticmethod
    def get_video_fps(path: str) -> float:
        """
        Lấy FPS video bằng cách parse output của `ffmpeg -i`.
        Tránh dùng ffprobe để không phụ thuộc tool ngoài.
        """
        if not os.path.exists(path):
            return 0.0
        try:
            cmd = [FFMPEG_PATH, "-hide_banner", "-i", path]
            res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore")
            stderr = res.stderr or ""
            # Ví dụ: "... 1280x720, 4865 kb/s, 24 fps, 24 tbr, 12288 tbn ..."
            m = re.search(r"(\d+(?:\.\d+)?)\s*fps", stderr)
            if m:
                fps = float(m.group(1))
                if fps > 0:
                    return fps
            # Fallback: đôi khi chỉ có tbr
            m2 = re.search(r"(\d+(?:\.\d+)?)\s*tbr", stderr)
            if m2:
                fps = float(m2.group(1))
                if fps > 0:
                    return fps
            return 0.0
        except Exception:
            return 0.0

    @staticmethod
    def get_dimensions(path: str):
        """
        Lấy (width, height) bằng cách parse `ffmpeg -i`.
        Trả về fallback (1920, 1080) nếu không đọc được.
        """
        if not os.path.exists(path):
            return 1920, 1080
        try:
            cmd = [FFMPEG_PATH, "-hide_banner", "-i", path]
            res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="ignore")
            stderr = res.stderr or ""
            # Ví dụ: "... Video: h264 ..., yuv420p, 1920x1080, ..."
            m = re.search(r"Video:\s.*?(\d{2,5})x(\d{2,5})", stderr)
            if m:
                w = int(m.group(1))
                h = int(m.group(2))
                if w > 0 and h > 0:
                    return w, h
            return 1920, 1080
        except Exception:
            return 1920, 1080

    @staticmethod
    def has_audio_stream(path: str) -> bool:
        # Check đơn giản bằng cách xem log ffmpeg có Audio: hay không
        try:
            cmd = [FFMPEG_PATH, '-hide_banner', '-i', path]
            res = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore')
            return "Audio:" in res.stderr
        except: return False

    # --------------------------------------------------------------------------
    # 1. TẠO VIDEO TỪ ẢNH + AUDIO
    # --------------------------------------------------------------------------
    @staticmethod
    def image_to_video(image_path: str, output_path: str, duration: float, effect: str = "random", audio_path: str = None):
        if not os.path.exists(image_path): return False

        try:
            # Mặc định Full HD
            w, h = 1920, 1080 
            fps = 30 
            frames = int(duration * fps) + 30 
            s = f"{w}x{h}"
            use_cuda_filters = HAS_CUDA_FILTERS
            
            # Logic xử lý hiệu ứng
            if effect == 'static':
                vf_cpu = f"scale={w}:{h}"
                vf_gpu = f"hwupload_cuda,scale_cuda={w}:{h},hwdownload,format=yuv420p"
            else:
                valid_effects = ['zoom_in', 'zoom_out', 'pan_left', 'pan_right', 'pan_up', 'pan_down']
                if effect == 'random' or effect not in valid_effects:
                    effect = random.choice(valid_effects)

                if effect == 'zoom_in': expr = f"z='min(zoom+0.0005,1.15)':d={frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
                elif effect == 'zoom_out': expr = f"z='max(zoom-0.0005,1.0)':d={frames}:zoom=1.15:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
                elif effect == 'pan_left': expr = f"z='1.1':d={frames}:x='(iw-iw/1.1)-((iw-iw/1.1)-(iw/2-iw/1.1/2))*on/{frames}':y='ih/2-(ih/1.1/2)'"
                elif effect == 'pan_right': expr = f"z='1.1':d={frames}:x='(iw/2-iw/1.1/2)*on/{frames}':y='ih/2-(ih/1.1/2)'"
                elif effect == 'pan_up': expr = f"z='1.1':d={frames}:x='iw/2-(iw/1.1/2)':y='(ih-ih/1.1)-((ih-ih/1.1)-(ih/2-ih/1.1/2))*on/{frames}'"
                elif effect == 'pan_down': expr = f"z='1.1':d={frames}:x='iw/2-(iw/1.1/2)':y='(ih/2-ih/1.1/2)*on/{frames}'"
                else: expr = f"z='1.0':d={frames}:x='0':y='0'"

                vf_cpu = f"scale=2560:-1,zoompan={expr}:s={s}"
                vf_gpu = f"hwupload_cuda,scale_cuda=8000:-1,hwdownload,format=yuv420p,zoompan={expr}:s={s}"

            vf = vf_gpu if use_cuda_filters else vf_cpu

            def _build_cmd(vf_value: str) -> List[str]:
                cmd = [FFMPEG_PATH, '-y', '-loop', '1', '-framerate', str(fps), '-i', image_path]
                if audio_path and os.path.exists(audio_path):
                    cmd.extend(['-i', audio_path])
                    cmd.extend([
                        '-vf', vf_value, 
                        '-c:v', 'h264_nvenc' if HAS_GPU else 'libx264',
                        '-c:a', 'aac', '-b:a', '192k',
                        '-map', '0:v', '-map', '1:a',
                        '-shortest', 
                        '-pix_fmt', 'yuv420p',
                        '-movflags', '+faststart',
                    ])
                    if HAS_GPU: cmd.extend(['-preset', 'p4'])
                    else: cmd.extend(['-preset', 'ultrafast'])
                else:
                    cmd.extend([
                        '-t', str(duration),
                        '-vf', vf_value,
                        '-pix_fmt', 'yuv420p',
                        *MediaEngine._get_encode_settings(),
                        '-movflags', '+faststart',
                    ])
                cmd.append(output_path)
                return cmd

            cmd = _build_cmd(vf)
            ok = MediaEngine._run(cmd)
            if not ok and use_cuda_filters:
                logger.warning("⚠️ CUDA filter chain failed. Retrying with CPU filters.")
                cmd = _build_cmd(vf_cpu)
                return MediaEngine._run(cmd)
            return ok

        except Exception as e:
            logger.error(f"❌ Image2Video Error: {e}")
            return False

    # --------------------------------------------------------------------------
    # 2. GHÉP NHIỀU VIDEO (có thể dùng hiệu ứng chuyển cảnh xfade)
    # --------------------------------------------------------------------------
    # Map tên hiệu ứng UI -> tên transition của FFmpeg xfade
    XFADE_TRANSITIONS = {
        "none": None,
        # ------------------------------------------------------------------
        # Nhóm KEY TIẾNG VIỆT (UI kiểu CapCut) — giữ tương thích với frontend mới
        # ------------------------------------------------------------------
        # --- NHÓM 1: FADE & HÒA TRỘN ---
        "mo_dan": "fade",              # 1. Mờ dần
        "mo_ra": "fade",               # 2. Mờ ra
        "hoa_tron": "dissolve",        # 3. Hòa trộn
        "mo_sang_den": "fadeblack",    # 4. Mờ sang đen
        "mo_sang_trang": "fadewhite",  # 5. Mờ sang trắng
        "nhay_trang": "fadewhite",     # 19. Nháy trắng (thường duration rất ngắn ~0.2s)

        # --- NHÓM 2: TRƯỢT & ĐẨY ---
        "truot_trai": "slideleft",     # 11. Trượt trái
        "truot_phai": "slideright",    # 12. Trượt phải
        "truot_len": "slideup",        # 13. Trượt lên
        "truot_xuong": "slidedown",    # 14. Trượt xuống
        "day_canh": "wipeleft",        # 15. Đẩy cảnh

        # --- NHÓM 3: ZOOM (THU PHÓNG) ---
        "thu_phong_vao": "zoomin",     # 7. Thu phóng vào
        "thu_phong_ra": "circleclose",     # 8. Thu phóng ra
        "thu_phong_ong_kinh": "zoomin",# 9. Thu phóng ống kính (fallback)
        "thu_phong_3d": "zoomin",      # 20. Thu phóng 3D (fallback)

        # --- NHÓM 4: CHUYỂN ĐỘNG & ĐẶC BIỆT ---
        "chuyen_canh_muot": "distance",   # 6. Chuyển cảnh mượt
        "lam_mo_chuyen_dong": "hblur",    # 10. Làm mờ chuyển động
        "xoay_tron": "radial",            # 16. Xoay tròn
        "lat": "squeezeh",                # 17. Lật
        "glitch": "pixelize",             # 18. Nhiễu Glitch (fallback gần nhất)

        # ------------------------------------------------------------------
        # Nhóm KEY TIẾNG ANH (legacy) — giữ tương thích với frontend cũ
        # ------------------------------------------------------------------
        "fade": "fade",
        "fade_out": "fade",
        "dissolve": "dissolve",
        "fade_black": "fadeblack",
        "fade_white": "fadewhite",
        "smooth": "fade",
        "zoomin": "zoomin",
        "zoomout": "circleclose",
        "lens_zoom": "zoomin",
        "motion_blur": "hblur",
        "slide_left": "slideleft",
        "slide_right": "slideright",
        "slide_up": "slideup",
        "slide_down": "slidedown",
        "push": "wipeleft",
        "spin": "radial",
        "flip": "squeezeh",
        "glitch": "pixelize",
        "white_flash": "fadewhite",
        "zoom_3d": "zoomin",
        # FFmpeg xfade còn hỗ trợ: wipeleft, wiperight, wipeup, wipedown, rectcrop, circleopen, circleclose, ...
    }

    @staticmethod
    def merge_videos(
        video_list: List[str],
        output_path: str,
        transition: Optional[str] = None,
        transition_duration: float = 1.0,
    ):
        """
        Ghép nhiều video. Nếu transition != None và có ít nhất 2 video thì dùng xfade.
        transition: key trong XFADE_TRANSITIONS (none, fade, dissolve, slide_left, ...).
        transition_duration: thời gian hiệu ứng (giây).
        """
        if not video_list:
            return False

        use_xfade = (
            transition
            and transition != "none"
            and len(video_list) >= 2
            and MediaEngine.XFADE_TRANSITIONS.get(transition) is not None
        )
        xfade_type = MediaEngine.XFADE_TRANSITIONS.get(transition) if use_xfade else None

        if not use_xfade or xfade_type is None:
            # Ghép đơn giản (concat demuxer) như cũ
            list_file = os.path.join(tempfile.gettempdir(), f"concat_{random.randint(10000, 99999)}.txt")
            try:
                with open(list_file, "w", encoding="utf-8") as f:
                    for v in video_list:
                        safe_path = os.path.abspath(v).replace("\\", "/").replace("'", "'\\''")
                        f.write(f"file '{safe_path}'\n")
                cmd = [
                    FFMPEG_PATH, "-y", "-f", "concat", "-safe", "0", "-i", list_file,
                    *MediaEngine._safe_mp4_settings(include_audio=True),
                    output_path,
                ]
                return MediaEngine._run(cmd)
            finally:
                if os.path.exists(list_file):
                    os.remove(list_file)

        # Xfade: cần duration từng clip
        # ⚠️ Windows giới hạn độ dài command line (~32K). Nếu số clip quá lớn, 1 lệnh ffmpeg với
        # nhiều -i + filter_complex sẽ dễ nổ WinError 206. Để vẫn giữ xfade, ta chia nhỏ thành
        # nhiều batch, xfade trong từng batch rồi concat các batch lại.
        n = len(video_list)
        if n > 80:
            logger.warning(
                f"⚠️ [merge_videos] Large clip count for xfade (n={n}). "
                f"Splitting into smaller batches to avoid WinError 206."
            )
            max_per_batch = 40
            tmp_dir = tempfile.gettempdir()
            tmp_outputs: List[str] = []
            base_tag = random.randint(10000, 99999)

            try:
                # 1) Xfade từng batch nhỏ
                for idx in range(0, n, max_per_batch):
                    batch = video_list[idx : idx + max_per_batch]
                    tmp_out = os.path.join(tmp_dir, f"xfade_batch_{base_tag}_{idx//max_per_batch}.mp4")
                    ok_batch = MediaEngine.merge_videos(batch, tmp_out, transition, transition_duration)
                    if not ok_batch:
                        logger.error(f"❌ [merge_videos] Batch xfade failed at index {idx}")
                        return False
                    tmp_outputs.append(tmp_out)

                # 2) Concat các batch đã xfade bằng concat demuxer (không thêm xfade nữa)
                if len(tmp_outputs) == 1:
                    try:
                        shutil.copy2(tmp_outputs[0], output_path)
                        return True
                    except Exception as e:
                        logger.error(f"❌ [merge_videos] Copy single batch failed: {e}")
                        return False

                list_file = os.path.join(tmp_dir, f"concat_batches_{base_tag}.txt")
                with open(list_file, "w", encoding="utf-8") as f:
                    for p in tmp_outputs:
                        safe_path = os.path.abspath(p).replace("\\", "/").replace("'", "'\\''")
                        f.write(f"file '{safe_path}'\n")
                cmd = [
                    FFMPEG_PATH, "-y", "-f", "concat", "-safe", "0", "-i", list_file,
                    *MediaEngine._safe_mp4_settings(include_audio=True),
                    output_path,
                ]
                return MediaEngine._run(cmd)
            finally:
                for p in tmp_outputs:
                    try:
                        if os.path.exists(p):
                            os.remove(p)
                    except Exception:
                        pass
                try:
                    if "list_file" in locals() and os.path.exists(list_file):
                        os.remove(list_file)
                except Exception:
                    pass
        overlap = max(0.25, min(3.0, float(transition_duration)))
        # Nháy trắng: UI thường muốn cực ngắn (~0.2s). Nếu user không set nhỏ, tự clamp lại.
        if transition in ("nhay_trang", "white_flash"):
            overlap = min(overlap, 0.25)
        durations = []
        for v in video_list:
            d = MediaEngine.get_duration(v)
            if d <= 0:
                logger.warning(f"⚠️ [merge] Cannot get duration for {v}, skip xfade")
                list_file = os.path.join(tempfile.gettempdir(), f"concat_{random.randint(10000, 99999)}.txt")
                try:
                    with open(list_file, "w", encoding="utf-8") as f:
                        for p in video_list:
                            safe_path = os.path.abspath(p).replace("\\", "/").replace("'", "'\\''")
                            f.write(f"file '{safe_path}'\n")
                    cmd = [
                        FFMPEG_PATH, "-y", "-f", "concat", "-safe", "0", "-i", list_file,
                        *MediaEngine._safe_mp4_settings(include_audio=True),
                        output_path,
                    ]
                    return MediaEngine._run(cmd)
                finally:
                    if os.path.exists(list_file):
                        os.remove(list_file)
            durations.append(d)

        if n == 1:
            import shutil
            try:
                shutil.copy2(video_list[0], output_path)
                return True
            except Exception as e:
                logger.error(f"❌ merge copy single file: {e}")
                return False

        # Additive transition timing:
        # - Mỗi clip giữ nguyên duration (không bị cắt 1s)
        # - Mỗi transition thêm overlap giây vào tổng timeline
        # => total = sum(durations) + overlap*(n-1)
        offsets = []
        cum = 0.0
        for i in range(n - 1):
            cum += durations[i]
            offsets.append(cum + overlap * i)

        # Xfade: KHÔNG trim bớt clip đầu, vì offset đã trừ overlap rồi.
        # Nếu trim thêm sẽ bị trừ overlap 2 lần => output ngắn (chỉ ~1 clip).
        # xfade yêu cầu CFR (constant frame rate) => ép FPS cố định cho tất cả input sau trim/setpts.
        base_fps = MediaEngine.get_video_fps(video_list[0]) if video_list else 0.0
        if base_fps <= 0:
            base_fps = 24.0
        # Round nhẹ để tránh các fps lẻ gây lệch timestamp
        target_fps = float(int(round(base_fps))) if base_fps >= 1 else 24.0

        # xfade yêu cầu cùng resolution giữa các input. Chuẩn hóa về 1 target WxH.
        dims = [MediaEngine.get_dimensions(v) for v in video_list]
        try:
            target_w = max(w for (w, _) in dims if w and w > 0)
            target_h = max(h for (_, h) in dims if h and h > 0)
        except Exception:
            target_w, target_h = 1920, 1080
        # x264 yêu cầu width/height chia hết cho 2
        target_w = max(2, int(target_w) // 2 * 2)
        target_h = max(2, int(target_h) // 2 * 2)

        parts = []
        for i in range(n):
            d = durations[i]
            base = (
                f"[{i}:v]trim=start=0:end={d},setpts=PTS-STARTPTS,"
                f"scale={target_w}:{target_h}:force_original_aspect_ratio=decrease,"
                f"pad={target_w}:{target_h}:(ow-iw)/2:(oh-ih)/2,"
                f"setsar=1,fps={target_fps},format=yuv420p"
            )
            if i == 0:
                # Pad thêm overlap giây ở cuối để transition diễn ra sau khi hết clip (không cắt clip)
                parts.append(f"{base},tpad=stop_duration={overlap}:stop_mode=clone[v{i}]")
            else:
                # Pad thêm overlap giây ở đầu để transition lấy “khung hình đầu” mà vẫn giữ nguyên duration
                parts.append(f"{base},tpad=start_duration={overlap}:start_mode=clone[v{i}]")

        # Audio chain (additive):
        # - Không acrossfade (vì sẽ làm tổng duration bị trừ overlap)
        # - Chèn 1 đoạn silence overlap giây giữa các cảnh để total tăng đúng yêu cầu
        audio_parts = []
        silence_parts = []
        for i in range(n):
            d = durations[i]
            if MediaEngine.has_audio_stream(video_list[i]):
                audio_parts.append(
                    f"[{i}:a]atrim=start=0:end={d},asetpts=PTS-STARTPTS,"
                    f"aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a{i}]"
                )
            else:
                audio_parts.append(
                    f"anullsrc=r=48000:cl=stereo,atrim=start=0:end={d},asetpts=PTS-STARTPTS[a{i}]"
                )
            if i < n - 1:
                silence_parts.append(f"anullsrc=r=48000:cl=stereo,atrim=start=0:end={overlap}[s{i}]")

        if n == 2:
            video_filter = ";".join(parts) + ";[v0][v1]xfade=transition=" + str(xfade_type) + f":duration={overlap}:offset={offsets[0]}[outv]"
        else:
            chain = [f"[v0][v1]xfade=transition={xfade_type}:duration={overlap}:offset={offsets[0]}[x01]"]
            for i in range(2, n):
                prev_label = f"[x0{i-1}]"
                prev_pad = f"[x0{i-1}p]"
                out_label = "[outv]" if i == n - 1 else f"[x0{i}]"
                # Pad đuôi của composite trước khi xfade với clip tiếp theo
                chain.append(f"{prev_label}tpad=stop_duration={overlap}:stop_mode=clone{prev_pad}")
                chain.append(f"{prev_pad}[v{i}]xfade=transition={xfade_type}:duration={overlap}:offset={offsets[i-1]}{out_label}")
            video_filter = ";".join(parts) + ";" + ";".join(chain)

        # Build audio concat sequence: a0, s0, a1, s1, ..., a(n-1)
        audio_seq = []
        for i in range(n):
            audio_seq.append(f"[a{i}]")
            if i < n - 1:
                audio_seq.append(f"[s{i}]")
        audio_chain = "".join(audio_seq) + f"concat=n={len(audio_seq)}:v=0:a=1[outa]"

        # Dùng decoder CPU thuần để tránh lỗi NVDEC "Invalid NAL unit size" trên một số driver.
        # -hwaccel none đảm bảo ffmpeg không tự kích hoạt hardware decode gây crash.
        cmd = [FFMPEG_PATH, "-y", "-hwaccel", "none"]
        for v in video_list:
            cmd.extend(["-i", os.path.abspath(v)])
        cmd.extend([
            "-filter_complex", ";".join(audio_parts + silence_parts) + ";" + video_filter + ";" + audio_chain,
            "-map", "[outv]",
            "-map", "[outa]",
            "-r", str(target_fps),
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
            "-c:a", "aac", "-b:a", "192k",
            "-pix_fmt", "yuv420p",
            "-movflags", "+faststart",
            output_path,
        ])
        return MediaEngine._run(cmd)

    # --------------------------------------------------------------------------
    # 3. HỖ TRỢ TẠO SRT (TÍCH HỢP) - FIX LỖI PATH
    # --------------------------------------------------------------------------
    @staticmethod
    def _format_time_srt(seconds):
        td = datetime.timedelta(seconds=seconds)
        full = str(td)
        main, ms = full.split('.') if '.' in full else (full, "000")
        ms = ms[:3].ljust(3, '0')
        h, m, s = (main.split(':') + ['00'])[:3]
        return f"{int(h):02}:{int(m):02}:{int(s):02},{ms}"

    @staticmethod
    def generate_srt(
        script_data: dict,
        project_dir: str,
        output_srt_path: str,
        transition_duration: float = 0.0,
        transition: Optional[str] = None,
    ) -> bool:
        """Tạo file .srt từ JSON kịch bản (YouTube tab).
        Trả về True nếu tạo được ít nhất 1 subtitle; False nếu không có tts_script nào (không tạo file / xóa file rỗng)."""
        print(f"\n📝 [GEN SRT] Output: {output_srt_path}")
        
        try:
            scenes = script_data.get("scenes", [])
            add_transition_gap = bool(transition and transition != "none") and float(transition_duration or 0.0) > 0
            trans_gap = float(transition_duration or 0.0) if add_transition_gap else 0.0
            lines = []
            current_time = 0.0
            sub_index = 1
            
            for i, scene in enumerate(scenes):
                text = scene.get("tts_script", "").strip()
                audio_rel = scene.get("audio_url", "")

                # 🔥 Mặc định: nếu KHÔNG có TTS/audio thì coi cảnh đó kéo dài 4s
                duration = 4.0
                if audio_rel:
                    if audio_rel.startswith("/") or audio_rel.startswith("\\"):
                        audio_rel = audio_rel[1:]
                    full_audio_path = os.path.normpath(os.path.join(project_dir, audio_rel))
                    if os.path.exists(full_audio_path):
                        d = MediaEngine.get_duration(full_audio_path)
                        if d > 0:
                            duration = d
                            print(f"   ✅ Scene {i+1}: Duration {duration}s")
                        else:
                            print(f"   ⚠️ Scene {i+1}: Duration 0s (Check ffmpeg)")
                    else:
                        print(f"   ❌ Scene {i+1}: File not found: {full_audio_path}")

                # Nếu không có TTS cho scene này:
                # - KHÔNG tạo dòng subtitle (vì không có text)
                # - Nhưng vẫn cộng current_time để time-line SRT khớp với video (scene im lặng)
                if not text:
                    current_time += duration
                    if trans_gap > 0 and i < len(scenes) - 1:
                        current_time += trans_gap
                    continue
                
                start = MediaEngine._format_time_srt(current_time)
                end = MediaEngine._format_time_srt(current_time + duration)
                lines.append(f"{sub_index}\n{start} --> {end}\n{text}\n\n")
                sub_index += 1
                current_time += duration
                if trans_gap > 0 and i < len(scenes) - 1:
                    current_time += trans_gap
            
            if not lines:
                if os.path.exists(output_srt_path):
                    try:
                        os.remove(output_srt_path)
                    except Exception:
                        pass
                print(f"   ⚠️ [GEN SRT] Không có tts_script nào, bỏ qua SRT.")
                return False
            
            with open(output_srt_path, 'w', encoding='utf-8') as f:
                f.writelines(lines)
            print(f"   ✅ [GEN SRT] Đã ghi {len(lines)} subtitle.")
            return True
        except Exception as e:
            logger.error(f"❌ Gen SRT Error: {e}")
            if os.path.exists(output_srt_path):
                try:
                    os.remove(output_srt_path)
                except Exception:
                    pass
            return False

    # --------------------------------------------------------------------------
    # 4. FINALIZE (NHẠC + SUB)
    # --------------------------------------------------------------------------
    @staticmethod
    def finalize_video(
        video_path: str,
        audio_path: Optional[str],
        srt_path: Optional[str],
        output_path: str,
        bg_volume: float = 0.2,
        ratio: str = "16:9",
        logo_path: Optional[str] = None,
        logo_position: str = "top-left",
        logo_width: int = 180,
        logo_height: Optional[int] = None,
        logo_zoom_percent: int = 100,
        subtitle_font_family: Optional[str] = None,
        subtitle_font_size: Optional[int] = None,  # px; None = auto theo tỉ lệ
        subtitle_color: Optional[str] = None,
        strip_original_video_audio: bool = False,
    ) -> bool:
        print(f"\n🎬 [FINALIZE] Processing...")
        print(f"   🎥 Video: {video_path}")
        print(f"   🎵 Music: {audio_path}")
        print(f"   📐 Ratio: {ratio}")
        print(
            f"   🖼️ Logo: {logo_path} ({logo_position}, w={logo_width}, h={logo_height or 'auto'}, zoom={logo_zoom_percent}%)"
        )
        if strip_original_video_audio:
            print("   🔇 strip_original_video_audio=True (không trộn audio gốc của video đầu vào)")
        
        if not os.path.exists(video_path): return False

        # Kích cỡ base theo tỉ lệ; nếu client không gửi px thì dùng giá trị này
        base_font_size = 10 if ratio == "9:16" else 14
        if subtitle_font_size is not None and subtitle_font_size > 0:
            # Dùng trực tiếp số px từ client (clamp để an toàn)
            font_size = max(8, min(48, int(subtitle_font_size)))
        else:
            font_size = base_font_size

        # Font chữ: cho phép chọn vài font phổ biến, fallback Arial
        raw_font = (subtitle_font_family or "Arial").strip()
        allowed_fonts = {"Arial", "Times New Roman", "Comic Sans MS", "Courier New", "Impact"}
        if raw_font not in allowed_fonts:
            raw_font = "Arial"
        font_name = raw_font.replace("'", "")
        # Màu: map vài màu cơ bản sang mã ASS; mặc định giữ màu cũ (&H00FFFF)
        color_key = (subtitle_color or "").strip().lower()
        color_map = {
            "white": "&H00FFFFFF",
            "yellow": "&H0000FFFF",
            "cyan": "&H00FFFF00",
            "red": "&H000000FF",
            "green": "&H0000FF00",
            "blue": "&H00FF0000",
            "black": "&H00000000",
        }
        primary_colour = color_map.get(color_key, "&H00FFFF")
        inputs = ['-i', video_path]
        filter_complex = []
        video_map = "0:v"
        audio_map = None
        
        has_orig_audio = MediaEngine.has_audio_stream(video_path)
        mix_orig_audio = bool(has_orig_audio and not strip_original_video_audio)
        if mix_orig_audio:
            audio_map = "0:a"

        # Hardsub (chỉ dùng khi file SRT tồn tại và không rỗng)
        if srt_path and os.path.exists(srt_path) and os.path.getsize(srt_path) > 0:
            srt_esc = srt_path.replace('\\', '/').replace(':', '\\:')
            # Áp dụng font_size + font_name vừa tính
            style = f"FontName={font_name},FontSize={font_size},PrimaryColour={primary_colour},Outline=2,MarginV=35,Alignment=2"
            filter_complex.append(f"[0:v]subtitles='{srt_esc}':force_style='{style}'[v_sub]")
            video_map = "[v_sub]"

        # Mix Music
        input_idx = 1  # Index cho input tiếp theo (video là 0)
        if audio_path and os.path.exists(audio_path):
            inputs.extend(['-stream_loop', '-1', '-i', audio_path])
            if mix_orig_audio:
                filter_complex.append(f"[{input_idx}:a]volume={bg_volume}[bg]")
                filter_complex.append(f"[0:a][bg]amix=inputs=2:duration=first:dropout_transition=0[a_mix]")
                audio_map = "[a_mix]"
            else:
                filter_complex.append(f"[{input_idx}:a]volume={bg_volume}[a_mix]")
                audio_map = "[a_mix]"
            input_idx += 1
        elif audio_path:
             print(f"   ⚠️ Music path provided but file missing: {audio_path}")

        # Overlay Logo / Clip người dẫn chuyện (ảnh, GIF, hoặc video .mp4/.webm; video/GIF loop liên tục)
        # Zoom tính theo kích thước khung (w, h):
        # - Zoom 100% = scale vừa khung w x h, không crop
        # - Zoom 150% = scale lên w*150/100 x h*150/100, rồi crop w x h ở giữa
        # - Zoom 50% = scale xuống w*50/100 x h*50/100, rồi pad ra giữa khung w x h (nền trong suốt)
        if logo_path and os.path.exists(logo_path):
            zoom_percent = logo_zoom_percent if logo_zoom_percent is not None else 100
            w = max(1, logo_width)
            h_val = (logo_height or 0)
            
            # Tính kích thước sau zoom (dựa trên khung w x h)
            zoom_factor = max(1, min(500, zoom_percent)) / 100.0
            if h_val > 0:
                h = max(1, h_val)
                scaled_w = int(w * zoom_factor)
                scaled_h = int(h * zoom_factor)
            else:
                # Giữ tỉ lệ: tính scaled_w, scaled_h từ w và tỉ lệ gốc của logo
                scaled_w = int(w * zoom_factor)
                scaled_h = -1  # Sẽ tính trong scale filter
            
            # Zoom 100%: không zoom, chỉ scale vừa khung (giữ tỉ lệ), không crop
            if zoom_percent == 100:
                if h_val > 0:
                    logo_scale = f"{w}:{h}"
                else:
                    logo_scale = f"{w}:-1"  # Giữ tỉ lệ
                scale_filter = f"scale={logo_scale}"
                use_crop = False
                use_pad = False
            elif zoom_percent > 100:
                # Zoom > 100%: scale lên, rồi crop w x h ở giữa
                if h_val > 0:
                    scale_filter = f"scale={scaled_w}:{scaled_h}"
                    crop_expr = f"crop={w}:{h}:(iw-{w})/2:(ih-{h})/2"
                else:
                    # Giữ tỉ lệ: scale theo zoom, rồi crop w x h (cao tự động theo tỉ lệ)
                    scale_filter = f"scale={scaled_w}:-1"
                    crop_expr = f"crop={w}:floor({w}*ih/iw):(iw-{w})/2:(ih-floor({w}*ih/iw))/2"
                use_crop = True
                use_pad = False
            else:
                # Zoom < 100%: scale xuống, rồi pad ra giữa khung w x h (nền trong suốt)
                if h_val > 0:
                    scale_filter = f"scale={scaled_w}:{scaled_h}"
                    # Pad lên kích thước khung, đặt ở giữa, nền trong suốt
                    pad_expr = f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000@0"
                else:
                    # Giữ tỉ lệ: scale theo zoom, rồi pad w x h (cao tự động theo tỉ lệ)
                    scale_filter = f"scale={scaled_w}:-1"
                    # Pad lên width=w, height tự động theo tỉ lệ của input sau scale
                    # ih/iw là tỉ lệ của input (sau scale), tính h = w * (ih/iw)
                    pad_expr = f"pad={w}:floor({w}*ih/iw):(ow-iw)/2:(oh-ih)/2:color=0x00000000@0"
                use_crop = False
                use_pad = True
            
            margin = 20
            if logo_position == "top-left":
                x, y = margin, margin
            elif logo_position == "top-right":
                x, y = f"W-w-{margin}", margin
            elif logo_position == "bottom-left":
                x, y = margin, f"H-h-{margin}"
            else:
                x, y = f"W-w-{margin}", f"H-h-{margin}"
            has_srt = srt_path and os.path.exists(srt_path) and os.path.getsize(srt_path) > 0
            base_video = "[v_sub]" if has_srt else "[0:v]"

            if logo_path.lower().endswith('.gif'):
                logo_esc = logo_path.replace("\\", "/").replace(":", "\\:")
                if use_crop:
                    # Zoom > 100%: scale + crop
                    filter_complex.append(
                        f"movie='{logo_esc}':loop=0,setpts=N/FRAME_RATE/TB,{scale_filter}[logo_zoomed];[logo_zoomed]{crop_expr}[logo_scaled]"
                    )
                elif use_pad:
                    # Zoom < 100%: scale + pad
                    filter_complex.append(
                        f"movie='{logo_esc}':loop=0,setpts=N/FRAME_RATE/TB,{scale_filter}[logo_scaled_temp];[logo_scaled_temp]{pad_expr}[logo_scaled]"
                    )
                else:
                    # Zoom 100%: chỉ scale, không crop/pad
                    filter_complex.append(
                        f"movie='{logo_esc}':loop=0,setpts=N/FRAME_RATE/TB,{scale_filter}[logo_scaled]"
                    )
            else:
                inputs.extend(['-stream_loop', '-1', '-i', logo_path])
                logo_input_idx = input_idx
                if use_crop:
                    # Zoom > 100%: scale + crop
                    filter_complex.append(f"[{logo_input_idx}:v]{scale_filter}[logo_zoomed];[logo_zoomed]{crop_expr}[logo_scaled]")
                elif use_pad:
                    # Zoom < 100%: scale + pad
                    filter_complex.append(f"[{logo_input_idx}:v]{scale_filter}[logo_scaled_temp];[logo_scaled_temp]{pad_expr}[logo_scaled]")
                else:
                    # Zoom 100%: chỉ scale, không crop/pad
                    filter_complex.append(f"[{logo_input_idx}:v]{scale_filter}[logo_scaled]")
            filter_complex.append(f"{base_video}[logo_scaled]overlay={x}:{y}:shortest=1[v_logo]")
            video_map = "[v_logo]"
        elif logo_path:
            print(f"   ⚠️ Logo path provided but file missing: {logo_path}")

        cmd = [FFMPEG_PATH, '-y', *inputs]
        if filter_complex: cmd.extend(['-filter_complex', ";".join(filter_complex)])
        
        cmd.extend(['-map', video_map])
        if audio_map: cmd.extend(['-map', audio_map])
            
        # Output MP4: ép format tương thích playback (WMP, v.v.)
        cmd.extend(['-shortest'])
        cmd.extend(MediaEngine._safe_mp4_settings(include_audio=bool(audio_map)))
        cmd.append(output_path)
        return MediaEngine._run(cmd)
    
    @staticmethod
    def generate_ai_srt(
        script_data: dict,
        project_path: str,
        output_srt_path: str,
        fallback_scene_duration_seconds: Optional[float] = None,
        transition_duration: float = 0.0,
        transition: Optional[str] = None,
    ) -> bool:
        """
        Tạo SRT chuyên biệt cho AI Tab.
        Logic tìm file 'khôn' hơn: Tự check trong ai_url, ai_custom nếu path gốc không thấy.
        fallback_scene_duration_seconds: Khi không tìm thấy file video, dùng giá trị này (6 hoặc 10 cho Grok; None = 8 cho Veo).
        Trả về True nếu tạo được ít nhất 1 subtitle; False nếu không có tts_script nào (không tạo file hoặc xóa file rỗng).
        """
        print(f"\n📝 [GEN AI SRT] Output: {output_srt_path}")
        # Fallback: ưu tiên từ script meta (Grok lưu khi tạo), rồi tham số, mặc định 8s (Veo)
        meta = script_data.get("meta") or {}
        if fallback_scene_duration_seconds is None:
            gvd = str(meta.get("grok_video_duration") or "").strip().lower()
            if gvd in ("6", "6s"):
                fallback_scene_duration_seconds = 6.0
            elif gvd in ("10", "10s"):
                fallback_scene_duration_seconds = 10.0
            else:
                fallback_scene_duration_seconds = meta.get("scene_duration_seconds")
            if fallback_scene_duration_seconds is None:
                fallback_scene_duration_seconds = 8.0
        default_duration = float(fallback_scene_duration_seconds)
        add_transition_gap = bool(transition and transition != "none") and float(transition_duration or 0.0) > 0
        trans_gap = float(transition_duration or 0.0) if add_transition_gap else 0.0

        try:
            scenes = script_data.get("scenes", [])
            lines = []
            current_time = 0.0
            subtitle_index = 1

            for i, scene in enumerate(scenes):
                text = scene.get("tts_script", "").strip()

                video_rel = scene.get("video_url", "")
                duration = default_duration
                found_video = False

                if video_rel:
                    clean_rel = video_rel.replace("/", os.sep).replace("\\", os.sep)
                    if clean_rel.startswith(os.sep):
                        clean_rel = clean_rel[1:]
                    candidates = [
                        os.path.join(project_path, clean_rel),
                        os.path.join(project_path, "ai_url", clean_rel),
                        os.path.join(project_path, "ai_custom", clean_rel),
                    ]
                    final_path = None
                    for p in candidates:
                        if os.path.exists(p):
                            final_path = p
                            break
                    if final_path:
                        d = MediaEngine.get_duration(final_path)
                        if d > 0:
                            duration = d
                            found_video = True
                        else:
                            print(f"   ⚠️ Scene {i+1}: File lỗi (0s): {final_path}")
                    else:
                        # In path đầu tiên để user biết nơi cần có file (chạy AI Video trước khi Finalize)
                        first_candidate = candidates[0] if candidates else ""
                        print(f"   ❌ Scene {i+1}: Video Not Found! (Đã tìm 3 nơi) → Mong đợi: {first_candidate}")

                if not found_video:
                    duration = default_duration

                if text:
                    start = MediaEngine._format_time_srt(current_time)
                    end = MediaEngine._format_time_srt(current_time + duration)
                    lines.append(f"{subtitle_index}\n{start} --> {end}\n{text}\n\n")
                    subtitle_index += 1
                
                current_time += duration
                if trans_gap > 0 and i < len(scenes) - 1:
                    current_time += trans_gap
            
            if not lines:
                # Không có tts_script nào → không tạo file (hoặc xóa nếu đã có file rỗng cũ)
                if os.path.exists(output_srt_path):
                    try:
                        os.remove(output_srt_path)
                    except Exception:
                        pass
                print(f"   ⚠️ [GEN AI SRT] Không có tts_script nào, bỏ qua SRT.")
                return False
            
            with open(output_srt_path, 'w', encoding='utf-8') as f:
                f.writelines(lines)
            print(f"   ✅ [GEN AI SRT] Đã ghi {len(lines)} subtitle.")
            return True
        except Exception as e:
            logger.error(f"❌ Gen AI SRT Error: {e}")
            if os.path.exists(output_srt_path):
                try:
                    os.remove(output_srt_path)
                except Exception:
                    pass
            return False