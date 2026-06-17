import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { ProfileManager } from '../profile-manager/ProfileManager';
import { CreateProfileRequest, OpenProfileRequest, ApiResponse, PaygateTier } from '../types';
import logger from '../utils/logger';
import { DatabaseManager } from '../database/Database';
import { BrowserManager } from '../browser-manager/BrowserManager';
import { ExtensionBridgeRegistry } from '../flow-api/ExtensionBridgeRegistry';
import { FlowApiRegistry } from '../flow-api/FlowApiRegistry';
import { v4 as uuidv4 } from 'uuid';
import imageModels from '../../veo_models.json';

const router = express.Router();

/**
 * GET /health - Health check
 */
router.get('/health', (_req: Request, res: Response) => {
    res.json({
        success: true,
        data: {
            status: 'ok',
            timestamp: new Date().toISOString(),
            cloakBrowser: (global as any).cloakBrowserAvailable || false
        },
    });
});

/**
 * GET /extension/tier - Aggregate tier status across all profiles (or
 *                      a specific profile via ?profileId=xxx).
 * Real-time: pulls from the per-profile ExtensionBridge if connected,
 * otherwise falls back to the per-profile FlowApiClient, otherwise
 * returns the cached value in the DB.
 */
router.get('/extension/tier', async (req: Request, res: Response) => {
    try {
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;
        const queryPid = typeof req.query.profileId === 'string' ? req.query.profileId : null;

        const detectOne = async (profileId: string) => {
            const bridge = extensionRegistry?.get(profileId);
            if (bridge && bridge.isConnected()) {
                try {
                    const creditsData = await bridge.getCredits();
                    const rawTier = creditsData?.userPaygateTier;
                    const tier: PaygateTier = (rawTier === 'PAYGATE_TIER_ONE' || rawTier === 'PAYGATE_TIER_TWO')
                        ? rawTier
                        : 'UNKNOWN';
                    return {
                        profileId,
                        tier,
                        connected: true,
                        source: 'extension',
                        credits: creditsData?.credits,
                    };
                } catch (extError) {
                    logger.warn('Failed to get tier from extension for %s: %s', profileId, extError);
                }
            }

            const flowClient = flowRegistry?.get(profileId);
            if (flowClient && flowClient.isConnected()) {
                try {
                    const creditsData = await flowClient.getCredits();
                    const rawTier = creditsData?.userPaygateTier;
                    const tier: PaygateTier = (rawTier === 'PAYGATE_TIER_ONE' || rawTier === 'PAYGATE_TIER_TWO')
                        ? rawTier
                        : 'UNKNOWN';
                    return {
                        profileId,
                        tier,
                        connected: true,
                        source: 'flow_api',
                        credits: creditsData?.credits,
                    };
                } catch (flowError) {
                    logger.warn('Failed to get tier from Flow API for %s: %s', profileId, flowError);
                }
            }

            return { profileId, tier: 'UNKNOWN', connected: false, source: 'default' };
        };

        if (queryPid) {
            const result = await detectOne(queryPid);
            return res.json({ success: true, data: result });
        }

        // No profileId: return aggregate snapshot across all known profiles
        const snapshot: any[] = [];
        if (extensionRegistry) {
            extensionRegistry.forEach((pid) => snapshot.push(pid));
        }
        const data = await Promise.all(snapshot.map((pid) => detectOne(pid)));
        return res.json({ success: true, data });
    } catch (error: any) {
        logger.error('Error getting extension tier:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /flow/credits - Get Flow credits and tier for a single profile.
 * Query: ?profileId=xxx (required) — per-profile, no cross-profile leakage.
 */
router.get('/flow/credits', async (req: Request, res: Response) => {
    try {
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;
        const profileId = typeof req.query.profileId === 'string' ? req.query.profileId : null;

        if (!profileId) {
            return res.status(400).json({
                success: false,
                error: 'profileId is required (use ?profileId=xxx)',
            });
        }

        const bridge = extensionRegistry?.get(profileId);
        if (bridge && bridge.isConnected()) {
            try {
                const data = await bridge.getCredits();
                return res.json({
                    success: true,
                    data: {
                        ...(data || {}),
                        profileId,
                        source: 'extension',
                    },
                });
            } catch (extError) {
                logger.warn('Extension bridge getCredits failed for %s: %s', profileId, extError);
            }
        }

        const flowClient = flowRegistry?.get(profileId);
        if (flowClient && flowClient.isConnected()) {
            try {
                const data = await flowClient.getCredits();
                return res.json({
                    success: true,
                    data: { ...(data || {}), profileId, source: 'flow_api' },
                });
            } catch (flowError) {
                logger.warn('FlowApiClient getCredits failed for %s: %s', profileId, flowError);
            }
        }

        return res.json({
            success: true,
            data: {
                profileId,
                credits: 0,
                userPaygateTier: 'UNKNOWN',
                source: 'default',
            },
        });
    } catch (error: any) {
        logger.error('Error getting Flow credits:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /cloakbrowser/status - Check CloakBrowser availability
 */
router.get('/cloakbrowser/status', (req: Request, res: Response) => {
    const browserManager = req.app.locals.browserManager as BrowserManager;

    res.json({
        success: true,
        data: {
            available: browserManager.isCloakBrowserAvailable(),
            ready: browserManager.isCloakBrowserReady(),
            downloading: browserManager.getDownloadStatus().downloading,
            stealthMode: true,
            description: 'CloakBrowser - Stealth Chromium (~200MB will download on first launch)',
        },
    });
});

/**
 * POST /cloakbrowser/install - Download CloakBrowser binary
 */
router.post('/cloakbrowser/install', async (req: Request, res: Response) => {
    try {
        const browserManager = req.app.locals.browserManager as BrowserManager;

        if (browserManager.isCloakBrowserReady()) {
            return res.json({
                success: true,
                data: { message: 'Already installed' },
            });
        }

        // Start download in background
        browserManager.ensureBinary().then(downloaded => {
            logger.info(`CloakBrowser binary ${downloaded ? 'installed' : 'failed'}`);
        });

        res.json({
            success: true,
            data: { message: 'Download started' },
        });
    } catch (error: any) {
        logger.error('Error installing CloakBrowser:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * POST /flow/projects/create - Create a new project on Google Flow for a
 * single profile. Body: { profileId, name, description?, toolName? }
 */
router.post('/flow/projects/create', async (req: Request, res: Response) => {
    try {
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;
        const { profileId, name, description, toolName } = req.body || {};

        if (!profileId || typeof profileId !== 'string') {
            return res.status(400).json({ success: false, error: 'profileId is required' });
        }
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Project name is required' });
        }

        const bridge = extensionRegistry?.get(profileId);
        const flowClient = flowRegistry?.getOrCreate(profileId);

        let result: any = null;
        let usedBridge = false;

        if (bridge && bridge.isConnected()) {
            try {
                result = await bridge.createProject(name.trim(), (toolName as string) || 'PINHOLE');
                usedBridge = true;
            } catch (bridgeError: any) {
                logger.warn('Extension bridge failed for %s, falling back to direct client: %s', profileId, bridgeError.message);
            }
        }

        if (!usedBridge) {
            if (!flowClient || !flowClient.hasFlowKey()) {
                return res.status(503).json({
                    success: false,
                    error: 'Flow client chưa có flowKey. Extension của profile này chưa kết nối hoặc chưa capture token.',
                });
            }
            result = await flowClient.createProject(name.trim(), (toolName as string) || 'PINHOLE');
        }

        res.json({
            success: true,
            data: {
                profileId,
                name: name.trim(),
                description: (description as string) || '',
                toolName: toolName || 'PINHOLE',
                result,
            },
            message: 'Tạo project trên Flow thành công',
        });
    } catch (error: any) {
        logger.error('Error creating Flow project:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /flow/projects/create-batch - Create a project on Google Flow for multiple
 * profiles with the same name. Body: { profileIds: string[], name, description?, toolName? }
 * For each selected profile:
 *   - If it's not active, open it first
 *   - Wait for extension to be connected and have flowKey
 *   - Create the project via extension/Flow API
 * Returns per-profile results including the created projectId for each.
 */
router.post('/flow/projects/create-batch', async (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const browserManager = req.app.locals.browserManager as BrowserManager;
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;
        const profileManager = new ProfileManager(db);

        const { profileIds, name, description, toolName } = req.body || {};

        if (!Array.isArray(profileIds) || profileIds.length === 0) {
            return res.status(400).json({ success: false, error: 'profileIds is required and must be a non-empty array' });
        }
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ success: false, error: 'Project name is required' });
        }

        const projectName = name.trim();
        const projectDescription = description as string | undefined;
        const ensureReady = async (profileId: string): Promise<{ status: 'success'; projectId?: string; result?: any } | { status: 'error'; error: string }> => {
            const profile = profileManager.getProfile(profileId);
            if (!profile) {
                return { status: 'error', error: 'Profile not found' };
            }

            if (!browserManager.isActive(profileId)) {
                await browserManager.launchProfile(profile, { useCloakBrowser: true });
                profileManager.touchProfile(profileId);
                if (extensionRegistry) extensionRegistry.getOrCreate(profileId);
                if (flowRegistry) flowRegistry.getOrCreate(profileId);
            }

            const deadline = Date.now() + 25000;
            while (Date.now() < deadline) {
                const bridge = extensionRegistry?.get(profileId);
                if (bridge && bridge.isConnected() && bridge.getStatus().flowKeyPresent) {
                    break;
                }
                await new Promise(r => setTimeout(r, 500));
            }

            const bridge = extensionRegistry?.get(profileId);
            const flowClient = flowRegistry?.getOrCreate(profileId);

            let result: any = null;
            let usedBridge = false;

            if (bridge && bridge.isConnected()) {
                try {
                    result = await bridge.createProject(projectName, (toolName as string) || 'PINHOLE');
                    usedBridge = true;
                } catch (bridgeError: any) {
                    logger.warn('Extension bridge failed for %s in batch, falling back: %s', profileId, bridgeError.message);
                }
            }

            if (!usedBridge) {
                if (!flowClient || !flowClient.hasFlowKey()) {
                    return {
                        status: 'error',
                        error: 'Flow client chưa có flowKey. Extension của profile này chưa kết nối hoặc chưa capture token.',
                    };
                }
                result = await flowClient.createProject(projectName, (toolName as string) || 'PINHOLE');
            }

            const projectId = result?.data?.result?.data?.json?.result?.projectId || null;

            if (projectId) {
                try {
                    const existing = profileManager.getProfile(profileId);
                    const metadata = { ...(existing?.metadata || {}) };
                    const existingProjects = Array.isArray(metadata.flowProjects) ? metadata.flowProjects : [];
                    const filtered = existingProjects.filter((p: any) => p.projectId !== projectId);
                    filtered.push({
                        projectId,
                        name: projectName,
                        description: projectDescription,
                        toolName: (toolName as string) || 'PINHOLE',
                        createdAt: new Date().toISOString(),
                    });
                    metadata.flowProjects = filtered;
                    profileManager.updateProfile(profileId, { metadata });
                } catch (saveErr) {
                    logger.warn('Failed to save flow project for profile %s: %s', profileId, saveErr);
                }
            }

            return { status: 'success', projectId, result };
        };

        const results = await Promise.allSettled(profileIds.map(ensureReady));

        // Broadcast so the frontend refreshes its profiles list and sees the new projects
        const broadcast = req.app.locals.broadcast as (event: string, data: any) => void;
        broadcast('profiles-updated', {});

        const settled = results.map((r, idx) => {
            const pid = (profileIds as string[])[idx];
            if (r.status === 'fulfilled') {
                return r.value;
            }
            return {
                profileId: pid,
                status: 'error' as const,
                error: r.reason instanceof Error ? r.reason.message : String(r.reason),
            };
        });

        res.json({
            success: true,
            data: settled,
            message: `Đã xử lý ${settled.length} profile`,
        });
    } catch (error: any) {
        logger.error('Error creating Flow projects batch:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /flow/images/generate - Generate images via Flow API for a profile.
 * Body: { profileId, prompt, projectId?, modelKey?, aspectRatio?, userPaygateTier? }
 *
 * If projectId is omitted, the route will try to reuse an existing Flow
 * project from profile metadata, or create a temporary one on-the-fly.
 */
router.post('/flow/images/generate', async (req: Request, res: Response) => {
    try {
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;
        const db = req.app.locals.db as DatabaseManager;
        const profileManager = new ProfileManager(db);

        const {
            profileId,
            prompt,
            projectId,
            modelKey,
            aspectRatio,
            userPaygateTier,
        } = req.body || {};

        if (!profileId || typeof profileId !== 'string') {
            return res.status(400).json({ success: false, error: 'profileId is required' });
        }
        if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
            return res.status(400).json({ success: false, error: 'prompt is required' });
        }

        const profile = profileManager.getProfile(profileId);
        if (!profile) {
            return res.status(404).json({ success: false, error: 'Profile not found' });
        }

        const resolvedModelKey = typeof modelKey === 'string' && modelKey.trim()
            ? modelKey.trim()
            : 'NANO_BANANA_PRO';

        const rawModelEntry = (imageModels as any)?.image_models?.[resolvedModelKey];
        const apiModelKey = typeof rawModelEntry === 'string' ? rawModelEntry : resolvedModelKey;

        const resolvedProjectId = typeof projectId === 'string' && projectId.trim()
            ? projectId.trim()
            : null;

        let targetProjectId = resolvedProjectId;
        let usedBridge = false;
        let result: any = null;

        const bridge = extensionRegistry?.get(profileId);
        const flowClient = flowRegistry?.getOrCreate(profileId);

        if (!targetProjectId) {
            const existingProjects: any[] = Array.isArray((profile.metadata || {}).flowProjects)
                ? ((profile.metadata || {}).flowProjects as any[])
                : [];

            if (existingProjects.length > 0) {
                targetProjectId = existingProjects[0].projectId || existingProjects[0].id || null;
            }
        }

        if (!targetProjectId && bridge && bridge.isConnected()) {
            try {
                const createResult = await bridge.createProject(
                    `Image generation ${new Date().toISOString()}`,
                    'PINHOLE',
                );
                targetProjectId = createResult?.data?.json?.projectId || createResult?.projectId || null;
            } catch (bridgeError: any) {
                logger.warn('Extension bridge createProject failed for %s: %s', profileId, bridgeError.message);
            }
        }

        if (!targetProjectId && flowClient && flowClient.hasFlowKey()) {
            try {
                const createResult = await flowClient.createProject(
                    `Image generation ${new Date().toISOString()}`,
                    'PINHOLE',
                );
                targetProjectId = createResult?.data?.json?.projectId || createResult?.projectId || null;
            } catch (flowError: any) {
                logger.warn('FlowApiClient createProject failed for %s: %s', profileId, flowError.message);
            }
        }

        if (!targetProjectId) {
            return res.status(503).json({
                success: false,
                error: 'Không có Flow project khả dụng. Hãy mở profile và đăng nhập Google Flow, hoặc cung cấp projectId.',
            });
        }

        const resolvedAspectRatio = typeof aspectRatio === 'string' && aspectRatio.trim()
            ? aspectRatio.trim()
            : 'IMAGE_ASPECT_RATIO_LANDSCAPE';

        const resolvedTier: PaygateTier =
            userPaygateTier === 'PAYGATE_TIER_ONE' || userPaygateTier === 'PAYGATE_TIER_TWO'
                ? userPaygateTier
                : (profile.tier as PaygateTier) || 'PAYGATE_TIER_TWO';

        if (bridge && bridge.isConnected()) {
            try {
                result = await bridge.generateImages({
                    projectId: targetProjectId,
                    prompt: prompt.trim(),
                    aspectRatio: resolvedAspectRatio,
                    userPaygateTier: resolvedTier,
                    modelKey: apiModelKey,
                });
                usedBridge = true;
            } catch (bridgeError: any) {
                logger.warn('Extension bridge generateImages failed for %s, falling back: %s', profileId, bridgeError.message);
            }
        }

        if (!usedBridge) {
            if (!flowClient || !flowClient.hasFlowKey()) {
                return res.status(503).json({
                    success: false,
                    error: 'Flow client chưa có flowKey. Extension của profile này chưa kết nối hoặc chưa capture token.',
                });
            }

            result = await flowClient.generateImages({
                projectId: targetProjectId,
                prompt: prompt.trim(),
                aspectRatio: resolvedAspectRatio,
                userPaygateTier: resolvedTier,
                modelKey: apiModelKey,
            });
        }

        // Parse response to extract mediaId and image URLs from various possible locations
        // Flow API returns URLs in different formats: downloadUrl, uri, fifeUrl, servingUri
        // Structure: { media: [{ name, image: { generatedImage: { fifeUrl, mediaId } } }] }
        let mediaId: string | null = null;
        let servingUri: string | null = null;

        // Deep search function to find media info in ALL nested objects
        const findMediaInfo = (obj: any, depth = 0): { mediaId?: string; url?: string } | null => {
            if (!obj || depth > 15) return null;
            if (typeof obj !== 'object') return null;

            // Check current object for mediaId and URL
            if (obj.mediaId || obj.mediaGenerationId || obj.name) {
                mediaId = obj.mediaId || obj.mediaGenerationId || obj.name;
            }
            if (obj.fifeUrl || obj.downloadUrl || obj.uri || obj.servingUri) {
                servingUri = obj.fifeUrl || obj.downloadUrl || obj.uri || obj.servingUri;
            }
            if (mediaId && servingUri) return { mediaId, url: servingUri };

            // Recursively search in ALL nested objects and arrays
            if (Array.isArray(obj)) {
                for (const item of obj) {
                    const result = findMediaInfo(item, depth + 1);
                    if (result?.mediaId && result?.url) {
                        return result;
                    }
                }
            } else {
                for (const key of Object.keys(obj)) {
                    const value = obj[key];
                    if (key === 'name' && typeof value === 'string' && value.includes('-') && value.length > 30) {
                        // Likely a media ID like "4c0e0f5a-414d-480a-aa48-fe60c3ae4cef"
                        mediaId = value;
                        if (servingUri) return { mediaId, url: servingUri };
                    }
                    const result = findMediaInfo(value, depth + 1);
                    if (result?.mediaId && result?.url) {
                        return result;
                    }
                }
            }

            return mediaId && servingUri ? { mediaId, url: servingUri } : null;
        };

        // Search the entire result for media info
        const found = findMediaInfo(result);
        if (found) {
            mediaId = found.mediaId || mediaId;
            servingUri = found.url || servingUri;
        }

        // Validate: must have at least mediaId or servingUri
        if (!mediaId && !servingUri) {
            logger.error('Flow image generation returned empty result:', JSON.stringify(result)?.slice(0, 1000));
            return res.status(500).json({
                success: false,
                error: 'API không trả về ảnh. Có thể tier không đủ, profile chưa ready, hoặc cần chờ thêm.',
            });
        }

        // Download image to local storage if we have a URL
        let localPath: string | null = null;
        if (servingUri && mediaId) {
            try {
                // Create images directory if it doesn't exist
                const imagesDir = path.join(process.cwd(), 'data', 'generated-images');
                if (!fs.existsSync(imagesDir)) {
                    fs.mkdirSync(imagesDir, { recursive: true });
                }

                // Determine file extension from URL or default to jpg
                const ext = servingUri.includes('.png') ? 'png' : 'jpg';
                localPath = path.join(imagesDir, `${mediaId}.${ext}`);

                // Download the image using the native fetch API (Node 18+)
                const imageResponse = await fetch(servingUri);
                if (imageResponse.ok) {
                    const buffer = await imageResponse.arrayBuffer();
                    fs.writeFileSync(localPath, Buffer.from(buffer));
                    logger.info(`Downloaded image to: ${localPath}`);
                } else {
                    logger.warn(`Failed to download image: HTTP ${imageResponse.status}`);
                    localPath = null;
                }
            } catch (downloadError) {
                logger.warn(`Error downloading image: ${downloadError}`);
                localPath = null;
            }
        }

        res.json({
            success: true,
            data: {
                profileId,
                projectId: targetProjectId,
                modelKey: apiModelKey,
                aspectRatio: resolvedAspectRatio,
                userPaygateTier: resolvedTier,
                mediaId,
                servingUri,
                downloadUrl: servingUri,
                localPath,
                rawResult: result,
            },
            message: usedBridge ? 'Tạo ảnh thành công qua Extension' : 'Tạo ảnh thành công qua Flow API',
        });
    } catch (error: any) {
        logger.error('Error generating Flow image:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /flow/projects/prepare-profile - Ensure a profile is open and its
 * extension is connected and has a flowKey. If the profile is not active,
 * launches it first. Then waits up to `timeoutMs` for the extension to be
 * ready with a flowKey.
 *
 * Body: { profileId, timeoutMs? }
 */
router.post('/flow/projects/prepare-profile', async (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const browserManager = req.app.locals.browserManager as BrowserManager;
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;
        const profileManager = new ProfileManager(db);

        const { profileId, timeoutMs } = req.body || {};

        if (!profileId || typeof profileId !== 'string') {
            return res.status(400).json({ success: false, error: 'profileId is required' });
        }

        const profile = profileManager.getProfile(profileId);
        if (!profile) {
            return res.status(404).json({ success: false, error: 'Profile not found' });
        }

        // If profile is not active, open it first.
        if (!browserManager.isActive(profileId)) {
            const profileState = await browserManager.launchProfile(profile, {
                useCloakBrowser: true,
            });
            profileManager.touchProfile(profileId);

            // Pre-create per-profile registries
            if (extensionRegistry) extensionRegistry.getOrCreate(profileId);
            if (flowRegistry) flowRegistry.getOrCreate(profileId);

            // Trigger tier detection in background (same as /profiles/open)
            const tierRecord = (await db.getSessionByProfileId(profileId)) || null;
            if (tierRecord) {
                // noop: tier detection will happen via existing mechanisms
            }
        }

        // Wait for extension to be connected and have flowKey
        const deadline = typeof timeoutMs === 'number' ? timeoutMs : 25000;
        const start = Date.now();
        let ready = false;

        while (Date.now() - start < deadline) {
            const bridge = extensionRegistry?.get(profileId);
            if (bridge && bridge.isConnected() && bridge.getStatus().flowKeyPresent) {
                ready = true;
                break;
            }
            await new Promise(r => setTimeout(r, 500));
        }

        if (!ready) {
            return res.status(503).json({
                success: false,
                error: 'Extension chưa sẵn sàng sau thời gian chờ. Hãy đảm bảo profile đã đăng nhập Google Flow và extension đã capture token.',
            });
        }

        res.json({
            success: true,
            data: {
                profileId,
                opened: !browserManager.isActive(profileId),
                ready: true,
            },
            message: 'Profile đã sẵn sàng để tạo project',
        });
    } catch (error: any) {
        logger.error('Error preparing profile for Flow project:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /ext/callback - HTTP callback endpoint for extension responses.
 * Body must contain `profileId` so we can route the response to the
 * correct per-profile ExtensionBridge. Without profileId we reject
 * (returns 400) so we never accidentally deliver an extension response
 * to the wrong profile.
 */
router.post('/ext/callback', express.json({ type: '*/*' }), (req: Request, res: Response) => {
    try {
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const data = req.body || {};
        const profileId = typeof data?.profileId === 'string' ? data.profileId : null;

        if (!profileId) {
            return res.status(400).json({ ok: false, error: 'profileId is required in callback body' });
        }

        const bridge = extensionRegistry?.get(profileId);
        if (!bridge) {
            return res.status(404).json({ ok: false, error: `unknown profileId ${profileId}` });
        }

        bridge.handleMessage(data);
        res.json({ ok: true });
    } catch (error: any) {
        logger.error('Error in extension callback:', error);
        res.status(500).json({ ok: false });
    }
});

/**
 * GET /extension/status - Snapshot of every per-profile ExtensionBridge
 * (or a single profile via ?profileId=xxx). Dashboard polls this as a
 * fallback for when WebSocket isn't connected yet.
 */
router.get('/extension/status', (req: Request, res: Response) => {
    try {
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const queryPid = typeof req.query.profileId === 'string' ? req.query.profileId : null;

        if (queryPid) {
            const bridge = extensionRegistry?.get(queryPid);
            if (!bridge) {
                return res.json({
                    success: true,
                    data: {
                        profileId: queryPid,
                        connected: false,
                        flowKeyPresent: false,
                        state: 'unknown',
                        tokenAge: null,
                        lastError: null,
                        tier: null,
                        credits: null,
                    },
                });
            }
            return res.json({ success: true, data: bridge.getStatus() });
        }

        const list = extensionRegistry ? extensionRegistry.list() : [];
        return res.json({ success: true, data: list });
    } catch (error: any) {
        logger.error('Error getting extension status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Helper: Get or create tier record for profile
 */
function getOrCreateTierRecord(db: DatabaseManager, profileId: string): { id: string; tier: string } {
    let record = db.getSessionByProfileId(profileId);
    if (!record) {
        const id = uuidv4();
        db.createSession({
            id,
            profileId,
            tier: 'UNKNOWN',
            isActive: false,
        });
        record = db.getSessionByProfileId(profileId)!;
    }
    return record;
}

/**
 * GET /profiles - List all profiles
 */
router.get('/profiles', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const browserManager = req.app.locals.browserManager as BrowserManager;
        const profileManager = new ProfileManager(db);

        const profiles = profileManager.getAllProfiles();

        // Add isActive status and tier to each profile
        const profilesWithStatus = profiles.map(profile => {
            const tierRecord = getOrCreateTierRecord(db, profile.id);
            const tier = tierRecord.tier as PaygateTier;
            const proxy = (profile.metadata as any)?.proxy;
            const flowProjects = (profile.metadata as any)?.flowProjects;

            return {
                ...profile,
                isActive: browserManager.isActive(profile.id),
                tier,
                proxy,
                flowProjects,
            };
        });

        const response: ApiResponse = {
            success: true,
            data: profilesWithStatus,
        };
        res.json(response);
    } catch (error: any) {
        logger.error('Error listing profiles:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * POST /profiles/create - Create a new profile
 */
router.post('/profiles/create', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const profileManager = new ProfileManager(db);

        const request: CreateProfileRequest = req.body;

        if (!request.name) {
            return res.status(400).json({
                success: false,
                error: 'Profile name is required',
            });
        }

        const profile = profileManager.createProfile(request);
        logger.info(`Created new profile: ${profile.name} (${profile.id})`);

        res.json({
            success: true,
            data: profile,
            message: 'Profile created successfully',
        });
    } catch (error: any) {
        logger.error('Error creating profile:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * POST /profiles/update-metadata - Update profile metadata
 */
router.post('/profiles/update-metadata', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const profileManager = new ProfileManager(db);

        const { id, metadata } = req.body || {};

        if (!id) {
            return res.status(400).json({
                success: false,
                error: 'Profile ID is required',
            });
        }

        const profile = profileManager.getProfile(id);
        if (!profile) {
            return res.status(404).json({
                success: false,
                error: 'Profile not found',
            });
        }

        const updatedMetadata = { ...(profile.metadata || {}), ...metadata };
        profileManager.updateProfile(id, { metadata: updatedMetadata });

        // Broadcast update to frontend
        const broadcast = req.app.locals.broadcast as (event: string, data: any) => void;
        broadcast('profiles-updated', {});

        res.json({
            success: true,
            data: { id, metadata: updatedMetadata },
            message: 'Profile metadata updated',
        });
    } catch (error: any) {
        logger.error('Error updating profile metadata:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * POST /profiles/open - Open profile and launch browser
 */
router.post('/profiles/open', async (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const browserManager = req.app.locals.browserManager as BrowserManager;
        const profileManager = new ProfileManager(db);

        const request: OpenProfileRequest = req.body;

        if (!request.id) {
            return res.status(400).json({
                success: false,
                error: 'Profile ID is required',
            });
        }

        const profile = profileManager.getProfile(request.id);
        if (!profile) {
            return res.status(404).json({
                success: false,
                error: 'Profile not found',
            });
        }

        // Check if already active
        if (browserManager.isActive(request.id)) {
            return res.json({
                success: true,
                data: { message: 'Profile already active' },
            });
        }

        // Launch browser (with or without stealth mode)
        const requestAny = req.body as any;

        // Build proxy config from profile metadata if present
        let proxyConfig: any = undefined;
        const proxy = (profile.metadata as any)?.proxy;
        if (proxy && proxy.host && proxy.port) {
            proxyConfig = {
                server: `http://${proxy.host}:${proxy.port}`,
            };
            if (proxy.username) {
                proxyConfig.username = proxy.username;
            }
            if (proxy.password) {
                proxyConfig.password = proxy.password;
            }
            logger.info(`Profile ${profile.name} will use proxy: ${proxy.host}:${proxy.port} (auth=${!!proxy.username})`);
        }

        const profileState = await browserManager.launchProfile(profile, {
            useCloakBrowser: requestAny.useStealth,
            proxy: proxyConfig,
        });

        // Update last used timestamp
        profileManager.touchProfile(request.id);

        // Pre-create the per-profile registries so routes and event
        // consumers can poll status immediately, even before the
        // extension connects. The extension websocket will be bound
        // to this profile when background.js sends extension_ready
        // with profileId.
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;
        if (extensionRegistry) extensionRegistry.getOrCreate(request.id);
        if (flowRegistry) flowRegistry.getOrCreate(request.id);

        // Broadcast open event so dashboards update without reload
        const broadcast = req.app.locals.broadcast as (event: string, data: any) => void;
        broadcast('profile-opened', { profileId: profile.id });

        // Detect and save tier from Extension (real-time from browser)
        const tierRecord = getOrCreateTierRecord(db, request.id);

        // Try to detect tier multiple times (browser needs time to load Flow page)
        const detectTier = async (attempt = 1) => {
            try {
                let tier: PaygateTier = 'UNKNOWN';
                let source = 'unknown';
                let creditsData: any = null;
                let authFailed = false;

                // Try extension bridge first (direct from browser)
                const bridge = extensionRegistry?.get(request.id);
                if (bridge && bridge.isConnected()) {
                    try {
                        creditsData = await bridge.getCredits();
                        console.log(`[Tier Detect #${attempt}] Extension credits raw:`, JSON.stringify(creditsData, null, 2));

                        // Only accept a real tier from the response. If the
                        // extension returned no `userPaygateTier` we keep
                        // tier = 'UNKNOWN' instead of misleadingly defaulting
                        // to TIER_ONE.
                        const rawTier = creditsData?.userPaygateTier;
                        if (rawTier === 'PAYGATE_TIER_ONE' || rawTier === 'PAYGATE_TIER_TWO') {
                            tier = rawTier;
                            source = 'extension';
                        } else {
                            logger.warn(`[Tier Detect #${attempt}] Extension returned no userPaygateTier (got: %s) — keeping UNKNOWN`, rawTier);
                        }
                        logger.info(`[Tier Detect #${attempt}] Extension credits data`, creditsData);
                    } catch (extError) {
                        // Extension returns NO_FLOW_KEY when the user hasn't
                        // logged into Flow in this profile yet. That's a
                        // permanent state until they log in — no point
                        // retrying every 5s.
                        authFailed = /no_flow_key|not signed in|login required/i.test(
                            extError instanceof Error ? extError.message : String(extError),
                        );
                        logger.warn(`[Tier Detect #${attempt}] Extension bridge getCredits failed: %s`, extError);
                    }
                }

                // Fallback to FlowApiClient
                if (source === 'unknown') {
                    const flowClient = flowRegistry?.get(request.id);
                    if (flowClient && flowClient.isConnected()) {
                        try {
                            creditsData = await flowClient.getCredits();
                            console.log(`[Tier Detect #${attempt}] FlowAPI credits raw:`, JSON.stringify(creditsData, null, 2));

                            const rawTier = creditsData?.userPaygateTier;
                            if (rawTier === 'PAYGATE_TIER_ONE' || rawTier === 'PAYGATE_TIER_TWO') {
                                tier = rawTier;
                                source = 'flow_api';
                            } else {
                                logger.warn(`[Tier Detect #${attempt}] Flow API returned no userPaygateTier (got: %s) — keeping UNKNOWN`, rawTier);
                            }
                            logger.info(`[Tier Detect #${attempt}] Flow API credits data`, creditsData);
                        } catch (flowError) {
                            if (flowClient.isAuthError(flowError)) {
                                authFailed = true;
                            }
                            logger.warn(`[Tier Detect #${attempt}] FlowApiClient getCredits failed: %s`, flowError);
                        }
                    }
                }

                console.log(`[Tier Detect #${attempt}] FINAL tier for profile ${request.id}:`, tier, '(source:', source + ')');

                // Update database
                db.updateSession(tierRecord.id, { tier });
                logger.info(`[Tier Detect #${attempt}] Saved tier for profile %s: %s (source: %s)`, request.id, tier, source);

                // Broadcast tier update to all connected clients
                broadcast('tier-updated', {
                    profileId: request.id,
                    tier,
                    source,
                });

                // Retry policy:
                // - Got a real tier → done.
                // - Auth failure (NO_FLOW_KEY, 401, login required) → stop
                //   entirely. The user has to log into Flow manually; we
                //   will detect the new tier on the next `extension_ready`
                //   / `token_captured` push.
                // - Other UNKNOWN → retry up to 3 times with a 5s gap.
                if (tier === 'UNKNOWN' && !authFailed && attempt < 3) {
                    setTimeout(() => detectTier(attempt + 1), 5000);
                } else if (authFailed) {
                    logger.info('[Tier Detect] Stopped retrying for profile %s — user has not signed into Flow (will resume when extension sends a new token)', request.id);
                }
            } catch (error) {
                logger.warn('Background tier detection failed for profile %s: %s', request.id, error);
            }
        };

        // Wait for the extension to actually connect before running
        // the first detect. Otherwise source is "unknown" on attempt #1
        // and the user sees a stale default tier. Poll up to 15s.
        const waitForBridge = async (deadlineMs: number): Promise<boolean> => {
            const start = Date.now();
            while (Date.now() - start < deadlineMs) {
                const b = extensionRegistry?.get(request.id);
                if (b && b.isConnected() && b.getStatus().flowKeyPresent) return true;
                await new Promise(r => setTimeout(r, 500));
            }
            return false;
        };
        waitForBridge(15000).then((ready) => {
            if (!ready) {
                logger.warn('[Tier Detect] Extension never connected for profile %s within 15s — will still attempt from Flow API', request.id);
            }
            detectTier();
        });

        res.json({
            success: true,
            data: {
                profileId: profile.id,
                sessionId: profileState.browserContext ? 'active' : null,
                extensionId: profileState.extensionId,
                message: 'Browser launched successfully',
            },
        });
    } catch (error: any) {
        logger.error('Error opening profile:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * POST /profiles/:id/proxy - Set proxy for a profile
 * Body: { proxy: "ip:port:user:pass" } or { proxy: null } to remove
 */
router.post('/profiles/:id/proxy', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const profileManager = new ProfileManager(db);

        const { id } = req.params;
        const { proxy } = req.body;

        if (!id) {
            return res.status(400).json({
                success: false,
                error: 'Profile ID is required',
            });
        }

        const existing = profileManager.getProfile(id);
        if (!existing) {
            return res.status(404).json({
                success: false,
                error: 'Profile not found',
            });
        }

        const metadata = { ...(existing.metadata || {}) };

        if (proxy === null || proxy === undefined || proxy === '') {
            // Remove proxy
            delete metadata.proxy;
        } else if (typeof proxy === 'string') {
            // Parse "ip:port:user:pass" format
            const parts = proxy.split(':');
            if (parts.length < 2) {
                return res.status(400).json({
                    success: false,
                    error: 'Proxy format invalid. Use: ip:port or ip:port:user:pass',
                });
            }
            const host = parts[0].trim();
            const port = parseInt(parts[1].trim(), 10);
            if (!host || isNaN(port)) {
                return res.status(400).json({
                    success: false,
                    error: 'Proxy host or port invalid',
                });
            }
            const proxyConfig: any = { host, port };
            if (parts.length >= 3 && parts[2].trim()) {
                proxyConfig.username = parts[2].trim();
            }
            if (parts.length >= 4 && parts[3].trim()) {
                proxyConfig.password = parts[3].trim();
            }
            metadata.proxy = proxyConfig;
        } else if (typeof proxy === 'object') {
            metadata.proxy = proxy;
        }

        profileManager.updateProfile(id, { metadata });
        const updated = profileManager.getProfile(id);

        logger.info(`Updated proxy for profile ${id}: ${JSON.stringify(metadata.proxy || null)}`);

        res.json({
            success: true,
            data: { ...updated, proxy: metadata.proxy || null },
            message: 'Proxy updated successfully',
        });
    } catch (error: any) {
        logger.error('Error updating proxy:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * PUT /profiles/:id - Update a profile
 */
router.put('/profiles/:id', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const profileManager = new ProfileManager(db);

        const { id } = req.params;
        const { name, metadata } = req.body;

        if (!id) {
            return res.status(400).json({
                success: false,
                error: 'Profile ID is required',
            });
        }

        const success = profileManager.updateProfile(id, { name, metadata });
        if (!success) {
            return res.status(404).json({
                success: false,
                error: 'Profile not found',
            });
        }

        const updatedProfile = profileManager.getProfile(id);
        logger.info(`Updated profile: ${id}`);

        res.json({
            success: true,
            data: updatedProfile,
            message: 'Profile updated successfully',
        });
    } catch (error: any) {
        logger.error('Error updating profile:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * DELETE /profiles/:id - Delete a profile
 */
router.delete('/profiles/:id', async (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const browserManager = req.app.locals.browserManager as BrowserManager;
        const profileManager = new ProfileManager(db);

        const { id } = req.params;

        if (!id) {
            return res.status(400).json({
                success: false,
                error: 'Profile ID is required',
            });
        }

        // Close browser if active
        if (browserManager.isActive(id)) {
            await browserManager.closeProfile(id);
        }

        // Delete profile (also deletes tier record)
        const success = profileManager.deleteProfile(id);
        if (!success) {
            return res.status(404).json({
                success: false,
                error: 'Profile not found',
            });
        }

        logger.info(`Deleted profile: ${id}`);
        res.json({
            success: true,
            message: 'Profile deleted successfully',
        });
    } catch (error: any) {
        logger.error('Error deleting profile:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * POST /profiles/:id/close - Close browser for a profile
 */
router.post('/profiles/:id/close', async (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const browserManager = req.app.locals.browserManager as BrowserManager;

        const { id } = req.params;

        if (!id) {
            return res.status(400).json({
                success: false,
                error: 'Profile ID is required',
            });
        }

        // Detect and save tier in background (non-blocking) — using
        // the per-profile FlowApiClient (if any) so we don't overwrite
        // another profile's flowKey.
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;
        const flowClient = flowRegistry?.get(id);
        if (flowClient && flowClient.isConnected() && flowClient.hasFlowKey()) {
            const tierRecord = getOrCreateTierRecord(db, id);
            flowClient.getCredits()
                .then(creditsData => {
                    const rawTier = creditsData?.userPaygateTier;
                    const tier: PaygateTier = (rawTier === 'PAYGATE_TIER_ONE' || rawTier === 'PAYGATE_TIER_TWO')
                        ? rawTier
                        : 'UNKNOWN';
                    db.updateSession(tierRecord.id, { tier });
                    logger.info('Saved tier on close for profile %s: %s', id, tier);
                })
                .catch((error) => {
                    logger.warn('Background tier detection failed on close: %s', error);
                });
        }

        const success = await browserManager.closeProfile(id);
        if (!success) {
            return res.status(404).json({
                success: false,
                error: 'No active session for this profile',
            });
        }

        // Drop the per-profile registries so stale state doesn't leak
        // into the next session of this profile.
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        if (extensionRegistry) extensionRegistry.remove(id);
        if (flowRegistry) flowRegistry.remove(id);

        logger.info(`Closed browser for profile: ${id}`);
        res.json({
            success: true,
            message: 'Browser closed successfully',
        });
    } catch (error: any) {
        logger.error('Error closing browser:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * GET /profiles/:id/tier - Get tier for a specific profile
 */
router.get('/profiles/:id/tier', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const tierRecord = getOrCreateTierRecord(db, req.params.id);

        res.json({
            success: true,
            data: {
                tier: tierRecord.tier as PaygateTier,
            },
        });
    } catch (error: any) {
        logger.error('Error getting tier:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * POST /profiles/:id/tier/refresh - Force refresh tier from Extension/Flow API
 */
router.post('/profiles/:id/tier/refresh', async (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;
        const profileId = req.params.id;

        const tierRecord = getOrCreateTierRecord(db, profileId);
        let tier: PaygateTier = 'UNKNOWN';
        let source = 'default';

        // Try extension bridge first (real-time from browser) — keyed by profileId
        const bridge = extensionRegistry?.get(profileId);
        if (bridge && bridge.isConnected()) {
            try {
                const creditsData = await bridge.getCredits();
                const rawTier = creditsData?.userPaygateTier;
                tier = (rawTier === 'PAYGATE_TIER_ONE' || rawTier === 'PAYGATE_TIER_TWO')
                    ? rawTier
                    : 'UNKNOWN';
                source = 'extension';
                db.updateSession(tierRecord.id, { tier });
                logger.info('Refreshed tier for profile %s from extension: %s', profileId, tier);

                // Broadcast so dashboard updates without reload
                const broadcast = req.app.locals.broadcast as (event: string, data: any) => void;
                broadcast('tier-updated', { profileId, tier, source });

                return res.json({
                    success: true,
                    data: { tier, source },
                    message: 'Tier refreshed from Extension',
                });
            } catch (extError) {
                logger.warn('Extension bridge getCredits failed during refresh for %s: %s', profileId, extError);
            }
        }

        // Fallback to per-profile FlowApiClient
        const flowClient = flowRegistry?.get(profileId);
        if (flowClient && flowClient.isConnected()) {
            try {
                const creditsData = await flowClient.getCredits();
                const rawTier = creditsData?.userPaygateTier;
                tier = (rawTier === 'PAYGATE_TIER_ONE' || rawTier === 'PAYGATE_TIER_TWO')
                    ? rawTier
                    : 'UNKNOWN';
                source = 'flow_api';
                db.updateSession(tierRecord.id, { tier });
                logger.info('Refreshed tier for profile %s from Flow API: %s', profileId, tier);

                const broadcast = req.app.locals.broadcast as (event: string, data: any) => void;
                broadcast('tier-updated', { profileId, tier, source });

                return res.json({
                    success: true,
                    data: { tier, source },
                    message: 'Tier refreshed from Flow API',
                });
            } catch (flowError) {
                logger.warn('FlowApiClient getCredits failed during refresh for %s: %s', profileId, flowError);
            }
        }

        // If not connected anywhere, return the cached value from DB as-is
        // (don't overwrite it with the current UNKNOWN default).
        res.json({
            success: true,
            data: { tier: tierRecord.tier as PaygateTier, source: 'database' },
            message: 'Extension not connected - showing cached tier',
        });
    } catch (error: any) {
        logger.error('Error refreshing tier:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * Entity Reference Routes
 */

const ENTITY_TYPES = ['character', 'location', 'creature', 'visual_asset', 'generic_troop', 'faction'];

const MATERIAL_STYLES = {
    '3d_pixar': { name: '3D Pixar', default: true },
    'realistic': { name: 'Photorealistic' },
    'anime': { name: 'Anime' },
    'ghibli': { name: 'Studio Ghibli' },
    'comic_book': { name: 'Comic Book' },
    'cyberpunk': { name: 'Cyberpunk' },
    'stop_motion': { name: 'Stop Motion' },
    'minecraft': { name: 'Minecraft' },
    'oil_painting': { name: 'Oil Painting' },
    'watercolor': { name: 'Watercolor' },
    'claymation': { name: 'Claymation' },
    'lego': { name: 'LEGO' },
    'retro_vhs': { name: 'Retro VHS' },
};

const ENTITY_ASPECT_RATIOS: Record<string, string> = {
    'location': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
    'character': 'IMAGE_ASPECT_RATIO_PORTRAIT',
    'creature': 'IMAGE_ASPECT_RATIO_PORTRAIT',
    'visual_asset': 'IMAGE_ASPECT_RATIO_SQUARE',
    'generic_troop': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
    'faction': 'IMAGE_ASPECT_RATIO_LANDSCAPE',
};

/**
 * GET /entities/types - Get all available entity types
 */
router.get('/entities/types', (_req: Request, res: Response) => {
    res.json({
        success: true,
        data: {
            entityTypes: ENTITY_TYPES,
            materials: MATERIAL_STYLES,
        },
    });
});

/**
 * GET /entities - Get all entity references
 */
router.get('/entities', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const profileId = req.query.profileId as string | undefined;

        let entities: any[];
        if (profileId) {
            entities = db.getEntityReferencesByProfile(profileId);
        } else {
            entities = db.getAllEntityReferences();
        }

        res.json({
            success: true,
            data: entities,
        });
    } catch (error: any) {
        logger.error('Error getting entities:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * GET /entities/:id - Get single entity reference
 */
router.get('/entities/:id', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const entity = db.getEntityReference(req.params.id);

        if (!entity) {
            return res.status(404).json({
                success: false,
                error: 'Entity not found',
            });
        }

        res.json({
            success: true,
            data: entity,
        });
    } catch (error: any) {
        logger.error('Error getting entity:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * POST /entities/generate - Generate a new entity reference image
 */
router.post('/entities/generate', async (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const profileManager = new ProfileManager(db);
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;
        const imageModels = req.app.locals.imageModels as any;

        const {
            name,
            description,
            entityType = 'character',
            materialId = '3d_pixar',
            profileId,
            projectId: requestedProjectId,
            materialStyle,
            modelKey: requestedModelKey,
            aspectRatio: requestedAspectRatio,
        } = req.body;

        // Validate required fields
        if (!name || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ success: false, error: 'name is required' });
        }
        if (!profileId || typeof profileId !== 'string') {
            return res.status(400).json({ success: false, error: 'profileId is required' });
        }

        // Validate entity type
        if (!ENTITY_TYPES.includes(entityType)) {
            return res.status(400).json({
                success: false,
                error: `Invalid entityType. Must be one of: ${ENTITY_TYPES.join(', ')}`,
            });
        }

        // Validate material
        if (!MATERIAL_STYLES[materialId]) {
            return res.status(400).json({
                success: false,
                error: `Invalid materialId. Must be one of: ${Object.keys(MATERIAL_STYLES).join(', ')}`,
            });
        }

        // Validate modelKey if provided
        const VALID_MODEL_KEYS = ['NANO_BANANA_PRO', 'NANO_BANANA_2', 'IMAGEN_4'];
        if (requestedModelKey && !VALID_MODEL_KEYS.includes(requestedModelKey)) {
            return res.status(400).json({
                success: false,
                error: `Invalid modelKey. Must be one of: ${VALID_MODEL_KEYS.join(', ')}`,
            });
        }

        const profile = profileManager.getProfile(profileId);
        if (!profile) {
            return res.status(404).json({ success: false, error: 'Profile not found' });
        }

        const tier = (profile.tier as PaygateTier) || 'PAYGATE_TIER_TWO';
        const aspectRatio = requestedAspectRatio || ENTITY_ASPECT_RATIOS[entityType] || 'IMAGE_ASPECT_RATIO_PORTRAIT';

        // Get project ID
        let targetProjectId = requestedProjectId || null;
        if (!targetProjectId) {
            const flowProjects: any[] = (profile.metadata as any)?.flowProjects || [];
            if (flowProjects.length > 0) {
                targetProjectId = flowProjects[0].projectId || flowProjects[0].id || null;
            }
        }

        if (!targetProjectId) {
            return res.status(400).json({
                success: false,
                error: 'No project ID available. Please create a Flow project first.',
            });
        }

        // Build prompt based on material and entity type
        const prompt = buildEntityPrompt(name, description, entityType, materialId, materialStyle);

        // Map frontend model key to API model name
        const MODEL_KEY_MAP: Record<string, string> = {
            'NANO_BANANA_PRO': 'GEM_PIX_2',
            'NANO_BANANA_2': 'NARWHAL',
            'IMAGEN_4': 'IMAGEN_3_5',
        };

        // Resolve model key - use requested model or fallback to image_models mapping, then default GEM_PIX_2
        const rawModelEntry = (imageModels as any)?.image_models?.[materialId];
        const resolvedModel = requestedModelKey || (typeof rawModelEntry === 'string' ? rawModelEntry : null);
        const apiModelKey = resolvedModel ? (MODEL_KEY_MAP[resolvedModel] || resolvedModel) : 'GEM_PIX_2';

        // Try extension bridge first, then FlowApiClient
        const bridge = extensionRegistry?.get(profileId);
        const flowClient = flowRegistry?.getOrCreate(profileId);

        let result: any = null;
        let usedBridge = false;

        if (bridge && bridge.isConnected()) {
            try {
                result = await bridge.generateImages({
                    projectId: targetProjectId,
                    prompt,
                    aspectRatio,
                    userPaygateTier: tier,
                    modelKey: apiModelKey,
                });
                usedBridge = true;
            } catch (bridgeError: any) {
                logger.warn('Extension bridge generate failed for %s: %s', profileId, bridgeError.message);
            }
        }

        if (!usedBridge) {
            if (!flowClient.hasFlowKey()) {
                return res.status(503).json({
                    success: false,
                    error: 'Flow client chưa có flowKey. Extension của profile này chưa kết nối hoặc chưa capture token.',
                });
            }
            result = await flowClient.generateImages({
                projectId: targetProjectId,
                prompt,
                aspectRatio,
                userPaygateTier: tier,
                modelKey: apiModelKey,
            });
        }

        // Parse response to extract mediaId and image URLs
        let mediaId: string | null = null;
        let servingUri: string | null = null;

        // Check if the API call was successful
        // Accept result with data, mediaId, or media array
        const hasValidResponse = result && typeof result === 'object' && (
            result.data || result.mediaId || (Array.isArray(result.media) && result.media.length > 0)
        );
        if (!hasValidResponse) {
            logger.error('Entity generation API returned empty or invalid response:', JSON.stringify(result)?.slice(0, 500));
            return res.status(500).json({
                success: false,
                error: 'API không trả về kết quả hợp lệ. Có thể tier không đủ hoặc cần chờ profile ready.',
            });
        }

        // Extract media info from response
        // Response format: { media: [{ name, workflowId, image: { generatedImage: { mediaGenerationId, ... } } }] }
        const mediaArray = result?.media || result?.data?.json?.media || [];
        const firstMedia = Array.isArray(mediaArray) && mediaArray.length > 0 ? mediaArray[0] : null;

        if (firstMedia) {
            mediaId = firstMedia.name || firstMedia.mediaId || firstMedia.mediaGenerationId ||
                firstMedia.image?.generatedImage?.mediaGenerationId || null;

            // Look for URL in various possible locations
            servingUri = firstMedia.fifeUrl || firstMedia.downloadUrl || firstMedia.uri ||
                firstMedia.servingUri || firstMedia.image?.generatedImage?.fifeUrl ||
                firstMedia.image?.generatedImage?.downloadUrl || null;
        }

        // Fallback: try legacy extraction
        if (!mediaId) mediaId = result?.data?.json?.result?.mediaId || result?.data?.json?.mediaId || null;
        if (!servingUri) servingUri = result?.data?.json?.result?.fifeUrl || result?.data?.json?.fifeUrl ||
            result?.data?.json?.result?.downloadUrl || result?.data?.json?.downloadUrl || null;

        // Final validation: must have at least mediaId or servingUri
        if (!mediaId && !servingUri) {
            logger.error('Could not extract mediaId or servingUri from API response:', JSON.stringify(result)?.slice(0, 1000));
            return res.status(500).json({
                success: false,
                error: 'Không tìm thấy ảnh trong response. Có thể API trả lỗi 400 hoặc tier không đủ.',
            });
        }

        // Download image to local storage
        let localPath = '';
        if (servingUri && mediaId) {
            try {
                const entitiesDir = path.join(process.cwd(), 'data', 'entity-references', profileId);
                if (!fs.existsSync(entitiesDir)) {
                    fs.mkdirSync(entitiesDir, { recursive: true });
                }
                const ext = servingUri.includes('.png') ? 'png' : 'jpg';
                localPath = path.join(entitiesDir, `${mediaId}.${ext}`);

                const imageResponse = await fetch(servingUri);
                if (imageResponse.ok) {
                    const buffer = await imageResponse.arrayBuffer();
                    fs.writeFileSync(localPath, Buffer.from(buffer));
                    logger.info(`Downloaded entity image to: ${localPath}`);
                } else {
                    localPath = '';
                }
            } catch (downloadError) {
                logger.warn(`Error downloading entity image: ${downloadError}`);
            }
        }

        // Save to database
        const entityId = crypto.randomUUID();
        const entityRecord = db.createEntityReference({
            id: entityId,
            name: name.trim(),
            description: description || '',
            entityType,
            materialId,
            mediaId: mediaId || '',
            localPath,
            remoteUrl: servingUri || '',
            profileId,
            projectId: targetProjectId || '',
            aspectRatio,
            metadata: JSON.stringify({
                generatedAt: new Date().toISOString(),
                tier,
                modelKey: apiModelKey,
            }),
        });

        res.json({
            success: true,
            data: entityRecord,
        });
    } catch (error: any) {
        logger.error('Error generating entity:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * DELETE /entities/:id - Delete entity reference
 */
router.delete('/entities/:id', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const entity = db.getEntityReference(req.params.id);

        if (!entity) {
            return res.status(404).json({
                success: false,
                error: 'Entity not found',
            });
        }

        // Delete local file if exists
        if (entity.localPath && fs.existsSync(entity.localPath)) {
            try {
                fs.unlinkSync(entity.localPath);
            } catch (e) {
                logger.warn(`Failed to delete local file: ${entity.localPath}`);
            }
        }

        db.deleteEntityReference(req.params.id);

        res.json({
            success: true,
            message: 'Entity deleted successfully',
        });
    } catch (error: any) {
        logger.error('Error deleting entity:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

// Helper function to build entity prompt
function buildEntityPrompt(name: string, description: string | undefined, entityType: string, materialId: string, materialStyle?: any): string {
    const materialPrompts: Record<string, string> = {
        '3d_pixar': '3D animated style, Pixar-quality rendering, Disney-Pixar aesthetic. Smooth subsurface scattering skin, expressive cartoon eyes, stylized proportions, vibrant saturated colors.',
        'realistic': 'Photorealistic RAW photograph, shot on Canon EOS R5, 35mm lens, natural available light, real footage.',
        'anime': 'Japanese anime style, cel-shaded rendering, vibrant saturated colors, clean sharp linework, large expressive eyes, stylized anatomy. High-quality anime production, studio Ghibli meets modern anime aesthetic.',
        'ghibli': 'Studio Ghibli anime style, hand-painted watercolor backgrounds, soft pastel colors, gentle rounded character designs, whimsical atmosphere. Hayao Miyazaki aesthetic, detailed natural environments, magical realism.',
        'comic_book': 'American comic book art style, bold black ink outlines, flat vibrant colors with halftone dot shading, dynamic action poses, dramatic foreshortening. Marvel/DC superhero comic aesthetic, Ben-Day dots.',
        'cyberpunk': 'Cyberpunk sci-fi aesthetic, neon-lit dark urban environment, holographic displays, rain-slicked streets reflecting neon signs. Blade Runner meets Ghost in the Shell, high-tech low-life, chrome and glass, purple and cyan color palette.',
        'stop_motion': 'Stop-motion animation style with handcrafted felt and wood puppets. Visible felt fabric texture, wooden joints and dowels, miniature handmade set pieces, warm craft workshop lighting. Laika Studios / Wes Anderson stop-motion aesthetic.',
        'minecraft': 'Minecraft voxel art style, blocky cubic geometry, pixel textures, 16x16 texture resolution aesthetic, square heads and bodies. Everything made of cubes and rectangular prisms. Minecraft game screenshot aesthetic.',
        'oil_painting': 'Classical oil painting on canvas, visible thick brushstrokes, rich impasto texture, warm color palette, chiaroscuro lighting. Renaissance masters meets impressionist technique. Museum-quality fine art painting.',
        'watercolor': 'Soft watercolor painting on cold-press paper, loose wet brushwork, translucent color washes bleeding into each other, white paper showing through. Delicate ink outlines, impressionistic and dreamy.',
        'claymation': 'Clay animation style, characters made of modeling clay with visible fingerprint textures, slightly imperfect sculpted features. Wallace & Gromit / Aardman aesthetic, miniature handmade sets, warm practical lighting on tiny clay world.',
        'lego': 'LEGO brick style, characters are LEGO minifigures with yellow skin and claw hands, environments built entirely from LEGO bricks and plates. Visible brick studs, ABS plastic texture, The LEGO Movie aesthetic.',
        'retro_vhs': '1980s VHS tape aesthetic, analog video noise and scan lines, slightly washed-out warm colors, CRT TV curvature, tracking artifacts. Retro camcorder footage feel, date stamp overlay, nostalgic grain.',
    };

    const compositionPrompts: Record<string, string> = {
        'character': 'Comprehensive character design sheet layout. Must include four distinct sections: 1. Body shots (Full body, half body, three-quarter body, and close-up). 2. Multi-angle character turnaround (A three-view: front, side, back rotation chart). 3. Expression sheet (Showing basic emotional states). 4. Pose sheet (Showing typical actions). Use a clean, neutral background.',
        'location': 'Comprehensive environment design sheet layout. Must include four distinct sections: 1. Master establishing shot (Wide angle showing the full environment). 2. Alternate angle (Reverse shot or different perspective). 3. Detail callouts (Close-up of key architectural, natural, or thematic details). 4. Lighting/Mood variation (Showing how the environment looks under different lighting or weather conditions). Maintain consistent spatial layout and atmosphere.',
        'creature': 'Comprehensive creature design sheet layout. Must include four distinct sections: 1. Body shots (Full body and close-up of face/head). 2. Multi-angle turnaround (Front, side, and back views). 3. Action/Movement poses (Showing natural stance, locomotion, or attack pose). 4. Detail callouts (Close-ups of specific anatomical features like claws, scales, or wings). Use a clean, neutral background.',
        'visual_asset': 'Comprehensive prop and asset design sheet layout. Must include four distinct sections: 1. Main beauty shot (Angled three-quarter perspective). 2. Orthographic views (Top, front, and side profiles). 3. Functional/Mechanical views (Showing how it opens, moves, or is held/used). 4. Material/Texture detail (Close-ups showcasing the surface materials and wear/tear). Use a clean, neutral background with proper scale reference.',
        'generic_troop': 'Comprehensive troop and uniform design sheet layout. Must include four distinct sections: 1. Uniform turnaround (Front, side, and back views of the standard loadout). 2. Gear breakdown (Detailed callouts of weapons, armor, and equipment). 3. Rank/Class variations (Showing slight modifications for different roles). 4. Action poses (Showing the troop in a combat or tactical stance). Use a clean, neutral background.',
        'faction': 'Comprehensive faction uniform design sheet layout. Must include four distinct sections: 1. Uniform turnaround (Front, side, and back views of the standard loadout). 2. Gear breakdown (Detailed callouts of weapons, armor, and equipment). 3. Rank/Class variations (Showing slight modifications for different roles). 4. Action poses (Showing the troop in a combat or tactical stance). Use a clean, neutral background.',
    };

    // Use custom materialStyle if provided, otherwise fall back to built-in
    let stylePrompt: string;
    if (materialStyle?.style_instruction) {
        stylePrompt = materialStyle.style_instruction;
        if (materialStyle.negative_prompt) {
            stylePrompt += ' ' + materialStyle.negative_prompt;
        }
    } else {
        stylePrompt = materialPrompts[materialId] || materialPrompts['3d_pixar'];
    }

    const compositionPrompt = compositionPrompts[entityType] || compositionPrompts['character'];
    const baseDesc = description || name;
    const sheetName = entityType === 'character' ? 'character design sheet' :
        entityType === 'location' ? 'environment design sheet' :
            entityType === 'creature' ? 'creature design sheet' :
                entityType === 'visual_asset' ? 'prop and asset design sheet' :
                    'concept design sheet';

    return `Comprehensive ${sheetName} for ${baseDesc}. ${stylePrompt} ${compositionPrompt} Studio lighting, highly detailed, global illumination.`;
}

export default router;
