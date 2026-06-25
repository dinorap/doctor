import express from 'express';
import cors from 'cors';
import path from 'path';
import http from 'http';
import routes from './api/routes';
import { initPipelineRoutes } from './api/pipelineRoutes';
import { initFinalizeRoutes } from './api/finalizeRoutes';
import logger from './utils/logger';
import CONFIG from './config';
import { BrowserManager } from './browser-manager/BrowserManager';
import { DatabaseManager } from './database/Database';
import { PipelineManager } from './pipeline/PipelineManager';
import { ExtensionBridgeRegistry } from './flow-api/ExtensionBridgeRegistry';
import { FlowApiRegistry } from './flow-api/FlowApiRegistry';

const app = express();
const server = http.createServer(app);

// Initialize database
const db = new DatabaseManager(CONFIG.paths.database);
const pipelineManager = new PipelineManager(db);

// Initialize browser manager with database
const browserManager = new BrowserManager(db);

// Per-profile registries. Each profileId gets its own ExtensionBridge and
// FlowApiClient — no more shared state between profiles.
const extensionRegistry = new ExtensionBridgeRegistry();
const flowRegistry = new FlowApiRegistry({
    wsUrl: CONFIG.flow?.wsUrl || 'wss://flow.googleapis.com',
    defaultFlowKey: CONFIG.flow?.apiKey || undefined,
    timeoutMs: 10000,
});

// Debounce map to prevent rapid-fire getCredits calls per profile
const getCreditsDebounce = new Map<string, number>();
const GET_CREDITS_COOLDOWN_MS = 2000;

// WebSocket for real-time updates (frontend events)
const WebSocket = require('ws');
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws: any) => {
    logger.info('WebSocket client connected');

    ws.on('close', () => {
        logger.info('WebSocket client disconnected');
    });
});

