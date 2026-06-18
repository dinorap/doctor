"""
Response Parsing Utilities - Extract media_id and URL from Flow API responses.
"""
import re


def _is_uuid(value: str) -> bool:
    """Check if a string looks like a UUID (8-4-4-4-12 hex format)."""
    return bool(re.match(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', value, re.I))


def _is_error(result: dict) -> bool:
    """Check if result contains an error."""
    if result.get("error"):
        return True
    status = result.get("status")
    if isinstance(status, int) and status >= 400:
        return True
    data = result.get("data", {})
    if isinstance(data, dict) and data.get("error"):
        return True
    return False


def _extract_uuid_from_url(url: str) -> str:
    """Extract UUID from fifeUrl like https://storage.googleapis.com/.../image/{UUID}?..."""
    match = re.search(r'/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})', url, re.I)
    return match.group(1) if match else ""


def extract_media_id(result: dict, req_type: str) -> str | None:
    """
    Extract the UUID-format mediaId from API response.
    
    IMPORTANT: mediaId is a UUID (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).
    Do NOT use mediaGenerationId - it's a base64/CAMS format string.
    """
    data = result.get("data", result)

    if req_type in ("GENERATE_IMAGE", "GENERATE_CHARACTER_IMAGE", "REGENERATE_CHARACTER_IMAGE"):
        media = data.get("media", [])
        if media:
            item = media[0]
            name = item.get("name", "")
            if name and _is_uuid(name):
                return name
            
            gen = item.get("image", {}).get("generatedImage", {})
            val = gen.get("mediaId", "")
            if val and _is_uuid(val):
                return val
            
            for url_field in ("fifeUrl", "imageUri"):
                url = gen.get(url_field, "")
                if url:
                    uuid_val = _extract_uuid_from_url(url)
                    if uuid_val:
                        return uuid_val
            
    return None


def extract_output_url(result: dict, req_type: str) -> str:
    """Extract the GCS serving URL from API response."""
    data = result.get("data", result)

    if req_type in ("GENERATE_IMAGE", "GENERATE_CHARACTER_IMAGE", "REGENERATE_CHARACTER_IMAGE"):
        media = data.get("media", [])
        if media:
            gen = media[0].get("image", {}).get("generatedImage", {})
            return gen.get("fifeUrl", gen.get("imageUri", ""))

    return ""
