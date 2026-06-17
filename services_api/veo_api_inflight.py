"""
Giới hạn số request API Flow (tạo ảnh/video + upscale) chạy song song trên một profile.
Create và upscale dùng chung một pool (mặc định tối đa 3).
"""
from __future__ import annotations

import asyncio
from typing import Callable, Dict, List, Optional, Tuple

MAX_VEO_API_REQUESTS_IN_FLIGHT = 3

_locks: Dict[str, asyncio.Lock] = {}
_counts: Dict[str, List[int]] = {}


def _profile_key(profile_tag: str) -> str:
    t = str(profile_tag or "").strip()
    return t if t else "default"


def _get_state(profile_tag: str) -> Tuple[asyncio.Lock, List[int]]:
    key = _profile_key(profile_tag)
    if key not in _locks:
        _locks[key] = asyncio.Lock()
        _counts[key] = [0]
    return _locks[key], _counts[key]


async def acquire_veo_api_request_slot(
    *,
    profile_tag: str,
    label: str,
    max_in_flight: int = MAX_VEO_API_REQUESTS_IN_FLIGHT,
    log_prefix: str = "VEO API",
    stop_check: Optional[Callable[[], bool]] = None,
) -> bool:
    """Chờ đến khi còn slot; trả False nếu stop_check() True."""
    lock, count_ref = _get_state(profile_tag)
    while True:
        if stop_check and stop_check():
            return False
        async with lock:
            if count_ref[0] < max_in_flight:
                count_ref[0] += 1
                return True
        print(
            f"[{log_prefix}] [{profile_tag}] ⏳ Request '{label}' chờ slot "
            f"({count_ref[0]}/{max_in_flight} đang chạy)…"
        )
        await asyncio.sleep(5)


async def release_veo_api_request_slot(*, profile_tag: str) -> None:
    lock, count_ref = _get_state(profile_tag)
    async with lock:
        count_ref[0] = max(0, count_ref[0] - 1)


class veo_api_request_slot:
    """async with veo_api_request_slot(...): — bọc một HTTP request create/upscale."""

    def __init__(
        self,
        *,
        profile_tag: str,
        label: str,
        log_prefix: str = "VEO API",
        max_in_flight: int = MAX_VEO_API_REQUESTS_IN_FLIGHT,
        stop_check: Optional[Callable[[], bool]] = None,
    ) -> None:
        self.profile_tag = profile_tag
        self.label = label
        self.log_prefix = log_prefix
        self.max_in_flight = max_in_flight
        self.stop_check = stop_check
        self._acquired = False

    async def __aenter__(self) -> "veo_api_request_slot":
        self._acquired = await acquire_veo_api_request_slot(
            profile_tag=self.profile_tag,
            label=self.label,
            max_in_flight=self.max_in_flight,
            log_prefix=self.log_prefix,
            stop_check=self.stop_check,
        )
        if not self._acquired:
            raise asyncio.CancelledError(f"Stopped before API request: {self.label}")
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        if self._acquired:
            await release_veo_api_request_slot(profile_tag=self.profile_tag)