// Broadcast to all WebSocket clients
function broadcast(event: string, data: any) {
    const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
    wss.clients.forEach((client: any) => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// Forward per-profile extension status changes to all dashboard clients
extensionRegistry.onStatus((status) => {
    broadcast('extension-status', status);
});

// Extension WebSocket server (mirrors production agent behavior)
const _CALLBACK_SECRET = 'chromium-profile-manager-ext-secret';
const extWss = new WebSocket.Server({ port: CONFIG.extension?.wsPort || 9222 });

extWss.on('connection', (ws: any) => {
    logger.info('Extension WebSocket client connected');
    let boundProfileId: string | null = null;
    // Tracks whether we've already logged the bind side-effects for this
    // (ws, profileId) pair. Without this, every extension_ready +
    // token_captured pair would log "Bound ws" twice even though nothing
    // actually changed.
    let bindLogged = false;

    // Handshake: send callback secret immediately after connect
    try {
        ws.send(JSON.stringify({ type: 'callback_secret', secret: _CALLBACK_SECRET }));
    } catch {
        // ignore send errors on closed sockets
    }

    ws.on('message', async (raw: any) => {
        try {
            const data = JSON.parse(String(raw));
            await handleExtensionMessage(ws, data, (pid) => {
                if (boundProfileId && boundProfileId !== pid) {
                    extensionRegistry.unbindWebSocket(boundProfileId, ws);
                    bindLogged = false;
                }
                boundProfileId = pid;
            }, () => bindLogged, (v: boolean) => { bindLogged = v; });
        } catch (error) {
            logger.warn('Failed to parse extension message: %s', error);
        }
    });

    ws.on('close', () => {
        logger.info('Extension WebSocket client disconnected (profileId=%s)', boundProfileId);
        if (boundProfileId) {
            extensionRegistry.unbindWebSocket(boundProfileId, ws);
        }
        boundProfileId = null;
        bindLogged = false;
    });
});

async function handleExtensionMessage(
    ws: any,
    data: any,
    setBound: (pid: string) => void,
    getBindLogged: () => boolean,
    setBindLogged: (v: boolean) => void,
) {
    const type = data?.type;
    const messageProfileId = typeof data?.profileId === 'string' ? data.profileId : null;

    // First message without a profileId → we cannot route it. The
    // extension defers its own extension_ready until it has a profileId,
    // so this branch is rare (only if someone restarts the WS server
    // mid-handshake). Silently drop — the next packet will have it.
    if (type === 'extension_ready' && !messageProfileId) {
        return;
    }

    if (type === 'token_captured') {
        if (!messageProfileId) {
            logger.warn('token_captured received without profileId');
            return;
        }
        const flowKey = data?.flowKey;
        if (!flowKey || typeof flowKey !== 'string') {
            logger.warn('token_captured received without flowKey for profile %s', messageProfileId);
            return;
        }

        setBound(messageProfileId);
        const isFirstBind = !getBindLogged();
        extensionRegistry.bindWebSocket(messageProfileId, ws);
        setBindLogged(true);
        flowRegistry.setFlowKey(messageProfileId, flowKey);

        if (isFirstBind) {
            logger.info('Flow API key injected for profile %s', messageProfileId);
        } else {
            logger.info('Flow API key refreshed for profile %s', messageProfileId);
        }

        // Update cached status on the bridge (no-op if values unchanged,
        // because updateStatus() short-circuits identical values)
        const bridge = extensionRegistry.get(messageProfileId);
        if (bridge) {
            bridge.updateStatus({ flowKeyPresent: true });
        }
        broadcast('tier-updated', { profileId: messageProfileId, source: 'token_captured' });

        // The user just signed into Flow (or refreshed their session) and
        // the extension pushed us a fresh token. We have to actively fetch
        // `/credits` through the extension bridge to learn their tier — the
        // extension only sends `credits_update` in response to *its own*
        // API calls, not our `getCredits` request. Kick this off once per
        // new-token event so the dashboard tier flips to Pro/Ultra instead
        // of staying on Unknown.
        // Debounce to prevent rapid-fire calls when extension sends multiple token_captured messages.
        const now = Date.now();
        const lastCall = getCreditsDebounce.get(messageProfileId) || 0;
        if (bridge && bridge.isConnected() && (now - lastCall) > GET_CREDITS_COOLDOWN_MS) {
            getCreditsDebounce.set(messageProfileId, now);
            bridge.getCredits()
                .then((creditsData) => {
                    const rawTier = creditsData?.userPaygateTier;
                    if (rawTier === 'PAYGATE_TIER_ONE' || rawTier === 'PAYGATE_TIER_TWO') {
                        bridge.updateStatus({ tier: rawTier });
                        const tierRecord = db.getSessionByProfileId(messageProfileId);
                        if (tierRecord) {
                            db.updateSession(tierRecord.id, { tier: rawTier });
                        }
                        broadcast('tier-updated', {
                            profileId: messageProfileId,
                            tier: rawTier,
                            source: 'auto_detect_after_login',
                        });
                        logger.info('Auto-detected tier for profile %s after token capture: %s', messageProfileId, rawTier);
                    }
                })
                .catch((err) => {
                    // Expected when the user has not actually signed in yet.
                    // The dashboard will keep showing "Unknown" until they do.
                    logger.info('Auto tier detect after token capture deferred for profile %s: %s', messageProfileId, err instanceof Error ? err.message : err);
                });
        }
        return;
    }

    if (type === 'extension_ready') {
        setBound(messageProfileId!);
        const isFirstBind = !getBindLogged();
        extensionRegistry.bindWebSocket(messageProfileId!, ws);
        setBindLogged(true);
        const bridge = extensionRegistry.get(messageProfileId!);
        if (bridge) {
            bridge.updateStatus({
                flowKeyPresent: !!data?.flowKeyPresent,
                tokenAge: typeof data?.tokenAge === 'number' ? data.tokenAge : null,
            });
        }
        if (isFirstBind) {
            logger.info('Extension ready for profile %s (flowKeyPresent=%s)', messageProfileId!, !!data?.flowKeyPresent);
        }
        return;
    }

    if (type === 'ping') {
        try {
            ws.send(JSON.stringify({ type: 'pong' }));
        } catch {
            // ignore
        }
        return;
    }

    if (type === 'credits_update') {
        if (!messageProfileId) return;
        const bridge = extensionRegistry.get(messageProfileId);
        if (bridge) {
            // Only accept a recognized tier; keep the current bridge tier
            // (which may itself be UNKNOWN) for anything else. Without
            // this guard, an extension pushing partial data could regress
            // a real tier to a stale one.
            const rawTier = data?.userPaygateTier;
            const acceptedTier = (rawTier === 'PAYGATE_TIER_ONE' || rawTier === 'PAYGATE_TIER_TWO')
                ? rawTier
                : bridge.getStatus().tier;
            bridge.updateStatus({
                credits: typeof data?.credits === 'number' ? data.credits : bridge.getStatus().credits,
                tier: acceptedTier ?? undefined,
            });
            const tier = bridge.getStatus().tier ?? 'UNKNOWN';
            // Persist to DB (including UNKNOWN — the previous `if (tier)`
            // guard would silently skip persisting the explicit UNKNOWN
            // and the dashboard would keep showing the stale value).
            const tierRecord = db.getSessionByProfileId(messageProfileId);
            if (tierRecord) {
                db.updateSession(tierRecord.id, { tier });
            }
            broadcast('tier-updated', {
                profileId: messageProfileId,
                tier,
                source: 'extension_credits_update',
                credits: bridge.getStatus().credits,
            });
        }
        return;
    }

    if (type === 'media_urls_refresh') {
        if (!messageProfileId) return;
        // Forward to dashboard for live media list updates
        broadcast('media-urls-refresh', {
            profileId: messageProfileId,
            urls: data?.urls || [],
        });
        return;
    }

    // Response from extension for a previous request — must include profileId
    if (data?.id) {
        const targetPid = messageProfileId;
        if (!targetPid) {
            logger.warn('Extension response received without profileId (id=%s)', data.id);
            return;
        }
        const bridge = extensionRegistry.get(targetPid);
        if (bridge) {
            bridge.handleMessage(data);
        } else {
            logger.warn('Extension response for unknown profileId=%s', targetPid);
        }
    }
}

// Listen for browser close events — drop the per-profile bridges so we
// don't leak state when a profile's browser is closed.
browserManager.onBrowserClosed((profileId) => {
    logger.info(`🔔 Broadcasting browser closed event for: ${profileId}`);
    broadcast('browser-closed', { profileId });
    broadcast('extension-status', {
        profileId,
        connected: false,
        flowKeyPresent: false,
        state: 'off',
        tokenAge: null,
        lastError: null,
        tier: null,
        credits: null,
        updatedAt: Date.now(),
    });

    // Refresh profile status after a short delay
    setTimeout(() => {
        broadcast('profiles-updated', {});
    }, 500);
});

// Make db and browserManager + registries available to routes
app.locals.db = db;
app.locals.browserManager = browserManager;
app.locals.extensionRegistry = extensionRegistry;
app.locals.flowRegistry = flowRegistry;
app.locals.broadcast = broadcast;

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// Request logging
app.use((req, _res, next) => {
    logger.info(`${req.method} ${req.path}`);
    next();
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public'), {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
}));

// Serve entity reference images from data/entity-references
app.use('/data/entity-references', express.static(path.join(__dirname, '../data/entity-references'), {
    setHeaders: (res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    }
}));

// API routes
app.use('/api', routes);
app.use('/api/pipelines', require('./api/pipelineRoutes').default);
app.use('/api/pipelines', require('./api/finalizeRoutes').default);

// Initialize pipeline routes with database and flow registry
initPipelineRoutes(db, flowRegistry);
initFinalizeRoutes(db, pipelineManager);

// Error handling middleware
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled error:', err);
    res.status(500).json({
        success: false,
        error: err.message || 'Internal server error',
    });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    logger.info('SIGINT received. Shutting down gracefully...');
    await browserManager.closeAll();
    db.close();
    wss.close();
    extWss.close();
    server.close();
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('SIGTERM received. Shutting down gracefully...');
    await browserManager.closeAll();
    db.close();
    wss.close();
    extWss.close();
    server.close();
    process.exit(0);
});

