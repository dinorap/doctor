import { EventEmitter } from 'events';
import logger from '../utils/logger';

export interface ExtensionRequest {
    resolve: (value: any) => void;
    reject: (reason?: any) => void;
    timer: ReturnType<typeof setTimeout>;
}

export interface ExtensionStatus {
    profileId: string;
    connected: boolean;
    flowKeyPresent: boolean;
    state: 'off' | 'idle' | 'running' | 'unknown';
    tokenAge: number | null;
    lastError: string | null;
    tier: 'PAYGATE_TIER_ONE' | 'PAYGATE_TIER_TWO' | null;
    credits: number | null;
    updatedAt: number;
}

/**
 * Per-profile extension bridge. Holds the websocket, pending requests and
 * cached status for ONE Chromium profile. Never shared across profiles.
 *
 * Use ExtensionBridgeRegistry.get(profileId) to obtain an instance.
 */
export class ExtensionBridge extends EventEmitter {
    private profileId: string;
    private ws: any | null = null;
    private pending = new Map<string, ExtensionRequest>();
    private timeoutMs: number;
    private onMessage: ((data: any) => void) | null = null;
    private status: ExtensionStatus;

    constructor(profileId: string, timeoutMs = 90000) {
        super();
        this.profileId = profileId;
        this.timeoutMs = timeoutMs;
        this.status = {
            profileId,
            connected: false,
            flowKeyPresent: false,
            state: 'unknown',
            tokenAge: null,
            lastError: null,
            tier: null,
            credits: null,
            updatedAt: Date.now(),
        };
    }

    public getProfileId(): string {
        return this.profileId;
    }

    public setWebSocket(ws: any | null): void {
        if (this.ws === ws) {
            return;
        }

        // Detach old socket handlers so it can't keep pushing events into us
        if (this.ws) {
            try {
                this.ws.onmessage = null;
                this.ws.onclose = null;
                this.ws.onerror = null;
            } catch {
                // ignore
            }
        }

        this.ws = ws;
        this.updateStatus({ connected: !!ws && ws.readyState === 1 });

        if (ws) {
            const handleClose = () => {
                if (this.ws === ws) {
                    this.ws = null;
                    this.updateStatus({ connected: false, state: 'off' });
                }
            };
            try {
                ws.onclose = handleClose;
            } catch {
                // ignore
            }
        }
    }

    public getWebSocket(): any | null {
        return this.ws;
    }

    public setOnMessageHandler(handler: (data: any) => void): void {
        this.onMessage = handler;
    }

    public isConnected(): boolean {
        return this.ws !== null && this.ws.readyState === 1; // WebSocket.OPEN
    }

    public getStatus(): ExtensionStatus {
        return { ...this.status, updatedAt: Date.now() };
    }

    public updateStatus(patch: Partial<ExtensionStatus>): void {
        const before = this.status;
        const next: ExtensionStatus = {
            ...before,
            ...patch,
            profileId: this.profileId,
            updatedAt: Date.now(),
        };
        this.status = next;

        const changed =
            before.connected !== next.connected ||
            before.flowKeyPresent !== next.flowKeyPresent ||
            before.state !== next.state ||
            before.tier !== next.tier ||
            before.credits !== next.credits ||
            before.tokenAge !== next.tokenAge ||
            before.lastError !== next.lastError;

        if (changed) {
            this.emit('status', next);
        }
    }

    public handleMessage(data: any): void {
        // Cache status from extension status pushes (real-time)
        if (data?.type === 'status' || data?.method === 'get_status') {
            const result = data?.result ?? data;
            this.updateStatus({
                state: result?.state ?? this.status.state,
                flowKeyPresent: typeof result?.flowKeyPresent === 'boolean'
                    ? result.flowKeyPresent
                    : this.status.flowKeyPresent,
                tokenAge: typeof result?.tokenAge === 'number' ? result.tokenAge : this.status.tokenAge,
            });
        }

        if (data?.type === 'credits_update') {
            const credits = data?.credits;
            const tier = data?.userPaygateTier;
            // Only accept a recognized tier; keep current value otherwise.
            const acceptedTier = (tier === 'PAYGATE_TIER_ONE' || tier === 'PAYGATE_TIER_TWO')
                ? tier
                : this.status.tier;
            if (typeof credits === 'number' || tier) {
                this.updateStatus({
                    credits: typeof credits === 'number' ? credits : this.status.credits,
                    tier: acceptedTier,
                });
            }
        }

        if (this.onMessage) {
            this.onMessage(data);
            return;
        }

        const requestId = data?.id ?? data?.requestId;
        if (!requestId) {
            return;
        }

        const entry = this.pending.get(requestId);
        if (!entry) {
            return;
        }

        clearTimeout(entry.timer);
        this.pending.delete(requestId);

        if (data.error) {
            entry.reject(new Error(data.error));
            return;
        }

        entry.resolve(data.result ?? data);
    }

