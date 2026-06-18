from pathlib import Path

path = Path('src/api/routes.ts')
# Try UTF-16 LE first (common Windows encoding), then UTF-8
try:
    text = path.read_text(encoding='utf-16-le')
except UnicodeError:
    try:
        text = path.read_text(encoding='utf-8')
    except UnicodeError:
        text = path.read_text(encoding='utf-16')

# Find the video route section
old_block = '''        const {
            profileId,
            projectId,
            sceneId,
            prompt,
            mode,
            aspectRatio,
            userPaygateTier,
            startImageMediaId,
            referenceMediaIds,
            endImageMediaId,
        } = req.body || {};'''

new_block = '''        const {
            profileId,
            projectId,
            sceneId,
            prompt,
            mode,
            aspectRatio,
            userPaygateTier,
            startImageMediaId,
            referenceMediaIds,
            endImageMediaId,
            modelKey,
            duration,
        } = req.body || {};'''

if old_block in text:
    text = text.replace(old_block, new_block)
    path.write_text(text, encoding='utf-8')
    print("Successfully patched routes.ts")
else:
    print("Could not find target block")
    # Try to find what's there
    import re
    matches = re.findall(r'const \{[^}]+\} = req\.body \|\| \{\};', text)
    for m in matches:
        print(f"Found: {repr(m[:100])}")
