import express, { Request, Response } from 'express';
import { ProfileManager } from '../profile-manager/ProfileManager';
import { CreateProfileRequest, OpenProfileRequest, ApiResponse, PaygateTier } from '../types';
import logger from '../utils/logger';
import { DatabaseManager } from '../database/Database';
import { BrowserManager } from '../browser-manager/BrowserManager';
import { ExtensionBridgeRegistry } from '../flow-api/ExtensionBridgeRegistry';
import { FlowApiRegistry } from '../flow-api/FlowApiRegistry';
import { v4 as uuidv4 } from 'uuid';

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

            const projectId = result?.data?.json?.projectId || result?.projectId || null;

            if (projectId) {
                try {
                    const existing = profileManager.getProfile(profileId);
                    const metadata = { ...(existing?.metadata || {}) };
                    const existingProjects = Array.isArray(metadata.flowProjects) ? metadata.flowProjects : [];
                    const filtered = existingProjects.filter((p: any) => p.projectId !== projectId);
                    filtered.push({
                        projectId,
                        name: projectName,
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

            return {
                ...profile,
                isActive: browserManager.isActive(profile.id),
                tier,
                proxy,
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

export default router;
