from pathlib import Path

path = Path('src/api/routes.ts')
text = path.read_text(encoding='utf-8')

old = '''        const {
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

new = '''        const {
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

if old in text:
    text = text.replace(old, new)
else:
    raise SystemExit('Target block not found')

path.write_text(text, encoding='utf-8')
