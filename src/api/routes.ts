import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { ProfileManager } from '../profile-manager/ProfileManager';
import { CreateProfileRequest, OpenProfileRequest, ApiResponse, PaygateTier } from '../types';
import logger from '../utils/logger';
import { DatabaseManager } from '../database/Database';
import { BrowserManager } from '../browser-manager/BrowserManager';
import { ExtensionBridgeRegistry } from '../flow-api/ExtensionBridgeRegistry';
import { FlowApiRegistry } from '../flow-api/FlowApiRegistry';
import imageModels from '../../veo_models.json';

const API_MAX_RETRIES = 2;
const API_RETRY_DELAY_MS = 2000;

// Helper to check if error is retryable
function isRetryableApiError(error: string): boolean {
    const err = error.toLowerCase();
    return err.includes('403') ||
           err.includes('captcha') ||
           err.includes('blocked') ||
           err.includes('verify') ||
           err.includes('rate limit') ||
           err.includes('429') ||
           err.includes('timeout') ||
           err.includes('econnreset') ||
           err.includes('network') ||
           err.includes('temporary failure');
}

// Generic API retry wrapper
async function withRetry<T>(
    operation: () => Promise<T>,
    context: string
): Promise<{ result: T; attempts: number }> {
    let lastError: string = '';
    
    for (let attempt = 0; attempt <= API_MAX_RETRIES; attempt++) {
        try {
            const result = await operation();
            return { result, attempts: attempt + 1 };
        } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            
            if (isRetryableApiError(lastError) && attempt < API_MAX_RETRIES) {
                logger.warn(`[API Retry] ${context} - attempt ${attempt + 1} failed: ${lastError}. Retrying in ${API_RETRY_DELAY_MS}ms...`);
                await new Promise(resolve => setTimeout(resolve, API_RETRY_DELAY_MS));
                continue;
            }
            
            // Non-retryable or max retries exceeded
            throw err;
        }
    }
    
    throw new Error(lastError || 'Max retries exceeded');
}

/**
 * Resolve frontend model label to actual model key
 * Based on veo_models.json structure
 * Supports: T2V (text to video), R2V (reference to video), I2V (image-to-video)
 *
 * Frontend may send model labels with prefixes like:
 * - "image veo 3.1 - fast" -> strip "image " -> use I2V
 * - "reference veo 3.1 - fast" -> strip "reference " -> use R2V
 * - "omni flash" -> use T2V with OMNI_FLASH
 */
function resolveVideoModelKey(
    modelLabel: string,
    aspectRatio: string,
    tier: string,
    mode: 'start_image' | 'start_end' | 'references',
    duration?: string
): string {
    const isPortrait = aspectRatio === 'VIDEO_ASPECT_RATIO_PORTRAIT';
    const normalizedLabel = modelLabel.toLowerCase().trim();
    const tierKey = tier === 'PAYGATE_TIER_ONE' ? 'PAYGATE_TIER_ONE' : 'PAYGATE_TIER_TWO';
    const models = (imageModels as any).video_models?.[tierKey];

    logger.info(`[resolveVideoModelKey] >>> IN modelLabel=${modelLabel} aspectRatio=${aspectRatio} tier=${tier} mode=${mode} duration=${duration} tierKey=${tierKey} modelsKeys=${Object.keys(models || {})} modeModelsKeys=${models ? Object.keys(models) : 'null'}`);

    if (!models) {
        return 'veo_3_1_t2v_fast_ultra';
    }

    // Strip prefixes that frontend adds for display purposes
    // "image veo 3.1 - fast" -> "veo 3.1 - fast"
    // "reference veo 3.1 - fast" -> "veo 3.1 - fast"
    const labelWithoutPrefix = normalizedLabel
        .replace(/^image\s+/, '')
        .replace(/^reference\s+/, '')
        .replace(/^text\s+/, '')
        .trim();

    // Determine mode type based on veo_models.json: T2V, R2V, I2V
    // I2V = start_image or start_end (image-to-video with start/end images)
    // R2V = references (reference-to-video)
    // T2V = text-to-video (start_image without images)
    let modeKey: string;
    if (mode === 'start_end') {
        modeKey = 'I2V';
    } else if (mode === 'start_image') {
        // Check if it's actually an i2v request (has prefix)
        if (normalizedLabel.startsWith('image ')) {
            modeKey = 'I2V';
        } else {
            modeKey = 'T2V';
        }
    } else if (mode === 'references') {
        modeKey = 'R2V';
    } else {
        modeKey = 'T2V';
    }

    // Model quality tier based on label
    let qualityKey: string;
    if (normalizedLabel.includes('omni flash')) {
        qualityKey = 'OMNI_FLASH';
    } else if (labelWithoutPrefix.includes('fast')) {
        qualityKey = 'FAST';
    } else if (labelWithoutPrefix.includes('quality')) {
        qualityKey = 'QUALITY';
    } else if (labelWithoutPrefix.includes('lite') && labelWithoutPrefix.includes('priority')) {
        qualityKey = 'LITE_LOW_PRIORITY';
    } else if (labelWithoutPrefix.includes('lite')) {
        qualityKey = 'LITE';
    } else {
        qualityKey = 'FAST'; // Default to FAST
    }

    // Get model config from veo_models.json
    const modeModels = models[modeKey];
    logger.info(`[resolveVideoModelKey] modeKey=${modeKey} modeModels=${JSON.stringify(modeModels)}`);
    if (!modeModels) {
        logger.warn(`[Video Model] Mode ${modeKey} not found in tier ${tierKey}, falling back to T2V`);
        // Return mode-appropriate fallback, not hardcoded T2V
        if (modeKey === 'R2V') return isPortrait ? 'veo_3_1_r2v_fast_portrait_ultra' : 'veo_3_1_r2v_fast_landscape_ultra';
        if (modeKey === 'I2V') return isPortrait ? 'veo_3_1_i2v_fast_portrait_ultra' : 'veo_3_1_i2v_fast_landscape_ultra';
        return isPortrait ? 'veo_3_1_t2v_fast_portrait_ultra' : 'veo_3_1_t2v_fast_ultra';
    }

    const qualityConfig = modeModels[qualityKey];
    logger.info(`[resolveVideoModelKey] qualityKey=${qualityKey} qualityConfig=${JSON.stringify(qualityConfig)} typeof=${typeof qualityConfig}`);
    if (!qualityConfig) {
        logger.warn(`[Video Model] Quality ${qualityKey} not found for mode ${modeKey}, falling back to FAST`);
        const fastConfig = modeModels['FAST'];
        if (!fastConfig) {
            // Return mode-appropriate fallback
            if (modeKey === 'R2V') return isPortrait ? 'veo_3_1_r2v_fast_portrait_ultra' : 'veo_3_1_r2v_fast_landscape_ultra';
            if (modeKey === 'I2V') return isPortrait ? 'veo_3_1_i2v_fast_portrait_ultra' : 'veo_3_1_i2v_fast_landscape_ultra';
            return 'veo_3_1_t2v_fast_ultra';
        }
        // Return default 8s landscape fast model
        if (typeof fastConfig === 'string') {
            return fastConfig;
        }
        return fastConfig['VIDEO_ASPECT_RATIO_LANDSCAPE'] || Object.values(fastConfig)[0] as string;
    }

    // Duration key for lookup (e.g., "4s" -> "VIDEO_DURATION_4S")
    const durationKey = duration ? `VIDEO_DURATION_${duration.toUpperCase()}` : null;

    // Omni Flash - direct duration to model key
    if (qualityKey === 'OMNI_FLASH') {
        if (durationKey && qualityConfig[durationKey]) {
            return qualityConfig[durationKey];
        }
        return qualityConfig['VIDEO_DURATION_8S'] || 'abra_t2v_8s';
    }

    // Lite / Lite Low Priority - direct duration to model key (no aspect ratio)
    if (qualityKey === 'LITE' || qualityKey === 'LITE_LOW_PRIORITY') {
        if (durationKey && qualityConfig[durationKey]) {
            return qualityConfig[durationKey];
        }
        return qualityConfig['VIDEO_DURATION_8S'] || Object.values(qualityConfig)[0] as string;
    }

    // FAST / QUALITY - check aspect ratio directly
    if (typeof qualityConfig === 'object') {
        logger.info(`[resolveVideoModelKey] qualityConfig=${JSON.stringify(qualityConfig)} aspectRatio=${aspectRatio} durationKey=${durationKey}`);

        // Duration-specific config (4s/6s with aspect ratio)
        if (durationKey && typeof qualityConfig[durationKey] === 'object') {
            const durationAspectConfig = qualityConfig[durationKey] as Record<string, string>;
            const result = durationAspectConfig[aspectRatio] || durationAspectConfig['VIDEO_ASPECT_RATIO_LANDSCAPE'];
            logger.info(`[resolveVideoModelKey] RETURNING duration+aspect: ${result}`);
            return result;
        }

        // Direct aspect ratio keys (no duration)
        const directResult = qualityConfig[aspectRatio];
        logger.info(`[resolveVideoModelKey] directResult=${directResult} isPortrait=${isPortrait}`);
        if (directResult) {
            logger.info(`[resolveVideoModelKey] RETURNING direct aspect ratio: ${directResult}`);
            return directResult;
        }

        // Try 8s default
        const config8s = qualityConfig['VIDEO_DURATION_8S'];
        if (config8s) {
            if (typeof config8s === 'string') {
                logger.info(`[resolveVideoModelKey] RETURNING 8s string: ${config8s}`);
                return config8s;
            }
            if (typeof config8s === 'object') {
                const result = config8s[aspectRatio] || config8s['VIDEO_ASPECT_RATIO_LANDSCAPE'];
                logger.info(`[resolveVideoModelKey] RETURNING 8s object: ${result}`);
                return result;
            }
        }

        const result = qualityConfig['VIDEO_ASPECT_RATIO_LANDSCAPE'] || Object.values(qualityConfig)[0] as string;
        logger.info(`[resolveVideoModelKey] RETURNING last resort: ${result}`);
        return result;
    }

    // Fallback - return mode-appropriate model
    logger.info(`[resolveVideoModelKey] RETURNING fallback`);
    if (modeKey === 'R2V') return isPortrait ? 'veo_3_1_r2v_fast_portrait_ultra' : 'veo_3_1_r2v_fast_landscape_ultra';
    if (modeKey === 'I2V') return isPortrait ? 'veo_3_1_i2v_fast_portrait_ultra' : 'veo_3_1_i2v_fast_landscape_ultra';
    return isPortrait ? 'veo_3_1_t2v_fast_portrait_ultra' : 'veo_3_1_t2v_fast_ultra';
}

const router = express.Router();

/**
 * Cache of media IDs whose status has been confirmed SUCCESSFUL.
 * Used to short-circuit batchCheckAsyncVideoGenerationStatus calls -
 * once we know a video is ready, no need to keep asking Google.
 */
