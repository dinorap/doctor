from pathlib import Path

path = Path('src/api/routes.ts')
text = path.read_text(encoding='utf-8')

# Check if video routes already exist
if '/flow/videos/generate' in text:
    print("Video routes already exist")
    exit(0)

# Find the end of the file (before the last closing brace if any)
# Add video routes at the end
video_routes = '''
/**
 * POST /flow/videos/upload-image - Upload an image to use as start/end image for video generation
 * Body: { profileId, projectId, sceneId, filePath, fileName? }
 */
router.post('/flow/videos/upload-image', async (req: Request, res: Response) => {
    try {
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;
        const db = req.app.locals.db as DatabaseManager;
        const profileManager = new ProfileManager(db);

        const {
            profileId,
            projectId,
            sceneId,
            filePath,
            fileName,
        } = req.body || {};

        if (!profileId || typeof profileId !== 'string') {
            return res.status(400).json({ success: false, error: 'profileId is required' });
        }
        if (!projectId || typeof projectId !== 'string') {
            return res.status(400).json({ success: false, error: 'projectId is required' });
        }
        if (!sceneId || typeof sceneId !== 'string') {
            return res.status(400).json({ success: false, error: 'sceneId is required' });
        }
        if (!filePath || typeof filePath !== 'string') {
            return res.status(400).json({ success: false, error: 'filePath is required' });
        }

        const profile = profileManager.getProfile(profileId);
        if (!profile) {
            return res.status(404).json({ success: false, error: 'Profile not found' });
        }

        const bridge = extensionRegistry?.get(profileId);
        const flowClient = flowRegistry?.getOrCreate(profileId);

        let result: any = null;
        let usedBridge = false;

        if (bridge && bridge.isConnected()) {
            try {
                result = await bridge.uploadImage({
                    projectId,
                    sceneId,
                    filePath,
                    fileName: fileName as string | undefined,
                });
                usedBridge = true;
            } catch (bridgeError: any) {
                logger.warn('Extension bridge uploadImage failed for %s, falling back: %s', profileId, bridgeError.message);
            }
        }

        if (!usedBridge) {
            if (!flowClient || !flowClient.hasFlowKey()) {
                return res.status(503).json({
                    success: false,
                    error: 'Flow client chưa có flowKey. Extension của profile này chưa kết nối hoặc chưa capture token.',
                });
            }
            result = await flowClient.uploadImage({
                projectId,
                sceneId,
                filePath,
                fileName: fileName as string | undefined,
            });
        }

        const media = result?.media || result?.data?.media || result?.uploadedMedia || null;

        res.json({
            success: true,
            data: {
                profileId,
                projectId,
                sceneId,
                media,
                rawResult: result,
            },
            message: usedBridge ? 'Upload ảnh thành công qua Extension' : 'Upload ảnh thành công qua Flow API',
        });
    } catch (error: any) {
        logger.error('Error uploading Flow video image:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /flow/videos/generate - Generate a video from a start image (or start+end image)
 * Body: { profileId, projectId, sceneId, prompt, mode, aspectRatio?, userPaygateTier?, startImageMediaId?, referenceMediaIds?, endImageMediaId?, modelKey?, duration? }
 */
router.post('/flow/videos/generate', async (req: Request, res: Response) => {
    try {
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;
        const db = req.app.locals.db as DatabaseManager;
        const profileManager = new ProfileManager(db);

        const {
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
        } = req.body || {};

        if (!profileId || typeof profileId !== 'string') {
            return res.status(400).json({ success: false, error: 'profileId is required' });
        }
        if (!projectId || typeof projectId !== 'string') {
            return res.status(400).json({ success: false, error: 'projectId is required' });
        }
        if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
            return res.status(400).json({ success: false, error: 'prompt is required' });
        }
        if (!sceneId || typeof sceneId !== 'string') {
            return res.status(400).json({ success: false, error: 'sceneId is required' });
        }
        if (!mode || !['start_image', 'references'].includes(mode)) {
            return res.status(400).json({ success: false, error: 'mode must be start_image or references' });
        }
        if (mode === 'start_image' && (!startImageMediaId || typeof startImageMediaId !== 'string')) {
            return res.status(400).json({ success: false, error: 'startImageMediaId is required for start_image mode' });
        }
        if (mode === 'references' && (!Array.isArray(referenceMediaIds) || referenceMediaIds.length === 0)) {
            return res.status(400).json({ success: false, error: 'referenceMediaIds is required for references mode' });
        }

        const profile = profileManager.getProfile(profileId);
        if (!profile) {
            return res.status(404).json({ success: false, error: 'Profile not found' });
        }

        const resolvedAspectRatio = typeof aspectRatio === 'string' && aspectRatio.trim()
            ? aspectRatio.trim()
            : 'VIDEO_ASPECT_RATIO_PORTRAIT';

        const resolvedTier = (userPaygateTier === 'PAYGATE_TIER_ONE' || userPaygateTier === 'PAYGATE_TIER_TWO')
            ? userPaygateTier
            : ((profile.tier as any) || 'PAYGATE_TIER_TWO');

        const bridge = extensionRegistry?.get(profileId);
        const flowClient = flowRegistry?.getOrCreate(profileId);

        let result: any = null;
        let usedBridge = false;

        if (bridge && bridge.isConnected()) {
            try {
                if (mode === 'start_image') {
                    result = await bridge.generateVideo({
                        startImageMediaId,
                        prompt: prompt.trim(),
                        projectId,
                        sceneId,
                        aspectRatio: resolvedAspectRatio,
                        endImageMediaId,
                        userPaygateTier: resolvedTier,
                        modelKey,
                        duration,
                    });
                } else {
                    result = await bridge.generateVideoFromReferences({
                        referenceMediaIds,
                        prompt: prompt.trim(),
                        projectId,
                        sceneId,
                        aspectRatio: resolvedAspectRatio,
                        userPaygateTier: resolvedTier,
                        modelKey,
                        duration,
                    });
                }
                usedBridge = true;
            } catch (bridgeError: any) {
                logger.warn('Extension bridge generateVideo failed for %s, falling back: %s', profileId, bridgeError.message);
            }
        }

        if (!usedBridge) {
            if (!flowClient || !flowClient.hasFlowKey()) {
                return res.status(503).json({
                    success: false,
                    error: 'Flow client chưa có flowKey. Extension của profile này chưa kết nối hoặc chưa capture token.',
                });
            }
            if (mode === 'start_image') {
                result = await flowClient.generateVideo({
                    startImageMediaId,
                    prompt: prompt.trim(),
                    projectId,
                    sceneId,
                    aspectRatio: resolvedAspectRatio,
                    endImageMediaId,
                    userPaygateTier: resolvedTier,
                    modelKey,
                    duration,
                });
            } else {
                result = await flowClient.generateVideoFromReferences({
                    referenceMediaIds,
                    prompt: prompt.trim(),
                    projectId,
                    sceneId,
                    aspectRatio: resolvedAspectRatio,
                    userPaygateTier: resolvedTier,
                    modelKey,
                    duration,
                });
            }
        }

        const operations = result?.operations || result?.data?.operations || [];
        const requestIds = (Array.isArray(operations) ? operations : [])
            .map((op: any) => op?.name || op?.id)
            .filter((id: any) => typeof id === 'string');

        res.json({
            success: true,
            data: {
                profileId,
                projectId,
                sceneId,
                mode,
                aspectRatio: resolvedAspectRatio,
                userPaygateTier: resolvedTier,
                operations,
                requestIds,
                rawResult: result,
            },
            message: usedBridge ? 'Tạo video thành công qua Extension' : 'Tạo video thành công qua Flow API',
        });
    } catch (error: any) {
        logger.error('Error generating Flow video:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /flow/videos/upscale - Upscale an existing generated video.
 * Body: { profileId, projectId, sceneId, mediaId, aspectRatio?, resolution? }
 */
router.post('/flow/videos/upscale', async (req: Request, res: Response) => {
    try {
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;
        const db = req.app.locals.db as DatabaseManager;
        const profileManager = new ProfileManager(db);

        const {
            profileId,
            projectId,
            sceneId,
            mediaId,
            aspectRatio,
            resolution,
        } = req.body || {};

        if (!profileId || typeof profileId !== 'string') {
            return res.status(400).json({ success: false, error: 'profileId is required' });
        }
        if (!projectId || typeof projectId !== 'string') {
            return res.status(400).json({ success: false, error: 'projectId is required' });
        }
        if (!mediaId || typeof mediaId !== 'string') {
            return res.status(400).json({ success: false, error: 'mediaId is required' });
        }
        if (!sceneId || typeof sceneId !== 'string') {
            return res.status(400).json({ success: false, error: 'sceneId is required' });
        }

        const profile = profileManager.getProfile(profileId);
        if (!profile) {
            return res.status(404).json({ success: false, error: 'Profile not found' });
        }

        const resolvedAspectRatio = typeof aspectRatio === 'string' && aspectRatio.trim()
            ? aspectRatio.trim()
            : 'VIDEO_ASPECT_RATIO_PORTRAIT';
        const resolvedResolution = typeof resolution === 'string' && resolution.trim()
            ? resolution.trim()
            : 'VIDEO_RESOLUTION_4K';

        const bridge = extensionRegistry?.get(profileId);
        const flowClient = flowRegistry?.getOrCreate(profileId);

        let result: any = null;
        let usedBridge = false;

        if (bridge && bridge.isConnected()) {
            try {
                result = await bridge.upscaleVideo({
                    mediaId,
                    sceneId,
                    aspectRatio: resolvedAspectRatio,
                    resolution: resolvedResolution,
                });
                usedBridge = true;
            } catch (bridgeError: any) {
                logger.warn('Extension bridge upscaleVideo failed for %s, falling back: %s', profileId, bridgeError.message);
            }
        }

        if (!usedBridge) {
            if (!flowClient || !flowClient.hasFlowKey()) {
                return res.status(503).json({
                    success: false,
                    error: 'Flow client chưa có flowKey. Extension của profile này chưa kết nối hoặc chưa capture token.',
                });
            }
            result = await flowClient.upscaleVideo({
                mediaId,
                sceneId,
                aspectRatio: resolvedAspectRatio,
                resolution: resolvedResolution,
            });
        }

        res.json({
            success: true,
            data: {
                profileId,
                projectId,
                sceneId,
                mediaId,
                aspectRatio: resolvedAspectRatio,
                resolution: resolvedResolution,
                rawResult: result,
            },
            message: usedBridge ? 'Upscale video thành công qua Extension' : 'Upscale video thành công qua Flow API',
        });
    } catch (error: any) {
        logger.error('Error upscaling Flow video:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /flow/videos/status - Check status of video generation operations
 * Body: { profileId, operations: string[] }
 */
router.post('/flow/videos/status', async (req: Request, res: Response) => {
    try {
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;

        const {
            profileId,
            operations,
        } = req.body || {};

        if (!profileId || typeof profileId !== 'string') {
            return res.status(400).json({ success: false, error: 'profileId is required' });
        }
        if (!Array.isArray(operations) || operations.length === 0) {
            return res.status(400).json({ success: false, error: 'operations array is required' });
        }

        const bridge = extensionRegistry?.get(profileId);
        const flowClient = flowRegistry?.getOrCreate(profileId);

        let result: any = null;
        let usedBridge = false;

        if (bridge && bridge.isConnected()) {
            try {
                result = await bridge.checkVideoStatus(operations);
                usedBridge = true;
            } catch (bridgeError: any) {
                logger.warn('Extension bridge checkVideoStatus failed for %s, falling back: %s', profileId, bridgeError.message);
            }
        }

        if (!usedBridge) {
            if (!flowClient || !flowClient.hasFlowKey()) {
                return res.status(503).json({
                    success: false,
                    error: 'Flow client chưa có flowKey. Extension của profile này chưa kết nối hoặc chưa capture token.',
                });
            }
            result = await flowClient.checkVideoStatus(operations);
        }

        res.json({
            success: true,
            data: {
                profileId,
                operations,
                status: result,
            },
            message: usedBridge ? 'Kiểm tra trạng thái qua Extension' : 'Kiểm tra trạng thái qua Flow API',
        });
    } catch (error: any) {
        logger.error('Error checking Flow video status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});
'''

path.write_text(text + video_routes, encoding='utf-8')
print("Successfully added video routes")