    public async sendRequest<T>(method: string, params: Record<string, any> = {}): Promise<T> {
        if (!this.isConnected()) {
            const err = new Error(
                `Extension chưa kết nối cho profile ${this.profileId}. Vui lòng mở browser của profile này.`,
            );
            logger.error('[ExtensionBridge] sendRequest failed: %s', err.message);
            throw err;
        }

        const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

        logger.info('[ExtensionBridge] sendRequest %s id=%s params=%j', method, requestId, params);

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                logger.error('[ExtensionBridge] Request %s timed out after %dms', requestId, this.timeoutMs);
                reject(new Error(`Flow request ${method} timed out`));
            }, this.timeoutMs);

            this.pending.set(requestId, {
                resolve: (value: any) => {
                    logger.info('[ExtensionBridge] Request %s resolved', requestId);
                    resolve(value as T);
                },
                reject: (reason?: any) => {
                    logger.error('[ExtensionBridge] Request %s rejected: %s', requestId, reason);
                    reject(reason);
                },
                timer,
            });

            const payload = JSON.stringify({
                id: requestId,
                method,
                params,
            });

            try {
                this.ws!.send(payload);
                logger.info('[ExtensionBridge] Payload sent for %s', requestId);
            } catch (error) {
                clearTimeout(timer);
                this.pending.delete(requestId);
                logger.error('[ExtensionBridge] Failed to send request: %s', error);
                reject(new Error(`Failed to send request to extension: ${error}`));
            }
        });
    }

    public createProject(projectTitle: string, toolName = 'PINHOLE'): Promise<any> {
        return this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/project.createProject',
            method: 'POST',
            body: {
                json: {
                    projectTitle,
                    toolName,
                },
            },
        });
    }

    public async getCredits(): Promise<any> {
        const response: any = await this.sendRequest('api_request', {
            url: 'https://aisandbox-pa.googleapis.com/v1/credits',
            method: 'GET',
        });

        // Extension returns: { status, data: { credits, userPaygateTier, ... } }
        // or: { data: { json: { credits, userPaygateTier, ... } } }
        let normalized: any = response;
        if (response?.data?.json) {
            normalized = response.data.json;
        } else if (response?.data?.userPaygateTier) {
            normalized = response.data;
        }

        // If the response contains an unrecognized tier value, strip it
        // out of the returned payload so callers never see a fake tier.
        if (normalized && typeof normalized === 'object' && normalized.userPaygateTier !== undefined) {
            if (normalized.userPaygateTier !== 'PAYGATE_TIER_ONE' && normalized.userPaygateTier !== 'PAYGATE_TIER_TWO') {
                const { userPaygateTier: _drop, ...rest } = normalized;
                normalized = rest;
            }
        }

        if (normalized && typeof normalized === 'object') {
            // Only accept a recognized tier; keep current value otherwise.
            const rawTier = normalized.userPaygateTier;
            const acceptedTier = (rawTier === 'PAYGATE_TIER_ONE' || rawTier === 'PAYGATE_TIER_TWO')
                ? rawTier
                : this.status.tier;
            this.updateStatus({
                credits: typeof normalized.credits === 'number' ? normalized.credits : this.status.credits,
                tier: acceptedTier,
                flowKeyPresent: true,
            });
        }

        return normalized;
    }

    public async generateImages(params: {
        projectId: string;
        prompt?: string;
        aspectRatio?: string;
        userPaygateTier?: string;
        modelKey?: string;
        characterMediaIds?: string[];
    }): Promise<any> {
        const seed = Math.floor(Math.random() * 294967296);
        const requests = [
            {
                clientContext: {
                    recaptchaContext: {
                        token: '',
                        applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                    },
                    sessionId: '',
                    projectId: params.projectId,
                    tool: 'PINHOLE',
                },
                imageAspectRatio: params.aspectRatio || 'IMAGE_ASPECT_RATIO_LANDSCAPE',
                seed,
                imageModelName: params.modelKey || 'GEM_PIX_2',
                prompt: params.prompt || '',
                imageInputs: [],
            },
        ];

        if (params.characterMediaIds && params.characterMediaIds.length) {
            requests[0].imageInputs = params.characterMediaIds.map((id) => ({
                imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE',
                name: id,
            }));
        }

        const body = {
            clientContext: {
                recaptchaContext: {
                    token: '',
                    applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                },
                sessionId: '',
                projectId: params.projectId,
                tool: 'PINHOLE',
            },
            mediaGenerationContext: {
                batchId: crypto.randomUUID(),
            },
            useNewMedia: true,
            requests,
        };

        logger.info('[Entity Gen] Request body: %s', JSON.stringify(body));

        const response: any = await this.sendRequest('api_request', {
            url: 'https://aisandbox-pa.googleapis.com/v1/projects/' + params.projectId + '/flowMedia:batchGenerateImages',
            method: 'POST',
            body,
            captchaAction: 'IMAGE_GENERATION',
        });

        if (response?.error) {
            throw new Error(response.error);
        }

        return response?.data ?? response;
    }

    public async upscaleImage(params: {
        mediaId: string;
        targetResolution: string;
        projectId?: string;
    }): Promise<any> {
        // Use longer timeout for 4K upscale
        const is4K = params.targetResolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K';
        const savedTimeout = this.timeoutMs;
        if (is4K) {
            this.timeoutMs = 180000; // 3 min for 4K
        }

        try {
            const body = {
                mediaId: params.mediaId,
                targetResolution: params.targetResolution,
                clientContext: {
                    recaptchaContext: {
                        applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                        token: '',
                    },
                    projectId: params.projectId || '',
                    tool: 'PINHOLE',
                    userPaygateTier: 'PAYGATE_TIER_TWO',
                    sessionId: crypto.randomUUID(),
                },
            };

            logger.info('[Image Upscale] Request body: %s', JSON.stringify(body));

            const response: any = await this.sendRequest('upscaleImage', body);

            if (response?.error) {
                throw new Error(response.error);
            }

            return response?.data ?? response;
        } finally {
            this.timeoutMs = savedTimeout;
        }
    }

    public dispose(): void {
        // Reject any in-flight requests so promises don't hang
        for (const [, entry] of this.pending) {
            try {
                clearTimeout(entry.timer);
                entry.reject(new Error(`ExtensionBridge for profile ${this.profileId} disposed`));
            } catch (e) {
                logger.warn('Failed to reject pending request on dispose: %s', e);
            }
        }
        this.pending.clear();
        this.setWebSocket(null);
        this.removeAllListeners();
    }
}