const successfulMediaCache = new Map<string, { profileId: string; projectId: string; mediaItem: any; ts: number }>();
const SUCCESS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min

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
 * Query: ?profileId=xxx (required) ? per-profile, no cross-profile leakage.
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
                    error: 'Flow client ch?a c? flowKey. Extension c?a profile n?y ch?a k?t n?i ho?c ch?a capture token.',
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
            message: 'T?o project tr?n Flow th?nh c?ng',
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
                        error: 'Flow client ch?a c? flowKey. Extension c?a profile n?y ch?a k?t n?i ho?c ch?a capture token.',
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
            message: `?? x? l? ${settled.length} profile`,
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
            upscaleResolution,
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
                error: 'Kh?ng c? Flow project kh? d?ng. H?y m? profile v? ??ng nh?p Google Flow, ho?c cung c?p projectId.',
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
                    sceneId: `image-${Date.now()}`,
                    prompt: prompt.trim(),
                    aspectRatio: resolvedAspectRatio,
                    userPaygateTier: resolvedTier,
                    modelKey: apiModelKey,
                });
                const resultStr = typeof result === 'string' ? result.trim() : '';
                if (resultStr.startsWith('<!DOCTYPE') || resultStr.startsWith('<html')) {
                    logger.warn('Extension bridge returned HTML 404 for image generation endpoint, falling back to FlowApiClient');
                    result = null;
                } else {
                    usedBridge = true;
                }
            } catch (bridgeError: any) {
                logger.warn('Extension bridge generateImages failed for %s, falling back: %s', profileId, bridgeError.message);
            }
        }

        if (!usedBridge) {
            if (!flowClient || !flowClient.hasFlowKey()) {
                return res.status(503).json({
                    success: false,
                    error: 'Flow client ch?a c? flowKey. Extension c?a profile n?y ch?a k?t n?i ho?c ch?a capture token.',
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
                error: 'API kh?ng tr? v? ?nh. C? th? tier kh?ng ??, profile ch?a ready, ho?c c?n ch? th?m.',
            });
        }

        // Download image to local storage if we have a URL
        let localPath: string | null = null;
        const imagesDir = path.join(process.cwd(), 'data', 'generated-images');
        if (!fs.existsSync(imagesDir)) {
            fs.mkdirSync(imagesDir, { recursive: true });
        }
        const ext = servingUri?.includes('.png') ? 'png' : 'jpg';
        if (servingUri && mediaId) {
            try {
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

        // Upscale if requested (2K or 4K)
        if (upscaleResolution && upscaleResolution !== 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL' && mediaId && bridge && bridge.isConnected()) {
            try {
                logger.info(`Upscaling image ${mediaId} to ${upscaleResolution}`);
                const upscaleResponse = await bridge.upscaleImage({
                    mediaId,
                    targetResolution: upscaleResolution,
                    projectId: targetProjectId,
                    userPaygateTier: resolvedTier,
                });

                const bridgeResponse = upscaleResponse?.json ?? upscaleResponse;
                const encodedImage = bridgeResponse?.encodedImage;
                const opMetadata = (bridgeResponse?.metadata || {}) as any;
                const imageMeta = opMetadata.image || {};
                const fifeUrl = imageMeta.fifeUrl;
                const opName = bridgeResponse?.name;
                const opDone = bridgeResponse?.done;

                if (encodedImage) {
                    const upscaleSuffix = upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K' ? '_4k' : '_2k';
                    const newMediaId = mediaId + upscaleSuffix;
                    const upscalePath = path.join(imagesDir, `${newMediaId}.${ext}`);
                    if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
                    const imageBuffer = Buffer.from(encodedImage, 'base64');
                    fs.writeFileSync(upscalePath, imageBuffer);
                    mediaId = newMediaId;
                    servingUri = null;
                    localPath = upscalePath;
                    logger.info(`Image upscaled (base64) and saved: ${upscalePath}`);
                } else if (opDone && fifeUrl) {
                    const upscaleSuffix = upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K' ? '_4k' : '_2k';
                    const newMediaId = mediaId + upscaleSuffix;
                    const upscalePath = path.join(imagesDir, `${newMediaId}.${ext}`);
                    if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
                    const imageResponse = await fetch(fifeUrl);
                    if (imageResponse.ok) {
                        const buffer = await imageResponse.arrayBuffer();
                        fs.writeFileSync(upscalePath, Buffer.from(buffer));
                        servingUri = fifeUrl;
                        localPath = upscalePath;
                        mediaId = newMediaId;
                        logger.info(`Image upscaled (URL) and saved: ${upscalePath}`);
                    }
                } else if (opName && !opDone) {
                    logger.info(`Upscale operation started: ${opName} (async)`);
                }
            } catch (upscaleError: any) {
                logger.warn(`Image upscale failed (will use original): ${upscaleError.message}`);
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
            message: usedBridge ? 'T?o ?nh th�nh c�ng' : 'T?o ?nh th�nh c�ng qua Flow API',
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
                error: 'Extension ch?a s?n s?ng sau th?i gian ch?. H?y ??m b?o profile ?? ??ng nh?p Google Flow v? extension ?? capture token.',
            });
        }

        res.json({
            success: true,
            data: {
                profileId,
                opened: !browserManager.isActive(profileId),
                ready: true,
            },
            message: 'Profile ?? s?n s?ng ?? t?o project',
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
router.post('/ext/callback', express.json({ type: '*/*', limit: '100mb' }), (req: Request, res: Response) => {
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
            projectUrl: requestAny.projectUrl,
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
                let isConnectionError = false;

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
                            logger.warn(`[Tier Detect #${attempt}] Extension returned no userPaygateTier (got: %s) ? keeping UNKNOWN`, rawTier);
                        }
                        logger.info(`[Tier Detect #${attempt}] Extension credits data`, creditsData);
                    } catch (extError) {
                        // Extension returns NO_FLOW_KEY when the user hasn't
                        // logged into Flow in this profile yet. That's a
                        // permanent state until they log in ? no point
                        // retrying every 5s.
                        authFailed = /no_flow_key|not signed in|login required/i.test(
                            extError instanceof Error ? extError.message : String(extError),
                        );
                        isConnectionError = extError instanceof Error &&
                            extError.message.includes('Failed to fetch');
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
                                logger.warn(`[Tier Detect #${attempt}] Flow API returned no userPaygateTier (got: %s) ? keeping UNKNOWN`, rawTier);
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
                // - Got a real tier ? done.
                // - Auth failure (NO_FLOW_KEY, 401, login required) ? stop
                //   entirely. The user has to log into Flow manually; we
                //   will detect the new tier on the next `extension_ready`
                //   / `token_captured` push.
                // - Connection error (Failed to fetch) ? stop, extension not ready
                // - Other UNKNOWN ? retry up to 3 times with a 5s gap.
                if (tier === 'UNKNOWN' && !authFailed && !isConnectionError && attempt < 3) {
                    setTimeout(() => detectTier(attempt + 1), 5000);
                } else if (authFailed) {
                    logger.info('[Tier Detect] Stopped retrying for profile %s - user has not signed into Flow (will resume when extension sends a new token)', request.id);
                } else if (isConnectionError) {
                    logger.info('[Tier Detect] Stopped retrying for profile %s - extension not ready (will resume on extension_ready)', request.id);
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
                logger.warn('[Tier Detect] Extension never connected for profile %s within 15s ? will still attempt from Flow API', request.id);
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

        // Detect and save tier in background (non-blocking) ? using
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

        // Broadcast so dashboard updates without reload
        const broadcast = req.app.locals.broadcast as (event: string, data: any) => void;
        broadcast('profiles-updated', { profileId: id });

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

        // Try extension bridge first (real-time from browser) ? keyed by profileId
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

function resolveMaterialStyle(materialId?: string, req?: Request): { prefix: string; instruction: string; negative_prompt: string } | null {
    const id = (materialId || '').trim();
    if (!id) return null;

    const fromRegistry = req ? (req.app.locals.materialRegistry as any | undefined) : undefined;
    const entry = fromRegistry?.get?.(id) || fromRegistry?.[id];
    if (entry?.style_instruction) {
        return {
            prefix: entry.scene_prefix || entry.style_instruction,
            instruction: entry.style_instruction,
            negative_prompt: entry.negative_prompt || '',
        };
    }

    const promptMap: Record<string, string> = {
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

    const prompt = promptMap[id];
    if (!prompt) return null;
    return { prefix: prompt, instruction: prompt, negative_prompt: '' };
}

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
 * POST /library/entities/:id/upload - Upload library entity image to Flow and return new mediaId
 * Simple: just find the file and upload using existing flow endpoint
 */
router.post('/library/entities/:id/upload', async (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const profileManager = new ProfileManager(db);
        const { profileId, projectId } = req.body || {};
        const entityId = req.params.id;

        if (!profileId || !projectId) {
            return res.status(400).json({
                success: false,
                error: 'profileId and projectId are required',
            });
        }

        const profile = profileManager.getProfile(profileId);
        if (!profile) {
            return res.status(404).json({ success: false, error: 'Profile not found' });
        }

        // Try to get entity from DB
        const entity = db.getEntityReference(entityId);

        // Determine filePath - check multiple possible locations
        let filePath: string | undefined;
        let originalMediaId = '';
        let fileName = `${entityId}.jpg`;

        if (entity) {
            // Use localPath from DB entity
            if (entity.localPath && fs.existsSync(entity.localPath)) {
                filePath = entity.localPath;
            }
            // Try remoteUrl
            if (!filePath && entity.remoteUrl) {
                const possiblePath = path.join(process.cwd(), entity.remoteUrl);
                if (fs.existsSync(possiblePath)) {
                    filePath = possiblePath;
                }
            }
            originalMediaId = entity.mediaId || '';
            fileName = path.basename(filePath || fileName);
        }

        // If not found, try to find file directly in data/entity-references directories
        if (!filePath) {
            const entitiesBaseDir = path.join(process.cwd(), 'data', 'entity-references');
            const searchForFile = (dir: string): string | null => {
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                            const found = searchForFile(fullPath);
                            if (found) return found;
                        } else if (entry.isFile() && (
                            entry.name === `${entityId}.jpg` ||
                            entry.name === `${entityId}.png` ||
                            entry.name === `${entityId}.jpeg`
                        )) {
                            return fullPath;
                        }
                    }
                } catch (e) {
                    logger.debug(`[Routes] Error searching directory: ${e}`);
                }
                return null;
            };
            filePath = searchForFile(entitiesBaseDir) || undefined;
            originalMediaId = entityId;
            if (filePath) {
                fileName = path.basename(filePath);
            }
        }

        if (!filePath) {
            return res.status(404).json({
                success: false,
                error: `Image file not found for entity ${entityId}`,
            });
        }

        logger.info(`[Library Upload] Uploading entity ${entityId} from ${filePath}`);

        // Read file and convert to base64 for FlowApiClient
        let fileBase64 = '';
        if (filePath) {
            const fileBuffer = fs.readFileSync(filePath);
            fileBase64 = fileBuffer.toString('base64');
        }

        // Use the existing upload endpoint logic directly
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;
        const bridge = extensionRegistry?.get(profileId);
        const flowClient = flowRegistry?.getOrCreate(profileId);
        const uploadSceneId = `library-upload-${Date.now()}`;

        let uploadResult: any = null;

        if (bridge && bridge.isConnected()) {
            uploadResult = await bridge.uploadImage({
                filePath,
                fileName,
                projectId,
                sceneId: uploadSceneId,
            });
        } else if (flowClient && flowClient.hasFlowKey()) {
            // FlowApiClient.uploadImage takes (imageBase64, mimeType, projectId, fileName)
            uploadResult = await flowClient.uploadImage(
                fileBase64,
                'image/jpeg',
                projectId,
                fileName
            );
        }

        // Extract mediaId - result has data.media.name or _mediaId
        const newMediaId = uploadResult?.data?.media?.name || uploadResult?._mediaId;
        if (!newMediaId) {
            logger.error('[Library Upload] Upload failed:', uploadResult);
            return res.status(500).json({
                success: false,
                error: 'Failed to upload image to Flow',
                rawResult: uploadResult,
            });
        }

        logger.info(`[Library Upload] Success - new mediaId: ${newMediaId}`);

        res.json({
            success: true,
            data: {
                entityId,
                originalMediaId,
                newMediaId,
                fileName,
            },
        });
    } catch (error: any) {
        logger.error('[Library Upload] Error:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * GET /library/entities - List entities grouped by type for Library UI
 */
router.get('/library/entities', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const profileId = req.query.project_id as string | undefined;

        let entities: any[];
        if (profileId) {
            entities = db.getEntityReferencesByProfile(profileId);
        } else {
            entities = db.getAllEntityReferences();
        }

        // If no entities in DB, scan disk directories for existing images
        if (entities.length === 0) {
            console.log('[Library] No entities in DB, scanning disk directories...');
            const entitiesFromDisk: any[] = [];
            const entitiesBaseDir = path.join(process.cwd(), 'data', 'entity-references');

            try {
                if (fs.existsSync(entitiesBaseDir)) {
                    const profileDirs = fs.readdirSync(entitiesBaseDir);
                    for (const profileDir of profileDirs) {
                        const profilePath = path.join(entitiesBaseDir, profileDir);
                        if (!fs.statSync(profilePath).isDirectory()) continue;

                        const files = fs.readdirSync(profilePath);
                        for (const file of files) {
                            // Only process image files (skip upscaled versions)
                            if (!file.match(/\.(jpg|jpeg|png)$/i)) continue;
                            if (file.includes('_4k') || file.includes('_2k')) continue;

                            const mediaId = file.replace(/\.(jpg|jpeg|png)$/i, '');
                            const localPath = path.join(profilePath, file);

                            // Try to determine entity type from directory structure or filename
                            const entityType = 'character'; // Default
                            const name = mediaId.substring(0, 8) + '...'; // Use truncated ID as name

                            entitiesFromDisk.push({
                                id: mediaId,
                                name: name,
                                slug: mediaId.substring(0, 8),
                                entity_type: entityType,
                                description: `Entity from disk (${file})`,
                                image_prompt: name,
                                reference_image_url: `/data/entity-references/${profileDir}/${file}`,
                                media_id: mediaId,
                                profileId: profileDir,
                            });
                        }
                    }
                }
                console.log(`[Library] Found ${entitiesFromDisk.length} images on disk`);
            } catch (diskError: any) {
                console.error('[Library] Error scanning disk:', diskError.message);
            }

            entities = entitiesFromDisk;
        }

        // Filter by entity_type if specified
        const entityType = req.query.entity_type as string | undefined || req.query.entityType as string | undefined;
        if (entityType) {
            entities = entities.filter(e => e.entityType === entityType || e.entity_type === entityType);
        }

        // Filter by search if specified
        const search = req.query.search as string | undefined;
        if (search) {
            const searchLower = search.toLowerCase();
            entities = entities.filter(e =>
                e.name?.toLowerCase().includes(searchLower) ||
                e.description?.toLowerCase().includes(searchLower)
            );
        }

        // Filter by has_image if specified
        const hasImage = req.query.has_image === 'true';
        if (hasImage) {
            entities = entities.filter(e => e.mediaId || e.media_id);
        }

        // Group by entity type
        const grouped: Record<string, any[]> = {
            character: [],
            location: [],
            creature: [],
            visual_asset: [],
            generic_troop: [],
            faction: [],
        };

        for (const entity of entities) {
            const etype = entity.entityType || entity.entity_type || 'character';
            if (!grouped[etype]) grouped[etype] = [];
            grouped[etype].push({
                id: entity.id,
                name: entity.name,
                slug: entity.slug || entity.name?.toLowerCase().replace(/\s+/g, '-'),
                entity_type: etype,
                description: entity.description,
                image_prompt: entity.image_prompt || entity.description || entity.name,
                reference_image_url: entity.reference_image_url || entity.remoteUrl || entity.localPath,
                media_id: entity.media_id || entity.mediaId,
            });
        }

        const result = {
            entities: entities.map(e => ({
                id: e.id,
                name: e.name,
                slug: e.slug || e.name?.toLowerCase().replace(/\s+/g, '-'),
                entity_type: e.entityType || e.entity_type || 'character',
                description: e.description,
                image_prompt: e.image_prompt || e.description || e.name,
                reference_image_url: e.reference_image_url || e.remoteUrl || e.localPath,
                media_id: e.media_id || e.mediaId,
            })),
            grouped,
            counts: {
                character: grouped.character?.length || 0,
                location: grouped.location?.length || 0,
                creature: grouped.creature?.length || 0,
                visual_asset: grouped.visual_asset?.length || 0,
                generic_troop: grouped.generic_troop?.length || 0,
                faction: grouped.faction?.length || 0,
            },
            total: entities.length,
        };

        res.json(result);
    } catch (error: any) {
        logger.error('Error getting library entities:', error);
        res.status(500).json({
            success: false,
            error: error.message,
        });
    }
});

/**
 * GET /library/entity-types - List entity types for Library UI tabs
 */
router.get('/library/entity-types', (_req: Request, res: Response) => {
    res.json([
        { id: 'character', name: 'Characters', icon: '??', description: 'People, heroes, villains, NPCs' },
        { id: 'location', name: 'Locations', icon: '??', description: 'Scenes, environments, backgrounds' },
        { id: 'creature', name: 'Creatures', icon: '??', description: 'Monsters, animals, fantasy beings' },
        { id: 'visual_asset', name: 'Assets', icon: '??', description: 'Props, costumes, vehicles' },
        { id: 'generic_troop', name: 'Troops', icon: '??', description: 'Soldiers, armies, groups' },
        { id: 'faction', name: 'Factions', icon: '??', description: 'Teams, guilds, organizations' },
    ]);
});

/**
 * GET /scripts - List all scripts for a profile
 */
router.get('/scripts', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const profileId = req.query.profileId as string | undefined;
        const projectId = req.query.projectId as string | undefined;

        let scripts: any[];
        if (projectId) {
            scripts = db.getScriptReferencesByProject(projectId);
        } else if (profileId) {
            scripts = db.getScriptReferencesByProfile(profileId);
        } else {
            return res.status(400).json({ success: false, error: 'profileId or projectId is required' });
        }

        res.json({
            success: true,
            data: scripts.map(s => ({
                ...s,
                content: undefined, // Don't send full content in list
            })),
        });
    } catch (error: any) {
        logger.error('Error listing scripts:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /scripts/:id - Get a single script with full content
 */
router.get('/scripts/:id', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const script = db.getScriptReference(req.params.id);

        if (!script) {
            return res.status(404).json({ success: false, error: 'Script not found' });
        }

        let content = null;
        try {
            content = JSON.parse(script.content);
        } catch {
            content = null;
        }

        res.json({
            success: true,
            data: {
                ...script,
                content,
            },
        });
    } catch (error: any) {
        logger.error('Error getting script:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * DELETE /scripts/:id - Delete a script
 */
router.delete('/scripts/:id', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const deleted = db.deleteScriptReference(req.params.id);

        if (!deleted) {
            return res.status(404).json({ success: false, error: 'Script not found' });
        }

        res.json({ success: true });
    } catch (error: any) {
        logger.error('Error deleting script:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /scripts/update-scenes - Update specific fields in script scenes
 *
 * This allows partial updates to scenes without replacing the entire script.
 * Only the provided fields will be updated; all other scene data is preserved.
 * Body: { scriptId, scenes: [{ scene_id, description?, tts_script?, visual_prompt?, image_prompt?, duration_seconds?, transition?, suggested_visual? }] }
 */
router.post('/scripts/update-scenes', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const { scriptId, scenes: updatedScenes } = req.body || {};

        if (!scriptId) {
            return res.status(400).json({ success: false, error: 'scriptId is required' });
        }

        if (!updatedScenes || !Array.isArray(updatedScenes)) {
            return res.status(400).json({ success: false, error: 'scenes array is required' });
        }

        // Get the script
        const script = db.getScriptReference(scriptId);
        if (!script) {
            return res.status(404).json({ success: false, error: 'Script not found' });
        }

        // Parse content
        let content: any;
        try {
            content = typeof script.content === 'string' ? JSON.parse(script.content) : script.content;
        } catch {
            return res.status(500).json({ success: false, error: 'Invalid script content' });
        }

        if (!content.scenes || !Array.isArray(content.scenes)) {
            return res.status(400).json({ success: false, error: 'Script has no scenes array' });
        }

        // Build scene lookup by scene_id
        const sceneMap = new Map<number, any>();
        content.scenes.forEach((scene: any) => {
            sceneMap.set(scene.scene_id, scene);
        });

        // Apply updates
        const allowedFields = [
            'scene_title',
            'description',
            'tts_script',
            'visual_prompt',
            'image_prompt',
            'duration_seconds',
            'transition',
            'suggested_visual',
            'characters',
        ];

        const updatedSceneIds: number[] = [];

        updatedScenes.forEach((update: any) => {
            const sceneId = update.scene_id;
            if (sceneId === undefined || sceneId === null) return;

            const scene = sceneMap.get(sceneId);
            if (!scene) return;

            // Only allow updating specific fields
            allowedFields.forEach(field => {
                if (update[field] !== undefined) {
                    scene[field] = update[field];
                }
            });

            updatedSceneIds.push(sceneId);
        });

        if (updatedSceneIds.length === 0) {
            return res.status(400).json({ success: false, error: 'No valid scenes to update' });
        }

        // Save updated script
        db.updateScriptReference(scriptId, {
            content: JSON.stringify(content),
        });

        res.json({
            success: true,
            data: {
                id: scriptId,
                updatedSceneIds,
                content,
            },
        });
    } catch (error: any) {
        logger.error('Error updating script scenes:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /scripts/update-characters - Update script with character descriptions injected into scene prompts
 * 
 * This takes a script and injects character descriptions into the scene prompts.
 * Example: "con m�o tr�o c�y" -> "con m�o (m�o den, m?t to) dang tr�o c�y"
 */
router.post('/scripts/update-characters', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const { scriptId, characters } = req.body || {};

        if (!scriptId) {
            return res.status(400).json({ success: false, error: 'scriptId is required' });
        }

        if (!characters || !Array.isArray(characters)) {
            return res.status(400).json({ success: false, error: 'characters array is required' });
        }

        // Get the script
        const script = db.getScriptReference(scriptId);
        if (!script) {
            return res.status(404).json({ success: false, error: 'Script not found' });
        }

        // Parse content
        let content: any;
        try {
            content = typeof script.content === 'string' ? JSON.parse(script.content) : script.content;
        } catch (parseError) {
            return res.status(500).json({ success: false, error: 'Invalid script content' });
        }

        // Build character lookup map (name -> description)
        const charDescriptions: Record<string, string> = {};
        characters.forEach((char: any) => {
            if (char.description) {
                charDescriptions[char.name] = char.description;
            }
        });

        // Update scenes: inject character descriptions into prompts
        if (content.scenes && Array.isArray(content.scenes)) {
            content.scenes.forEach((scene: any) => {
                // Update description
                if (scene.description) {
                    scene.description = injectCharacterDescriptions(scene.description, scene.characters || [], charDescriptions);
                }
                // Update visual_prompt / image_prompt
                if (scene.visual_prompt) {
                    scene.visual_prompt = injectCharacterDescriptions(scene.visual_prompt, scene.characters || [], charDescriptions);
                }
                if (scene.image_prompt) {
                    scene.image_prompt = injectCharacterDescriptions(scene.image_prompt, scene.characters || [], charDescriptions);
                }
                // Update tts_script
                if (scene.tts_script) {
                    scene.tts_script = injectCharacterDescriptions(scene.tts_script, scene.characters || [], charDescriptions);
                }
            });
        }

        // Update global characters array if exists
        if (content.characters && Array.isArray(content.characters)) {
            content.characters = content.characters.map((char: any) => {
                const desc = charDescriptions[char.name];
                if (desc) {
                    return { ...char, description: desc };
                }
                return char;
            });
        }

        // Save updated script
        db.updateScriptReference(scriptId, {
            content: JSON.stringify(content),
            metadata: JSON.stringify({
                ...JSON.parse(script.metadata || '{}'),
                updatedWithCharacters: new Date().toISOString(),
                characterDescriptions: charDescriptions
            })
        });

        res.json({
            success: true,
            data: {
                id: scriptId,
                content,
                updatedCharacters: charDescriptions
            }
        });
    } catch (error: any) {
        logger.error('Error updating script with characters:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * Helper function to inject character descriptions into text
 * Example: "con m�o tr�o c�y" with characters ["m�o"] and descriptions {"m�o": "m�o den, m?t to"}
 * Result: "con m�o (m�o den, m?t to) tr�o c�y"
 * Note: Only injects after the FIRST occurrence of each character name
 */
function injectCharacterDescriptions(text: string, sceneCharacters: string[], charDescriptions: Record<string, string>): string {
    if (!text || !sceneCharacters || sceneCharacters.length === 0) {
        return text;
    }

    let result = text;

    // Process each character in the scene
    sceneCharacters.forEach(charName => {
        const description = charDescriptions[charName];
        if (!description) return;

        // Only replace FIRST occurrence - use 'i' flag but NOT 'g'
        const escapedName = charName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(${escapedName})\\s*(\\([^)]*\\))?`, 'i');

        result = result.replace(pattern, (match, name, existingParens) => {
            if (existingParens) {
                // Already has description, update it
                return `${name} (${description})`;
            }
            // Add description after first occurrence only
            return `${name} (${description})`;
        });
    });

    return result;
}

/**
 * POST /scripts - Create a new script
 */
router.post('/scripts', (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const { projectId, profileId, content, metadata } = req.body || {};

        if (!projectId) {
            return res.status(400).json({ success: false, error: 'projectId is required' });
        }

        if (!content) {
            return res.status(400).json({ success: false, error: 'content is required' });
        }

        const id = `script_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const parsedContent = typeof content === 'object' ? content : JSON.parse(content as string);

        // Extract metadata fields
        const name = parsedContent?.title || metadata?.topic || metadata?.youtubeUrl || 'Untitled Script';
        const inputType = metadata?.inputType || metadata?.input_type || null;
        const topic = metadata?.topic || null;
        const storytellingMode = metadata?.storytellingMode || metadata?.storytelling_mode || 'auto';
        const durationText = metadata?.duration ? `${metadata.duration} ph�t` : '1 ph�t';
        const copyRatio = metadata?.copyRatio || metadata?.copy_ratio || 50;

        const scriptRecord = db.createScriptReference({
            id,
            projectId,
            profileId: profileId || null,
            name,
            version: 1,
            input_type: inputType,
            topic,
            storytelling_mode: storytellingMode,
            duration_text: durationText,
            copy_ratio: copyRatio,
            material_id: null,
            content: typeof parsedContent === 'object' ? JSON.stringify(parsedContent) : parsedContent,
            metadata: typeof metadata === 'object' ? JSON.stringify(metadata) : metadata,
        });

        res.json({
            success: true,
            data: {
                id: scriptRecord.id,
                projectId: scriptRecord.projectId,
                profileId: scriptRecord.profileId,
                content: parsedContent,
                metadata,
                createdAt: scriptRecord.createdAt,
            },
        });
    } catch (error: any) {
        logger.error('Error creating script:', error);
        res.status(500).json({ success: false, error: error.message });
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
            upscaleResolution = 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL',
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
        if (!(MATERIAL_STYLES as any)[materialId]) {
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

        // Validate upscale resolution
        const VALID_UPSCALE_RESOLUTIONS = [
            'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL',
            'UPSAMPLE_IMAGE_RESOLUTION_2K',
            'UPSAMPLE_IMAGE_RESOLUTION_4K'
        ];
        if (!VALID_UPSCALE_RESOLUTIONS.includes(upscaleResolution)) {
            return res.status(400).json({
                success: false,
                error: `Invalid upscaleResolution. Must be one of: ${VALID_UPSCALE_RESOLUTIONS.join(', ')}`,
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
        const flowClient = flowRegistry?.getOrCreate(profileId)!; // Non-null assertion since we check hasFlowKey() below

        let result: any = null;
        let usedBridge = false;

        if (bridge && bridge.isConnected()) {
            try {
                result = await bridge.generateImages({
                    projectId: targetProjectId,
                    sceneId: `entity-${Date.now()}`,
                    prompt,
                    aspectRatio,
                    userPaygateTier: tier,
                    modelKey: apiModelKey,
                });
                // Detect HTML 404 error page returned by the bridge (endpoint deprecated/unavailable)
                const resultStr = typeof result === 'string' ? result.trim() : '';
                if (resultStr.startsWith('<!DOCTYPE') || resultStr.startsWith('<html')) {
                    logger.warn('Extension bridge returned HTML 404 for image generation endpoint, falling back to FlowApiClient');
                    result = null;
                } else {
                    usedBridge = true;
                }
            } catch (bridgeError: any) {
                logger.warn('Extension bridge generate failed for %s: %s', profileId, bridgeError.message);
            }
        }

        if (!usedBridge) {
            if (!flowClient.hasFlowKey()) {
                return res.status(503).json({
                    success: false,
                    error: 'Flow client ch?a c? flowKey. Extension c?a profile n?y ch?a k?t n?i ho?c ch?a capture token.',
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
                error: 'API kh?ng tr? v? k?t qu? h?p l?. C? th? tier kh?ng ?? ho?c c?n ch? profile ready.',
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
                error: 'Kh?ng t?m th?y ?nh trong response. C? th? API tr? l?i 400 ho?c tier kh?ng ??.',
            });
        }

        // Upscale if requested (2K or 4K)
        let finalMediaId = mediaId;
        let finalServingUri = servingUri;
        let upscaledLocalPath = ''; // Track the upscaled file path

        if (upscaleResolution !== 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL' && mediaId) {
            try {
                // Use bridge's upscaleImage method
                if (bridge && bridge.isConnected()) {
                    logger.info(`Upscaling image ${mediaId} to ${upscaleResolution} via ExtensionBridge`);

                    const entitiesDir = path.join(process.cwd(), 'data', 'entity-references', profileId);
                    const ext = servingUri?.includes('.png') ? 'png' : 'jpg';
                    const upscaleSuffix = upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K' ? '_4k' : '_2k';
                    const upscalePath = path.join(entitiesDir, `${mediaId}${upscaleSuffix}.${ext}`);

                    // Call upscaleImage via bridge
                    const sessionRecord = db.getSessionByProfileId(profileId);
                    const tier = sessionRecord?.tier || (profile.tier as PaygateTier) || 'PAYGATE_TIER_TWO';
                    const upscaleResponse = await bridge.upscaleImage({
                        mediaId,
                        targetResolution: upscaleResolution,
                        projectId: targetProjectId,
                        userPaygateTier: tier,
                    });

                    logger.info(`[Image Upscale] Response: ${JSON.stringify(upscaleResponse)?.substring(0, 500)}`);

                    // Parse response - could be:
                    // 1. { json: { encodedImage: "base64..." } } (direct base64 response)
                    // 2. { json: { name: "operations/xxx", done: true, metadata: { image: { fifeUrl: "..." } } } }
                    const bridgeResponse = upscaleResponse?.json ?? upscaleResponse;
                    const encodedImage = bridgeResponse?.encodedImage;
                    const opName = bridgeResponse?.name;
                    const opDone = bridgeResponse?.done;
                    const opMetadata = bridgeResponse?.metadata || {};
                    const imageMeta = opMetadata.image || {};
                    const fifeUrl = imageMeta.fifeUrl;

                    if (encodedImage) {
                        // Direct base64 response
                        const upscaleSuffix = upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K' ? '_4k' : '_2k';
                        finalMediaId = mediaId + upscaleSuffix;

                        // Save base64 as image file
                        try {
                            if (!fs.existsSync(entitiesDir)) {
                                fs.mkdirSync(entitiesDir, { recursive: true });
                            }
                            const imageBuffer = Buffer.from(encodedImage, 'base64');
                            fs.writeFileSync(upscalePath, imageBuffer);
                            upscaledLocalPath = upscalePath;
                            logger.info(`Image upscaled (base64) and saved to: ${upscalePath} (${imageBuffer.length} bytes)`);
                        } catch (saveError) {
                            logger.warn(`Failed to save upscaled image: ${saveError}`);
                        }
                    } else if (opDone && fifeUrl) {
                        // Operation response with fifeUrl
                        const upscaledUrl = fifeUrl;
                        const upscaleSuffix = upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K' ? '_4k' : '_2k';
                        finalMediaId = mediaId + upscaleSuffix;
                        finalServingUri = upscaledUrl;

                        // Download the upscaled image
                        try {
                            if (!fs.existsSync(entitiesDir)) {
                                fs.mkdirSync(entitiesDir, { recursive: true });
                            }
                            const imageResponse = await fetch(upscaledUrl);
                            if (imageResponse.ok) {
                                const buffer = await imageResponse.arrayBuffer();
                                fs.writeFileSync(upscalePath, Buffer.from(buffer));
                                upscaledLocalPath = upscalePath;
                                logger.info(`Image upscaled and saved to: ${upscalePath}`);
                            }
                        } catch (downloadError) {
                            logger.warn(`Failed to download upscaled image: ${downloadError}`);
                        }
                    } else if (opName && !opDone) {
                        logger.info('Image upscale pending, polling...');
                    } else {
                        logger.warn('Image upscale response unexpected: %s', JSON.stringify(upscaleResponse)?.slice(0, 200));
                    }
                } else {
                    logger.warn('Bridge not connected, cannot upscale image');
                }
            } catch (upscaleError: any) {
                logger.warn(`Image upscale error: ${upscaleError.message}. Using original image.`);
            }
        }

        // Download image to local storage
        let localPath = upscaledLocalPath; // Use upscaled path if available
        if (!localPath && finalServingUri && finalMediaId) {
            try {
                const entitiesDir = path.join(process.cwd(), 'data', 'entity-references', profileId);
                if (!fs.existsSync(entitiesDir)) {
                    fs.mkdirSync(entitiesDir, { recursive: true });
                }
                const ext = finalServingUri.includes('.png') ? 'png' : 'jpg';
                localPath = path.join(entitiesDir, `${finalMediaId}.${ext}`);

                const imageResponse = await fetch(finalServingUri);
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
            imagePrompt: prompt.trim(), // Save the original prompt for future reference
            entityType,
            materialId,
            mediaId: finalMediaId || '',
            localPath,
            remoteUrl: finalServingUri || '',
            profileId,
            projectId: targetProjectId || '',
            aspectRatio,
            upscaleResolution,
            metadata: JSON.stringify({
                generatedAt: new Date().toISOString(),
                tier,
                modelKey: apiModelKey,
                upscaleResolution,
                originalMediaId: upscaleResolution !== 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL' ? mediaId : undefined,
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
 * POST /entities/:id/upscale - Upscale an existing entity image
 */
router.post('/entities/:id/upscale', async (req: Request, res: Response) => {
    try {
        const db = req.app.locals.db as DatabaseManager;
        const profileManager = new ProfileManager(db);
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;

        const { upscaleResolution } = req.body;
        const VALID_UPSCALE_RESOLUTIONS = [
            'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL',
            'UPSAMPLE_IMAGE_RESOLUTION_2K',
            'UPSAMPLE_IMAGE_RESOLUTION_4K'
        ];

        if (!upscaleResolution || !VALID_UPSCALE_RESOLUTIONS.includes(upscaleResolution)) {
            return res.status(400).json({
                success: false,
                error: 'Invalid upscaleResolution. Must be one of: ' + VALID_UPSCALE_RESOLUTIONS.join(', '),
            });
        }

        const entity = db.getEntityReference(req.params.id);
        if (!entity) {
            return res.status(404).json({
                success: false,
                error: 'Entity not found',
            });
        }

        if (upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL') {
            return res.json({
                success: true,
                data: entity,
                message: 'No upscale needed - using original',
            });
        }

        const profileId = entity.profileId;
        const profile = profileManager.getProfile(profileId);
        if (!profile) {
            return res.status(404).json({
                success: false,
                error: 'Profile not found for this entity',
            });
        }

        const bridge = extensionRegistry?.get(profileId);
        if (!bridge || !bridge.isConnected()) {
            return res.status(503).json({
                success: false,
                error: 'Browser not open for this profile. Please open the profile first.',
            });
        }

        // Extract mediaId from the entity's mediaId field
        const originalMediaId = entity.mediaId.replace(/_(2k|4k)$/i, '');

        logger.info(`[Upscale Entity] Upscaling entity ${req.params.id}: mediaId=${originalMediaId}, resolution=${upscaleResolution}`);

        // Get tier from database (not hardcoded)
        const sessionRecord = db.getSessionByProfileId(profileId);
        const tier = (sessionRecord?.tier as PaygateTier) || (profile.tier as PaygateTier) || 'PAYGATE_TIER_TWO';

        // Call upscaleImage via bridge
        const upscaleResponse = await bridge.upscaleImage({
            mediaId: originalMediaId,
            targetResolution: upscaleResolution,
            projectId: entity.projectId,
            userPaygateTier: tier,
        });

        logger.info(`[Upscale Entity] Response: ${JSON.stringify(upscaleResponse)?.substring(0, 500)}`);

        // Parse response - bridge wraps as { json: { ... } }
        const bridgeResponse = upscaleResponse?.json ?? upscaleResponse;
        const encodedImage = bridgeResponse?.encodedImage;
        const opName = bridgeResponse?.name;
        const opDone = bridgeResponse?.done;
        const opMetadata = bridgeResponse?.metadata || {};
        const imageMeta = opMetadata.image || {};
        const fifeUrl = imageMeta.fifeUrl;

        const entitiesDir = path.join(process.cwd(), 'data', 'entity-references', profileId);
        const ext = entity.localPath?.includes('.png') ? 'png' : 'jpg';
        const upscaleSuffix = upscaleResolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K' ? '_4k' : '_2k';
        const newMediaId = originalMediaId + upscaleSuffix;
        const upscalePath = path.join(entitiesDir, `${newMediaId}.${ext}`);

        let localPath = entity.localPath;
        let remoteUrl = entity.remoteUrl;

        if (encodedImage) {
            // Direct base64 response
            try {
                if (!fs.existsSync(entitiesDir)) {
                    fs.mkdirSync(entitiesDir, { recursive: true });
                }
                const imageBuffer = Buffer.from(encodedImage, 'base64');
                fs.writeFileSync(upscalePath, imageBuffer);
                localPath = upscalePath;
                logger.info(`Image upscaled (base64) and saved to: ${upscalePath} (${imageBuffer.length} bytes)`);
            } catch (saveError) {
                logger.warn(`Failed to save upscaled image: ${saveError}`);
            }
        } else if (opDone && fifeUrl) {
            // Operation response with fifeUrl
            remoteUrl = fifeUrl;

            // Download the upscaled image
            try {
                if (!fs.existsSync(entitiesDir)) {
                    fs.mkdirSync(entitiesDir, { recursive: true });
                }
                const imageResponse = await fetch(fifeUrl);
                if (imageResponse.ok) {
                    const buffer = await imageResponse.arrayBuffer();
                    fs.writeFileSync(upscalePath, Buffer.from(buffer));
                    localPath = upscalePath;
                    logger.info(`Image upscaled and saved to: ${upscalePath}`);
                }
            } catch (downloadError) {
                logger.warn(`Failed to download upscaled image: ${downloadError}`);
            }
        } else if (opName && !opDone) {
            // Pending - wait for completion (simplified: return as-is)
            logger.info('Image upscale pending...');
        } else {
            logger.warn('Image upscale response unexpected: %s', JSON.stringify(upscaleResponse)?.slice(0, 200));
        }

        // Update entity record
        db.updateEntityReference(req.params.id, {
            mediaId: newMediaId,
            localPath,
            remoteUrl,
            metadata: JSON.stringify({
                ...JSON.parse(entity.metadata || '{}'),
                upscaleResolution,
                originalMediaId,
                upscaledAt: new Date().toISOString(),
            }),
        });

        const updatedEntity = db.getEntityReference(req.params.id);

        res.json({
            success: true,
            data: updatedEntity,
            message: `Image upscaled to ${upscaleResolution.replace('UPSAMPLE_IMAGE_RESOLUTION_', '')}`,
        });
    } catch (error: any) {
        logger.error('Error upscaling entity:', error);
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

/**
 * POST /flow/videos/upload-image - Upload an image to use as start/end image for video generation
 * Body: { profileId, projectId, sceneId?, filePath?, fileName?, fileData? (base64) }
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
            fileData, // base64 encoded file data
        } = req.body || {};

        if (!profileId || typeof profileId !== 'string') {
            return res.status(400).json({ success: false, error: 'profileId is required' });
        }
        if (!projectId || typeof projectId !== 'string') {
            return res.status(400).json({ success: false, error: 'projectId is required' });
        }

        const profile = profileManager.getProfile(profileId);
        if (!profile) {
            return res.status(404).json({ success: false, error: 'Profile not found' });
        }

        // Create sceneId if not provided
        const uploadSceneId = sceneId || `upload-${Date.now()}`;

        // Handle file upload - either from path or base64 data
        let resolvedFilePath = filePath;

        if (!resolvedFilePath && fileData) {
            // Save base64 file to temp location
            const tempDir = path.join(process.cwd(), 'data', 'temp-uploads', profileId);
            if (!fs.existsSync(tempDir)) {
                fs.mkdirSync(tempDir, { recursive: true });
            }
            resolvedFilePath = path.join(tempDir, `${uploadSceneId}-${fileName || 'upload.png'}`);
            const buffer = Buffer.from(fileData, 'base64');
            fs.writeFileSync(resolvedFilePath, buffer);
            logger.info(`[Upload] Saved temp file to: ${resolvedFilePath}`);
        }

        if (!resolvedFilePath) {
            return res.status(400).json({ success: false, error: 'filePath or fileData is required' });
        }

        const bridge = extensionRegistry?.get(profileId);
        const flowClient = flowRegistry?.getOrCreate(profileId);

        let result: any = null;
        let usedBridge = false;

        if (bridge && bridge.isConnected()) {
            try {
                // Pass fileData directly - bridge can use it in browser context
                result = await bridge.uploadImage({
                    projectId,
                    sceneId: uploadSceneId,
                    fileName: fileName as string | undefined,
                    fileData, // Pass base64 data directly
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
                    error: 'Flow client chua c� flowKey. Extension c?a profile n�y chua k?t n?i ho?c chua capture token.',
                });
            }
            // For server-side fallback, read file and pass base64 directly
            // FlowApiClient.uploadImage expects: (imageBase64, mimeType, projectId, fileName)
            let imageBase64 = fileData;
            let mimeType = 'image/jpeg';

            if (!imageBase64 && resolvedFilePath && fs.existsSync(resolvedFilePath)) {
                const buffer = fs.readFileSync(resolvedFilePath);
                imageBase64 = buffer.toString('base64');
                // Detect mime type from extension
                const ext = resolvedFilePath.toLowerCase();
                if (ext.endsWith('.png')) mimeType = 'image/png';
                else if (ext.endsWith('.webp')) mimeType = 'image/webp';
            }

            result = await flowClient.uploadImage(
                imageBase64!,
                mimeType,
                projectId,
                fileName as string || 'upload.jpg'
            );
        }

        // Extract media ID from response
        // Python API returns: { media: { name: "uuid" } }
        // Extension/Bridge returns: { result: { status: 200, data: { media: { name: "uuid" } } } }
        const rawData = result?.result?.data || result?.data || result || {};
        const mediaId = result?.media?.name ||
            result?._mediaId ||
            result?.data?.media?.name ||
            rawData.media?.name ||
            null;

        // Cleanup temp file if it was created
        if (fileData && resolvedFilePath && fs.existsSync(resolvedFilePath)) {
            try {
                fs.unlinkSync(resolvedFilePath);
                logger.info(`[Upload] Cleaned up temp file: ${resolvedFilePath}`);
            } catch (e) {
                // ignore cleanup errors
            }
        }

        if (!mediaId) {
            logger.warn('[Upload] No mediaId in response:', JSON.stringify(result)?.slice(0, 500));
        } else {
            logger.info(`[Upload] Success - mediaId: ${mediaId}`);
        }

        res.json({
            success: true,
            data: {
                profileId,
                projectId,
                sceneId: uploadSceneId,
                mediaId,
                rawResult: result,
            },
            message: usedBridge ? 'Upload ?nh th�nh c�ng qua Extension' : 'Upload ?nh th�nh c�ng qua Flow API',
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
            model, // frontend model label: 'omni flash', 'veo 3.1 - fast', etc.
            aspectRatio,
            userPaygateTier,
            startImageMediaId,
            referenceMediaIds,
            endImageMediaId,
            modelKey,
            duration,
            referenceAudio,
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
        if (!mode || !['start_image', 'references', 'start_end'].includes(mode)) {
            return res.status(400).json({ success: false, error: 'mode must be start_image, references, or start_end' });
        }
        if (mode === 'references' && (!Array.isArray(referenceMediaIds) || referenceMediaIds.length === 0)) {
            return res.status(400).json({ success: false, error: 'referenceMediaIds is required for references mode' });
        }
        if (mode === 'start_end' && (!startImageMediaId || !endImageMediaId)) {
            return res.status(400).json({ success: false, error: 'startImageMediaId and endImageMediaId are required for start_end mode' });
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

        logger.info(`[Video Generate] Tier - userPaygateTier: ${userPaygateTier}, profile.tier: ${profile.tier}, resolvedTier: ${resolvedTier}`);

        const bridge = extensionRegistry?.get(profileId);
        const flowClient = flowRegistry?.getOrCreate(profileId);

        // Resolve model label to model key
        let resolvedModelKey = modelKey;
        if (model && !modelKey) {
            resolvedModelKey = resolveVideoModelKey(model, resolvedAspectRatio, resolvedTier, mode, duration);
            logger.info(`[Video Generate] Model: ${model} [${mode}] -> Key: ${resolvedModelKey}`);
        }

        let result: any = null;
        let usedBridge = false;

        if (bridge && bridge.isConnected()) {
            try {
                if (mode === 'start_end') {
                    result = await bridge.generateVideo({
                        startImageMediaId,
                        endImageMediaId,
                        prompt: prompt.trim(),
                        projectId,
                        sceneId,
                        aspectRatio: resolvedAspectRatio,
                        userPaygateTier: resolvedTier,
                        videoModelKey: resolvedModelKey,
                        referenceAudio,
                    });
                } else if (mode === 'start_image') {
                    result = await bridge.generateVideo({
                        startImageMediaId,
                        prompt: prompt.trim(),
                        projectId,
                        sceneId,
                        aspectRatio: resolvedAspectRatio,
                        endImageMediaId,
                        userPaygateTier: resolvedTier,
                        videoModelKey: resolvedModelKey,
                        referenceAudio,
                    });
                } else {
                    result = await bridge.generateVideoFromReferences({
                        referenceMediaIds,
                        prompt: prompt.trim(),
                        projectId,
                        sceneId,
                        aspectRatio: resolvedAspectRatio,
                        userPaygateTier: resolvedTier,
                        videoModelKey: resolvedModelKey,
                        referenceAudio,
                    });
                }
                usedBridge = true;
            } catch (bridgeError: any) {
                logger.warn(`[Video Generate] Bridge failed after retries: ${bridgeError.message}. Falling back to FlowApiClient.`);
            }
        }

        if (!usedBridge) {
            if (!flowClient || !flowClient.hasFlowKey()) {
                return res.status(503).json({
                    success: false,
                    error: 'Flow client ch?a c? flowKey. Extension c?a profile n?y ch?a k?t n?i ho?c ch?a capture token.',
                });
            }
            if (mode === 'start_end') {
                result = await flowClient.generateVideo({
                    startImageMediaId,
                    endImageMediaId,
                    prompt: prompt.trim(),
                    projectId,
                    sceneId,
                    aspectRatio: resolvedAspectRatio,
                    userPaygateTier: resolvedTier,
                    videoModelKey: resolvedModelKey,
                    referenceAudio,
                });
            } else if (mode === 'start_image') {
                result = await flowClient.generateVideo({
                    startImageMediaId,
                    prompt: prompt.trim(),
                    projectId,
                    sceneId,
                    aspectRatio: resolvedAspectRatio,
                    endImageMediaId,
                    userPaygateTier: resolvedTier,
                    videoModelKey: resolvedModelKey,
                    referenceAudio,
                });
            } else {
                result = await flowClient.generateVideoFromReferences({
                    referenceMediaIds,
                    prompt: prompt.trim(),
                    projectId,
                    sceneId,
                    aspectRatio: resolvedAspectRatio,
                    userPaygateTier: resolvedTier,
                    videoModelKey: resolvedModelKey,
                    referenceAudio,
                });
            }
        }

        // Extract workflows/operations t? API response
        // API v3.1 tr? v?: { workflows: [{ name: "workflow-id", metadata: { primaryMediaId: "media-id" } }] }
        // Extension tr? v?: { status, data: { workflows: [...] } }
        // Bridge wraps it as: { result: { status, data: { workflows: [...] } } }
        const rawData = result?.result?.data || result?.data || result || {};
        const workflows = rawData.workflows || [];
        const operations = rawData.operations || rawData.data?.operations || workflows;

        // Log detailed structure for debugging
        logger.info(`[Video Generate] rawData keys: ${Object.keys(rawData).join(', ')}`);
        logger.info(`[Video Generate] workflows[0]: ${JSON.stringify(workflows[0] || 'empty')}`);
        logger.info(`[Video Generate] operations[0]: ${JSON.stringify(operations[0] || 'empty')}`);

        // Extract request IDs - c� th? l� workflow name ho?c operation name
        const requestIds = (Array.isArray(operations) ? operations : [])
            .map((op: any) => op?.name || op?.id || op?.mediaId || op)
            .filter((id: any) => typeof id === 'string' && id);

        // Extract media IDs t? workflows metadata
        const mediaIds = (Array.isArray(workflows) ? workflows : [])
            .map((wf: any) => wf?.metadata?.primaryMediaId || wf?.primaryMediaId || wf?.mediaId)
            .filter((id: any) => typeof id === 'string' && id);

        // Log only metadata, not full payloads
        logger.info(`[Video Generate] Result - workflows: ${workflows.length}, operations: ${operations.length}, requestIds: ${requestIds.length}, mediaIds: ${mediaIds.length}`);
        if (mediaIds.length > 0) {
            logger.info(`[Video Generate] mediaIds[0]: ${mediaIds[0]}`);
        } else {
            logger.info(`[Video Generate] WARNING: No mediaIds extracted! rawData.workflows[0]: ${JSON.stringify(workflows[0] || 'empty').substring(0, 300)}`);
        }

        // Check for errors in response
        const responseError = rawData.error || rawData.errorInfo || rawData.status === 'error' ? rawData : null;
        if (responseError) {
            const errorMsg = responseError.error?.message || responseError.errorInfo?.message || JSON.stringify(responseError.error || responseError);
            logger.error(`[Video Generate] API error: ${errorMsg}`);
        }

        res.json({
            success: true,
            data: {
                profileId,
                projectId,
                sceneId,
                mode,
                model,
                modelKey: resolvedModelKey,
                aspectRatio: resolvedAspectRatio,
                userPaygateTier: resolvedTier,
                operations,
                workflows,
                requestIds,
                mediaIds,
                rawResult: result,
            },
            message: usedBridge ? 'T?o video th�nh c�ng qua Extension' : 'T?o video th�nh c�ng qua Flow API',
        });
    } catch (error: any) {
        logger.error('Error generating Flow video:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /flow/videos/upscale - Upscale an existing generated video.
 * Body: { profileId, projectId, sceneId, mediaId, aspectRatio?, resolution? }
 * Video upscale is ALWAYS async - returns operations for frontend polling
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

        // Get tier from database (not hardcoded)
        const sessionRecord = db.getSessionByProfileId(profileId);
        const tier = (sessionRecord?.tier as PaygateTier) || (profile.tier as PaygateTier) || 'PAYGATE_TIER_TWO';

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
                    projectId,
                    userPaygateTier: tier,
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
                    error: 'Flow client chua c� flowKey. Extension c?a profile n�y chua k?t n?i ho?c chua capture token.',
                });
            }
            result = await flowClient.upscaleVideo({
                mediaId,
                sceneId,
                aspectRatio: resolvedAspectRatio,
                resolution: resolvedResolution,
            });
        }

        // Extract operations and media from async response for polling
        // Bridge wraps response as { data: { json: { operations: [...] } } } or { data: { operations: [...] } }
        const bridgeResult = result?.data ?? result;
        const bridgeJson = bridgeResult?.json ?? bridgeResult;

        // Debug: log full response structure
        logger.info(`[Video Upscale] Raw bridge response keys: ${Object.keys(bridgeResult || {}).join(', ')}`);
        logger.info(`[Video Upscale] Raw bridgeJson keys: ${Object.keys(bridgeJson || {}).join(', ')}`);
        logger.info(`[Video Upscale] Raw response sample: ${JSON.stringify(bridgeJson)?.substring(0, 500)}`);

        const operations: string[] = [];
        const mediaIds: string[] = [];

        // CRITICAL: Upscale creates a NEW media ID with "_upsampled" suffix
        // We need to construct this and poll status for it
        const upsampledMediaId = `${mediaId}_upsampled`;
        logger.info(`[Video Upscale] Original mediaId=${mediaId} -> upsampledMediaId=${upsampledMediaId}`);

        // Add the upsampled media ID to the list for polling
        mediaIds.push(upsampledMediaId);

        // Check for workflows (like Python implementation)
        const workflows = bridgeJson?.workflows || bridgeResult?.workflows || [];
        if (Array.isArray(workflows) && workflows.length > 0) {
            logger.info(`[Video Upscale] Found workflows array with ${workflows.length} items`);
            for (const wf of workflows) {
                if (wf?.name) {
                    mediaIds.push(wf.name);
                }
            }
        }

        // Also check operations format
        if (bridgeJson?.operations && Array.isArray(bridgeJson.operations)) {
            for (const op of bridgeJson.operations) {
                // Old format: { operation: { name: "..." } }
                if (op?.operation?.name) {
                    operations.push(op.operation.name);
                }
                // New format: { name: "..." }
                if (op?.name) {
                    // Don't overwrite upsampledMediaId, but add if different
                    if (!op.name.includes('_upsampled')) {
                        mediaIds.push(op.name);
                    }
                }
            }
        }

        if (bridgeJson?.media && Array.isArray(bridgeJson.media)) {
            for (const item of bridgeJson.media) {
                if (item?.name) {
                    // Don't overwrite upsampledMediaId, but add if different
                    if (!item.name.includes('_upsampled')) {
                        mediaIds.push(item.name);
                    }
                }
            }
        }

        // Frontend uses requestIds for polling (same as operations)
        const requestIds = operations;

        logger.info(`[Video Upscale] Final: upsampledMediaId=${upsampledMediaId}, requestIds=${requestIds.length} mediaIds=${mediaIds.length} usedBridge=${usedBridge}`);

        res.json({
            success: true,
            data: {
                profileId,
                projectId,
                sceneId,
                mediaId,
                upsampledMediaId, // The new media ID for polling
                aspectRatio: resolvedAspectRatio,
                resolution: resolvedResolution,
                operations,
                requestIds, // For frontend polling compatibility
                mediaIds,
                rawResult: result,
            },
            message: usedBridge
                ? 'Video upscale started via Extension (polling...)'
                : 'Video upscale started via Flow API (polling...)',
        });
    } catch (error: any) {
        logger.error('Error upscaling Flow video:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /flow/videos/file - Serve a saved video file
 * Query: ?mediaId=xxx
 */
router.get('/flow/videos/file', async (req: Request, res: Response) => {
    try {
        const { mediaId } = req.query as { mediaId?: string };

        if (!mediaId) {
            return res.status(400).json({ success: false, error: 'mediaId is required' });
        }

        const filepath = path.join(process.cwd(), 'data', 'videos', `${mediaId}.mp4`);

        if (!fs.existsSync(filepath)) {
            return res.status(404).json({ success: false, error: 'Video file not found' });
        }

        logger.info(`[Video File] Serving: ${filepath}`);
        return res.sendFile(filepath);
    } catch (error: any) {
        logger.error('Error serving video file:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /flow/videos/download - Download video by mediaId
 * Query: ?profileId=xxx&mediaId=xxx
 */
router.get('/flow/videos/download', async (req: Request, res: Response) => {
    try {
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;

        const { profileId, mediaId } = req.query as { profileId?: string; mediaId?: string };

        if (!profileId || !mediaId) {
            return res.status(400).json({ success: false, error: 'profileId and mediaId required' });
        }

        const bridge = extensionRegistry?.get(profileId as string);
        if (!bridge || !bridge.isConnected()) {
            return res.status(503).json({ success: false, error: 'Extension not connected' });
        }

        // === CALL GET /v1/media/{mediaId}?clientContext.tool=PINHOLE ===
        // This is the EXACT same pattern as checkVideoStatus (api_request)
        // - the extension fetches in the browser context using its own cookies.
        const response = await bridge.getMedia(mediaId as string);

        if (response?.error) {
            return res.status(500).json({ success: false, error: response.error });
        }

        // Extract encodedVideo (base64) from response
        // Handle both unwrapped and wrapped response formats
        const rawResponse = response?.data || response || {};
        const data = typeof rawResponse === 'object' ? rawResponse : {};
        const videoObj = data.video || {};
        const encodedVideo = videoObj.encodedVideo;
        const fifeUrl = videoObj.fifeUrl || videoObj.servingBaseUri;

        if (encodedVideo) {
            // === Save base64 to MP4 file in data/videos/ (skip if already exists) ===
            try {
                const videosDir = path.join(process.cwd(), 'data', 'videos');
                if (!fs.existsSync(videosDir)) {
                    fs.mkdirSync(videosDir, { recursive: true });
                }
                const filename = `${mediaId}.mp4`;
                const filepath = path.join(videosDir, filename);
                if (fs.existsSync(filepath)) {
                    // already saved, skip
                } else {
                    const videoBytes = Buffer.from(encodedVideo, 'base64');
                    fs.writeFileSync(filepath, videoBytes);
                    const sizeMB = (videoBytes.length / 1024 / 1024).toFixed(2);
                    logger.info(`[Video Download] Saved MP4 (${sizeMB} MB) -> ${filename}`);
                }
            } catch (saveErr: any) {
                logger.error(`[Video Download] Failed to save MP4 file: ${saveErr.message}`);
            }

            // Return base64 video data
            return res.json({
                success: true,
                data: {
                    mediaId,
                    format: 'base64',
                    encodedVideo,
                    mimeType: 'video/mp4',
                    savedPath: path.join(process.cwd(), 'data', 'videos', `${mediaId}.mp4`),
                },
            });
        } else if (fifeUrl) {
            // Return signed URL
            return res.json({
                success: true,
                data: {
                    mediaId,
                    format: 'url',
                    videoUrl: fifeUrl,
                },
            });
        } else {
            // Check if file was already saved previously
            const videosDir = path.join(process.cwd(), 'data', 'videos');
            const existingPath = path.join(videosDir, `${mediaId}.mp4`);
            if (fs.existsSync(existingPath)) {
                return res.json({
                    success: true,
                    data: {
                        mediaId,
                        format: 'saved',
                        alreadySaved: true,
                        savedPath: existingPath,
                    },
                });
            }
        }

        return res.status(404).json({
            success: false,
            error: 'Video not ready or not found',
            data,
        });
    } catch (error: any) {
        logger.error('Error downloading video:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /flow/videos/status - Check status of video generation operations
 * Body: { profileId, operations?: string[], mediaIds?: string[] }
 */
router.post('/flow/videos/status', async (req: Request, res: Response) => {
    try {
        const extensionRegistry = req.app.locals.extensionRegistry as ExtensionBridgeRegistry | undefined;
        const flowRegistry = (req.app.locals as any).flowRegistry as FlowApiRegistry | undefined;

        const {
            profileId,
            projectId,
            operations = [],
            mediaIds = [],
        } = req.body || {};

        if (!profileId || typeof profileId !== 'string') {
            return res.status(400).json({ success: false, error: 'profileId is required' });
        }
        if (!Array.isArray(operations) || !Array.isArray(mediaIds) ||
            operations.length === 0 && mediaIds.length === 0) {
            return res.status(400).json({ success: false, error: 'operations or mediaIds array is required' });
        }

        const bridge = extensionRegistry?.get(profileId);
        const flowClient = flowRegistry?.getOrCreate(profileId);

        let result: any = null;
        let usedBridge = false;
        let cachedResult = false;

        // === SHORT-CIRCUIT: If every requested mediaId is already known to be SUCCESSFUL,
        // skip batchCheckAsyncVideoGenerationStatus entirely. ===
        const allMediaIds = mediaIds || [];
        const cachedItems: any[] = [];
        const uncachedMediaIds: string[] = [];
        for (const mid of allMediaIds) {
            const cacheKey = `${profileId}:${mid}`;
            const cached = successfulMediaCache.get(cacheKey);
            if (cached && Date.now() - cached.ts < SUCCESS_CACHE_TTL_MS) {
                cachedItems.push(cached.mediaItem);
            } else {
                uncachedMediaIds.push(mid);
            }
        }
        if (allMediaIds.length > 0 && cachedItems.length === allMediaIds.length) {
            logger.info(`[Video Status] All ${allMediaIds.length} mediaIds already SUCCESSFUL (cached) - skipping batchCheck`);
            // Ensure the result has the correct structure for parsing
            result = {
                media: cachedItems,
                operations: [], // No operations when using cache
                data: { media: cachedItems } // Also set data for compatibility
            };
            usedBridge = true;
            cachedResult = true;
        }

        if (!cachedResult && bridge && bridge.isConnected()) {
            try {
                // Pass operations, mediaIds, and projectId to bridge
                // (only the uncached ones)
                result = await bridge.checkVideoStatus({
                    operations: operations.length > 0 ? operations : undefined,
                    mediaIds: uncachedMediaIds.length > 0 ? uncachedMediaIds : (mediaIds.length > 0 ? mediaIds : undefined),
                    projectId: projectId,
                });
                usedBridge = true;
            } catch (bridgeError: any) {
                logger.warn('Extension bridge checkVideoStatus failed for %s, falling back: %s', profileId, bridgeError.message);
            }
        }

        if (!usedBridge) {
            if (!flowClient || !flowClient.hasFlowKey()) {
                return res.status(503).json({
                    success: false,
                    error: 'Flow client chua c� flowKey. Extension c?a profile n�y chua k?t n?i ho?c chua capture token.',
                });
            }
            result = await flowClient.checkVideoStatus(operations);
        }

        // Parse status response
        const rawMedia = result?.media || result?.data?.media || [];
        const rawOps = result?.operations || result?.data?.operations || [];

        // Extract video URLs and status from media items
        // Format: media[].mediaMetadata.mediaStatus.mediaGenerationStatus
        //         media[].video.generatedVideo.fifeUrl
        const completedVideos = [];
        let hasActiveMedia = false;
        let hasSuccessfulMedia = false;
        let hasFailedMedia = false;

        for (const item of rawMedia) {
            if (!item) continue;

            // Check status - nested under mediaMetadata.mediaStatus.mediaGenerationStatus
            const mediaMetadata = item?.mediaMetadata;
            const mediaStatus = mediaMetadata?.mediaStatus;
            const statusStr = mediaStatus?.mediaGenerationStatus || item?.status || '';

            // Also check video status
            const videoStatus = item?.video?.status;
            const videoError = item?.video?.error || item?.error || mediaMetadata?.error;

            // Check if still processing
            if (statusStr === 'MEDIA_GENERATION_STATUS_ACTIVE' ||
                statusStr === 'MEDIA_GENERATION_STATUS_PENDING' ||
                videoStatus === 'MEDIA_GENERATION_STATUS_ACTIVE' ||
                videoStatus === 'MEDIA_GENERATION_STATUS_PENDING') {
                hasActiveMedia = true;
            }

            // Check if FAILED
            const isFailed = statusStr === 'MEDIA_GENERATION_STATUS_FAILED' ||
                videoStatus === 'MEDIA_GENERATION_STATUS_FAILED' ||
                videoError ||
                item.status === 'FAILED';
            if (isFailed) {
                hasFailedMedia = true;
                logger.warn(`[Video Status] Media ${item.name} FAILED:`, { statusStr, videoStatus, videoError });
            }

            // Check if SUCCESSFUL - video is ready to download
            if (statusStr === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
                hasSuccessfulMedia = true;
                // Mark this mediaId as SUCCESSFUL in cache so subsequent polls
                // skip batchCheckAsyncVideoGenerationStatus.
                if (item.name) {
                    const cacheKey = `${profileId}:${item.name}`;
                    successfulMediaCache.set(cacheKey, {
                        profileId,
                        projectId: projectId || '',
                        mediaItem: item,
                        ts: Date.now(),
                    });
                }
            }

            // Extract video URL from generatedVideo.fifeUrl
            const generatedVideo = item?.video?.generatedVideo || {};
            const videoObj = item?.video || {};

            // Try different URL locations
            const fifeUrl = generatedVideo?.fifeUrl || videoObj?.fifeUrl;
            const servingBaseUri = videoObj?.servingBaseUri;

            // If SUCCESSFUL or has URL, mark as completed
            if (statusStr === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' || fifeUrl) {
                completedVideos.push({
                    mediaId: item.name || item.mediaId,
                    videoUrl: fifeUrl || null, // null means need to download
                    status: statusStr,
                    isReady: statusStr === 'MEDIA_GENERATION_STATUS_SUCCESSFUL',
                    thumbnailUrl: generatedVideo?.poster?.fifeUrl || servingBaseUri || null,
                    metadata: mediaMetadata,
                    rawVideoData: generatedVideo,
                });
            }
        }

        // Also check operations format
        for (const item of rawOps) {
            if (!item) continue;
            const videoData = item.video || item.metadata?.video || {};
            const generatedVideo = videoData.generatedVideo || {};
            const fifeUrl = generatedVideo.fifeUrl || videoData.fifeUrl;
            if (fifeUrl || item.status === 'SUCCESSFUL') {
                completedVideos.push({
                    mediaId: item.name || item.mediaId,
                    videoUrl: fifeUrl || null,
                    status: item.status || 'COMPLETED',
                    isReady: item.status === 'SUCCESSFUL',
                });
            }
        }

        // isComplete = has successful/ready videos and no active processing
        // Also complete if all media has failed
        const isComplete = ((completedVideos.length > 0 || hasSuccessfulMedia || hasFailedMedia) && !hasActiveMedia) || hasFailedMedia;

        // === AUTO-PROBE: When isComplete is true, immediately call GET /v1/media/{mediaId}
        // EXACT same pattern as checkVideoStatus - extension fetches via
        // api_request using browser cookies (no Bearer header). ===
        let autoDownloadResult: any = null;
        if (isComplete && completedVideos.length > 0) {
            try {
                const firstVideo = completedVideos[0] as any;
                const probeMediaId = firstVideo.mediaId;
                if (bridge && bridge.isConnected() && probeMediaId) {
                    // === SKIP probe if MP4 already saved locally ===
                    const existingPath = path.join(process.cwd(), 'data', 'videos', `${probeMediaId}.mp4`);
                    if (fs.existsSync(existingPath)) {
                        const stat = fs.statSync(existingPath);
                        logger.info(`[Video Status] MP4 already saved: ${existingPath} (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
                        autoDownloadResult = {
                            mediaId: probeMediaId,
                            success: true,
                            savedPath: existingPath,
                            alreadySaved: true,
                        };
                    } else {
                        logger.info(`[Video Status] AUTO-PROBE: GET /v1/media/${probeMediaId}`);
                        const probeResp = await bridge.getMedia(probeMediaId);
                        const rawData = probeResp?.data || probeResp || {};
                        const videoObj = rawData.video || {};

                        // NOTE: Don't include encodedVideo in autoDownloadResult to avoid PayloadTooLargeError
                        // The frontend will download via /api/flow/videos/download endpoint
                        autoDownloadResult = {
                            mediaId: probeMediaId,
                            success: !!videoObj.encodedVideo || !!(videoObj.fifeUrl || videoObj.servingBaseUri),
                            hasEncodedVideo: !!videoObj.encodedVideo,
                            encodedVideoLength: videoObj.encodedVideo?.length || 0,
                            hasFifeUrl: !!(videoObj.fifeUrl || videoObj.servingBaseUri),
                            message: 'Use /api/flow/videos/download to get video data',
                        };

                        // === AUTO-SAVE: If encodedVideo present, save to data/videos/ ===
                        if (videoObj.encodedVideo) {
                            try {
                                const videosDir = path.join(process.cwd(), 'data', 'videos');
                                if (!fs.existsSync(videosDir)) {
                                    fs.mkdirSync(videosDir, { recursive: true });
                                }
                                const filepath = path.join(videosDir, `${probeMediaId}.mp4`);
                                const videoBytes = Buffer.from(videoObj.encodedVideo, 'base64');
                                fs.writeFileSync(filepath, videoBytes);
                                const sizeMB = (videoBytes.length / 1024 / 1024).toFixed(2);
                                logger.info(`[Video Status] AUTO-PROBE: Saved MP4 (${sizeMB} MB)`);
                                if (autoDownloadResult) autoDownloadResult.savedPath = filepath;
                            } catch (saveErr: any) {
                                logger.error(`[Video Status] AUTO-PROBE save failed: ${saveErr.message}`);
                            }
                        }
                    } // close else (no existingPath)
                }
            } catch (probeErr: any) {
                logger.error(`[Video Status] AUTO-PROBE error: ${probeErr.message}`);
            }
        }

        // === CRITICAL: Don't include rawMedia in response if it contains large video data ===
        // This causes PayloadTooLargeError when batchCheckAsyncVideoGenerationStatus returns
        // media items with encodedVideo base64 data. Only include completedVideos. ===
        const responseMedia = (rawMedia as any[]).map((item: any) => {
            // Clone and strip large data
            const { encodedVideo, ...cleanItem } = item || {};
            return cleanItem;
        });

        res.json({
            success: true,
            data: {
                profileId,
                projectId,
                operations: rawOps,
                mediaIds,
                // Don't include raw response status object (may contain large data)
                media: responseMedia,
                completedVideos,
                isComplete,
                hasActiveMedia,
                hasSuccessfulMedia,
                hasFailedMedia,
                autoDownloadResult,
                shouldStopPolling: isComplete,
                stopReason: hasFailedMedia ? 'Video generation FAILED' : (isComplete ? 'Video generation completed' : null),
            },
            message: usedBridge ? 'Ki?m tra tr?ng th�i qua Extension' : 'Ki?m tra tr?ng th�i qua Flow API',
        });
        logger.info(`[Video Status] RESPONSE: success=true, isComplete=${isComplete}, hasSuccessfulMedia=${hasSuccessfulMedia}, hasFailedMedia=${hasFailedMedia}, completedVideos=${completedVideos.length}, shouldStopPolling=${isComplete}`);
    } catch (error: any) {
        logger.error('Error checking Flow video status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// =============================================================================
// GEMINI SETTINGS API
// =============================================================================

import { loadGeminiSettings, saveGeminiSettings, GeminiSettings } from './geminiSettings';

router.get('/gemini-settings', (_req, res) => {
    const settings = loadGeminiSettings();
    res.json({ success: true, data: settings });
});

router.post('/gemini-settings', (req, res) => {
    const { apiKeys, model } = req.body as Partial<GeminiSettings>;
    const saved = saveGeminiSettings({
        apiKeys: typeof apiKeys === 'string' ? apiKeys : undefined,
        model: typeof model === 'string' ? model : undefined,
    });
    res.json({ success: true, data: saved });
});

// =============================================================================
// SCRIPT GENERATION - Gemini API
// =============================================================================

async function importGenai() {
    try {
        const genai = await import('@google/genai');
        return genai;
    } catch (e) { return null; }
}

function parseLLMJsonOutput(rawText: string): any {
    if (!rawText) return null;
    let s = String(rawText).trim();
    if (s.startsWith('\ufeff')) s = s.slice(1).trim();
    try { return JSON.parse(s); } catch { /* next */ }
    const m = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (m) { try { return JSON.parse(m[1].trim()); } catch { /* next */ } }
    for (const ch of ['{', '[']) {
        const pos = s.indexOf(ch);
        if (pos >= 0) { try { return JSON.parse(s.slice(pos)); } catch { /* continue */ } }
    }
    return null;
}

function isGeminiOverload(errMsg?: string): boolean {
    if (!errMsg) return false;
    const s = errMsg.toLowerCase();
    return ['503', 'unavailable', 'high demand', 'temporarily', 'try again', 'service unavailable', 'overload', 'rate limit', '429', 'resou'].some(n => s.includes(n));
}

router.post('/scripts/generate', async (req: Request, res: Response) => {
    const pickEntityForCharacter = (name: string): any | null => {
        const q = String(name).trim().toLowerCase();
        if (!q) return null;
        const entities = (req.app.locals as any)?.entityRegistry || {};
        const candidates = Object.values(entities).filter((e: any) => {
            const ename = String(e?.name || '').toLowerCase();
            const edesc = String(e?.description || '').toLowerCase();
            return ename.includes(q) || edesc.includes(q);
        });
        return candidates[0] || null;
    };

    const loadEntityBlocksForCharacters = async (names: string[]): Promise<string[]> => {
        const blocks: string[] = [];
        for (const name of names) {
            const entity = pickEntityForCharacter(name);
            if (!entity) continue;
            const parts: string[] = [];
            if (entity?.reference_image_url || entity?.image_prompt) {
                parts.push(`Character: ${name.toUpperCase()}`);
                parts.push(`Reference Image provided.`);
                if (entity.image_prompt) parts.push(`Appearance: ${entity.image_prompt}`);
                parts.push(`Rules: Never redesign ${name}. Keep identical face, hairstyle, clothing, colors, and proportions.`);
            }
            if (parts.length) blocks.push(parts.join('\n'));
        }
        return blocks;
    };

    const injectEntityRules = (base: string, characters: string[], entityBlocks: string[]): string => {
        if (!base || !entityBlocks.length) return '';
        const lines = [
            'CHARACTER CONSISTENCY RULES',
            'Use the provided reference appearances EXACTLY.',
            ...entityBlocks,
            '',
            'Rules:',
            'Never redesign characters.',
            'Keep identical face.',
            'Keep identical hairstyle.',
            'Keep identical clothing.',
            'Keep identical colors.',
            'Preserve body proportions.',
            'Maintain consistency across all scenes.',
            '',
            'Scene:',
        ];
        return lines.join('\n');
    };
    const {
        profileId,
        projectId,
        input_type,
        youtube_url,
        topic,
        upload_files,
        language = 'vi',
        duration_text = '60',
        copy_ratio = 90,
        additional_description = '',
        gemini_model,
        gemini_api_keys,
        temperature = 0.7,
        no_voice = false,
        no_music = false,
        material_id,
        storytelling_mode,
    } = req.body;

    // === Load prompt config ===
    const scriptConfig = JSON.parse(fs.readFileSync(path.join(__dirname, 'script_prompts.json'), 'utf-8'));

    // Duration: ph�t -> gi�y
    const durationMinutes = Number(req.body.duration_minutes ?? 10);
    const durationSeconds = Math.round(durationMinutes * 60);
    // Scene count: m?i c?nh ~8s, t?i thi?u 1 c?nh
    const sceneCount = Math.max(1, Math.ceil(durationSeconds / 8));

    const durationLabel = durationSeconds >= 3600
        ? `${durationSeconds / 3600} gi? (${Math.round(durationSeconds / 60)} ph�t)`
        : `${durationMinutes} ph�t`;

    const allowedStorytellingModes = new Set(['auto', 'narration', 'dialogue', 'mixed']);
    const resolvedStorytellingMode = allowedStorytellingModes.has(String(storytelling_mode || '').toLowerCase())
        ? String(storytelling_mode).toLowerCase()
        : 'auto';

    // === Multi-key rotation ===
    const ALLOWED_GEMINI_MODELS = [
        'models/gemini-3.5-flash',
        'models/gemini-3-flash-preview',
        'models/gemini-3.1-flash-lite-preview',
        'models/gemini-2.5-flash',
        'models/gemini-2.5-flash-lite',
    ];
    const MODEL_ALIASES: Record<string, string> = {
        'gemini-3.5-flash': 'models/gemini-3.5-flash',
        'gemini-3-flash-preview': 'models/gemini-3-flash-preview',
        'gemini-3.1-flash-lite': 'models/gemini-3.1-flash-lite-preview',
        'gemini-3.1-flash-lite-preview': 'models/gemini-3.1-flash-lite-preview',
        'gemini-2.5-flash': 'models/gemini-2.5-flash',
        'gemini-2.5-flash-lite': 'models/gemini-2.5-flash-lite',
    };
    const DEFAULT_MODEL = 'models/gemini-2.5-flash';

    function splitKeyString(raw: string): string[] {
        const parts = raw.split(/[\n;,]+/).map((p: string) => p.trim()).filter(Boolean);
        const seen = new Set<string>();
        return parts.filter((k: string) => {
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
    }

    function normalizeModel(raw?: string): string {
        const s = (raw || '').trim();
        if (ALLOWED_GEMINI_MODELS.includes(s)) return s;
        if (s in MODEL_ALIASES) return MODEL_ALIASES[s];
        if (!s.startsWith('models/') && s) {
            const prefixed = `models/${s}`;
            if (ALLOWED_GEMINI_MODELS.includes(prefixed)) return prefixed;
        }
        return DEFAULT_MODEL;
    }

    function getGeminiApiKeys(): string[] {
        // Priority: request body > persistent settings > env
        if (gemini_api_keys?.trim()) return splitKeyString(gemini_api_keys);
        const saved = loadGeminiSettings();
        if (saved.apiKeys?.trim()) return splitKeyString(saved.apiKeys);
        const envMulti = process.env.GEMINI_API_KEYS;
        if (envMulti?.trim()) return splitKeyString(envMulti);
        const envSingle = process.env.GEMINI_API_KEY;
        if (envSingle?.trim()) return splitKeyString(envSingle);
        return [];
    }

    function getGeminiModel(): string {
        if (gemini_model?.trim()) return normalizeModel(gemini_model);
        const saved = loadGeminiSettings();
        if (saved.model?.trim()) return normalizeModel(saved.model);
        return DEFAULT_MODEL;
    }

    if (!input_type || !['youtube_url', 'topic', 'upload_files'].includes(input_type)) {
        return res.status(400).json({ success: false, error: 'Thi?u ho?c sai input_type' });
    }

    const langMap: Record<string, string> = {
        vi: 'Vietnamese', en: 'English', fr: 'French', de: 'German', ru: 'Russian',
        ja: 'Japanese', ko: 'Korean', zh: 'Chinese', hi: 'Hindi', it: 'Italian',
        es: 'Spanish', pt: 'Portuguese',
    };
    const targetLang = langMap[language] || 'Vietnamese';

    // Optional modifiers
    const voiceNote = no_voice
        ? '\nQUAN TR?NG: KHONG CO THO?I. T?t c? c�c c?nh ph?i HOAN TOAN IM L?NG. Kh�ng vi?t b?t k? dialogue, narration, hay l?i tho?i n�o. tts_script ph?i l� chu?i r?ng "".'
        : '';
    const musicNote = no_music
        ? '\nAM THANH: Kh�ng c� nh?c n?n. Ch? gi? �m thanh t? nhi�n t? c?nh quay (ti?ng bu?c ch�n, ti?ng nu?c, ti?ng gi�...) ph� h?p v?i h�nh d?ng tr�n m�n h�nh.'
        : '';

    // Build system instruction t? JSON config
    const systemInstruction = scriptConfig.system_instruction
        .replace('{DURATION_LABEL}', durationLabel)
        .replace('{SCENE_COUNT}', String(sceneCount))
        .replace('{TARGET_LANG}', targetLang)
        .replace('{STORYTELLING_MODE}', resolvedStorytellingMode)
        + voiceNote
        + musicNote;

    // Build user prompt t? JSON config
    const tpl = scriptConfig.prompts[input_type] || scriptConfig.prompts.topic;
    let userPrompt = tpl
        .replace('{TARGET_LANG}', targetLang)
        .replace('{COPY_RATIO}', String(copy_ratio))
        .replace('{CREATIVE_RATIO}', String(100 - Number(copy_ratio)))
        .replace('{DURATION_LABEL}', durationLabel)
        .replace('{SCENE_COUNT}', String(sceneCount))
        .replace('{STORYTELLING_MODE}', resolvedStorytellingMode)
        .replace('{ADDITIONAL_DESC}', additional_description ? `M� t? th�m: ${additional_description}\n` : '')
        .replace('{NO_VOICE_FLAG}', no_voice ? 'KHONG CO THO?I. T?t c? c�c c?nh ho�n to�n im l?ng.' : '')
        .replace('{NO_MUSIC_FLAG}', no_music ? 'Kh�ng c� nh?c n?n. Ch? gi? �m thanh t? nhi�n t? c?nh quay.' : '')
        .replace('{TOPIC}', topic || '');

    try {
        const genaiModule = await importGenai();
        if (!genaiModule) {
            return res.status(500).json({ success: false, error: 'Chua c�i d?t @google/genai. Ch?y: npm install @google/genai' });
        }
        const { GoogleGenAI, HarmCategory, HarmBlockThreshold, Type } = genaiModule;

        const allKeys = getGeminiApiKeys();
        if (allKeys.length === 0) {
            return res.status(500).json({ success: false, error: 'GEMINI_API_KEY chua du?c c�i d?t. Vui l�ng nh?p API key ? panel b�n tr�i ho?c set GEMINI_API_KEY trong .env' });
        }

        // Safety settings - block nothing
        const safetySettings = [
            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_NONE },
            { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_NONE },
        ];

        // Language
        const langMap: Record<string, string> = {
            vi: 'Vietnamese', en: 'English', fr: 'French', de: 'German', ru: 'Russian',
            ja: 'Japanese', ko: 'Korean', zh: 'Chinese', hi: 'Hindi', it: 'Italian',
            es: 'Spanish', pt: 'Portuguese',
        };
        const targetLang = langMap[language] || 'Vietnamese';

        // Build user prompt content
        const langHint = `TARGET LANGUAGE FOR TTS/AUDIO: ${targetLang}\n`;
        userPrompt = langHint + userPrompt;

        // Build model queue
        const MODEL_ORDER = [
            'gemini-2.5-flash',
            'gemini-3.5-flash',
            'gemini-3-flash-preview',
            'gemini-3.1-flash-lite-preview',
            'gemini-2.5-flash-lite',
        ];
        const userModel = getGeminiModel().replace('models/', '');
        const modelQueue: string[] = [userModel, ...MODEL_ORDER.filter(m => m !== userModel)];

        // Nested retry: model first  then key
        let lastError = 'Chua th?';
        outerLoop:
        for (const modelName of modelQueue) {
            const modelId = modelName.startsWith('models/') ? modelName : `models/${modelName}`;
            for (const apiKey of allKeys) {
                const ai = new GoogleGenAI({ apiKey });
                logger.info(`[Script Generate] Trying model=${modelId}, key=${apiKey.slice(0, 12)}...`);
                try {
                    const resp = await ai.models.generateContent({
                        model: modelId,
                        contents: [{ text: userPrompt }],
                        config: {
                            systemInstruction,
                            temperature: Number(temperature),
                            responseMimeType: 'application/json',
                            safetySettings,
                        },
                    });
                    const rawText = resp.text;
                    if (!rawText?.trim()) { lastError = 'Gemini tr? v? response r?ng'; break; }
                    logger.info(`[Script Generate] Raw response (${rawText.length} chars): ${rawText.slice(0, 500)}`);
                    const data = parseLLMJsonOutput(rawText.trim());
                    if (!data) { lastError = `Gemini kh�ng tr? JSON d�ng format. Raw: ${rawText.slice(0, 200)}`; break; }
                    if (!data.scenes?.length) { lastError = `Gemini tr? JSON thi?u scenes. Keys: ${Object.keys(data).join(', ')}`; break; }

                    const characterNames = Array.isArray(data.characters)
                        ? data.characters.map((c: any) => String(c.name || '').trim()).filter(Boolean)
                        : [];
                    const entityBlocks = await loadEntityBlocksForCharacters(characterNames);
                    const resolvedStyle = resolveMaterialStyle(material_id, req);
                    const result = {
                        title: data.title || topic || 'Untitled Script',
                        topic: data.topic || topic || '',
                        total_scenes: data.total_scenes || data.scenes.length,
                        storytelling_mode: resolvedStorytellingMode,
                        characters: Array.isArray(data.characters) ? data.characters : [],
                        scenes: data.scenes.map((s: any, i: number) => {
                            const sceneCharacters = Array.isArray(s.characters)
                                ? s.characters.map((name: string) => String(name).trim()).filter(Boolean)
                                : [];
                            const baseVisual = (s.visual_prompt || '').trim();
                            const injectedVisual = injectEntityRules(baseVisual, sceneCharacters, entityBlocks);
                            let visual_prompt = injectedVisual || baseVisual;
                            if (resolvedStyle) {
                                const styleInstruction = resolvedStyle.instruction.trim();
                                const stylePrefix = resolvedStyle.prefix.trim();
                                const negativePrompt = resolvedStyle.negative_prompt.trim();
                                if (stylePrefix && !visual_prompt.toLowerCase().startsWith(stylePrefix.toLowerCase())) {
                                    visual_prompt = visual_prompt
                                        ? `${stylePrefix}${stylePrefix.endsWith('.') ? ' ' : ', '}${visual_prompt}`
                                        : stylePrefix;
                                } else if (!visual_prompt && stylePrefix) {
                                    visual_prompt = stylePrefix;
                                }
                                if (styleInstruction) {
                                    visual_prompt = `${visual_prompt}${visual_prompt ? ' ' : ''}${styleInstruction}`;
                                }
                                if (negativePrompt) {
                                    visual_prompt = `${visual_prompt}${visual_prompt ? ' ' : ''}${negativePrompt}`;
                                }
                            }
                            return {
                                scene_id: s.scene_id ?? (i + 1),
                                scene_title: s.scene_title || `C?nh ${i + 1}`,
                                characters: sceneCharacters,
                                visual_prompt: visual_prompt || 'Cinematic scene, high production value.',
                                material_id: material_id || undefined,
                                tts_script: s.tts_script || '',
                                transition: s.transition,
                                duration_seconds: 8,
                            };
                        }),
                    };

                    // Save script to database
                    try {
                        const db = req.app.locals.db as DatabaseManager;
                        const scriptId = `script_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
                        const scriptName = data.title || topic || 'Untitled Script';
                        const projectIdToUse = projectId || null;
                        const nextVersion = projectIdToUse ? db.getNextScriptVersion(projectIdToUse, profileId) : 1;

                        db.createScriptReference({
                            id: scriptId,
                            projectId: projectIdToUse,
                            profileId,
                            name: scriptName,
                            version: nextVersion,
                            input_type: input_type || null,
                            topic: topic || null,
                            storytelling_mode: resolvedStorytellingMode,
                            duration_text: duration_text || '60',
                            copy_ratio: Number(copy_ratio) || 90,
                            material_id: material_id || null,
                            content: JSON.stringify(result),
                            metadata: '{}',
                        });

                        (result as any).script_id = scriptId;
                        (result as any).script_version = nextVersion;
                        logger.info(`[Script Generate] Saved script "${scriptName}" v${nextVersion} (id: ${scriptId})`);
                    } catch (saveErr) {
                        logger.error('[Script Generate] Failed to save script:', saveErr);
                    }

                    return res.json({ success: true, data: result });
                } catch (callErr: any) {
                    lastError = callErr.message || String(callErr);
                    if (!isGeminiOverload(lastError)) {
                        break outerLoop;
                    }
                    // Overload  th? model ti?p theo, KHONG retry c�ng model/key
                    logger.info(`[Script Generate] Overload: model=${modelName} key=${apiKey.slice(0, 12)}  skip to next model`);
                    break;
                }
            }
        }

        if (isGeminiOverload(lastError)) {
            return res.status(503).json({ success: false, error: 'Gemini dang qu� t?i, vui l�ng th? l?i sau v�i ph�t.' });
        }
        return res.status(500).json({ success: false, error: lastError });
    } catch (err: any) {
        logger.error('[Script Generate] Error:', err);
        res.status(500).json({ success: false, error: err.message || 'L?i khi sinh k?ch b?n' });
    }
});

export default router;