// Start server
const PORT = CONFIG.server.port;
const HOST = CONFIG.server.host;

server.listen(PORT, () => {
    logger.info(`
╔═══════════════════════════════════════════════════════════╗
║  Chromium Profile Manager Server                          ║
║  Server running at: http://${HOST}:${PORT}                ║
║  WebSocket: ws://${HOST}:${PORT}                          ║
║  Extension WS: ws://${HOST}:${CONFIG.extension?.wsPort || 9222}║
║  Extension Callback: http://${HOST}:${PORT}/api/ext/callback║
║  API Endpoints:                                           ║
║    GET  /api/health                                       ║
║    GET  /api/profiles                                     ║
║    POST /api/profiles/create                              ║
║    POST /api/profiles/open                                ║
║    POST /api/profiles/:id/close                           ║
    ║    DELETE /api/profiles/:id                               ║
║    GET  /api/cloakbrowser/status                          ║
║    POST /api/flow/projects/create                         ║
║    POST /api/flow/projects/create-batch                   ║
║    POST /api/flow/images/generate                         ║
║    POST /api/ext/callback                                ║
║    GET  /api/pipelines                                    ║
║    POST /api/pipelines                                    ║
║    GET  /api/pipelines/:id/status                         ║
║    POST /api/pipelines/:id/start                         ║
║    POST /api/pipelines/:id/pause                         ║
║    POST /api/pipelines/:id/stop                           ║
║  Events (WebSocket):                                      ║
║    browser-closed, profiles-updated                        ║
║    extension-status, tier-updated, media-urls-refresh      ║
╚═══════════════════════════════════════════════════════════╝
    `);
});

export default app;
