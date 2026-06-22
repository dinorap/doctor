import { EventEmitter } from 'events';
import { logger } from '../utils/logger';
import WebSocket from 'ws';

export type PaygateTier = 'PAYGATE_TIER_ONE' | 'PAYGATE_TIER_TWO' | 'UNKNOWN';

export interface FlowCreditsResponse {
    credits?: number;
    userPaygateTier?: PaygateTier;
    [key: string]: any;
}

export interface FlowApiClientOptions {
    wsUrl: string;
    flowKey?: string;
    timeoutMs?: number;
    profileId?: string;
}

/**
 * Per-profile Flow API WebSocket client.
 *
 * Each profile owns its own instance — never share between profiles.
 * Use FlowApiRegistry.getOrCreate(profileId) to obtain one.
 */
export class FlowApiClient extends EventEmitter {
    private profileId: string;
    private ws: WebSocket | null = null;
    private wsUrl: string;
    private flowKey: string | null;
    private timeoutMs: number;
    private pending = new Map<string, { resolve: (value: any) => void; reject: (reason?: any) => void }>();
    private connected = false;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private messageQueue: string[] = [];
    private queueLock = false;
    private connecting = false;
    private connectionPromise: Promise<void> | null = null;
    private manualDisconnect = false;

    constructor(options: FlowApiClientOptions) {
        super();
        this.profileId = options.profileId || 'default';
        this.wsUrl = (options.wsUrl || '').replace(/\/$/, '');
        this.flowKey = options.flowKey || null;
        this.timeoutMs = options.timeoutMs ?? 10000;
    }

    public getProfileId(): string {
        return this.profileId;
    }

    public isConnected(): boolean {
        return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    }

    public hasFlowKey(): boolean {
        return !!this.flowKey;
    }

    public connect(): Promise<void> {
        if (this.isConnected()) {
            return Promise.resolve();
        }

        if (this.connectionPromise) {
            return this.connectionPromise;
        }

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (!this.flowKey) {
            return Promise.reject(new Error(`[profile ${this.profileId}] Flow API key is not configured`));
        }

        if (!this.wsUrl) {
            return Promise.reject(new Error(`[profile ${this.profileId}] Flow WebSocket URL is not configured`));
        }

        this.connecting = true;
        this.connectionPromise = new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn: (value: any) => void, value: any) => {
                if (!settled) {
                    settled = true;
                    fn(value);
                }
            };

            const connectTimeout = setTimeout(() => {
                this.cleanupSocket();
                this.connecting = false;
                this.connectionPromise = null;
                settle(reject, new Error(`[profile ${this.profileId}] Flow WebSocket connection timed out`));
            }, this.timeoutMs);

            try {
                this.ws = new WebSocket(this.wsUrl);
            } catch (error) {
                clearTimeout(connectTimeout);
                this.connecting = false;
                this.connectionPromise = null;
                settle(reject, new Error(`[profile ${this.profileId}] Failed to create WebSocket: ${error}`));
                return;
            }

            this.ws.on('open', () => {
                clearTimeout(connectTimeout);
                this.connected = true;
                this.connecting = false;
                this.connectionPromise = null;
                this.processQueue();
                this.emit('connected');
                settle(resolve, undefined);
            });

            this.ws.on('error', (error: Error) => {
                clearTimeout(connectTimeout);
                this.cleanupSocket();
                this.connecting = false;
                this.connectionPromise = null;
                this.emit('error', error);
                settle(reject, new Error(`[profile ${this.profileId}] Flow WebSocket error: ${error.message || error}`));
            });

            this.ws.on('close', (code: number, reason: string) => {
                clearTimeout(connectTimeout);
                const wasConnected = this.connected;
                this.cleanupSocket();
                this.connecting = false;
                this.connectionPromise = null;
                this.emit('disconnected', { code, reason });

                if (!settled) {
                    settled = true;
                    if (wasConnected) {
                        settle(resolve, undefined);
                    } else {
                        settle(reject, new Error(`[profile ${this.profileId}] Flow WebSocket closed unexpectedly: code=${code}`));
                    }
                }

                if (wasConnected && !this.manualDisconnect) {
                    logger.info('[profile %s] Flow WebSocket closed. Reconnecting in 2s...', this.profileId);
                    this.reconnectTimer = setTimeout(() => {
                        this.connect().catch(() => { /* swallow — will retry */ });
                    }, 2000);
                }
            });

            this.ws.on('message', (data: WebSocket.RawData) => {
                try {
                    const parsed = JSON.parse(String(data));
                    this.handleMessage(parsed);
                } catch (error) {
                    logger.warn('[profile %s] Failed to parse Flow message: %s', this.profileId, error);
                }
            });
        });

        return this.connectionPromise;
    }

    public disconnect(): void {
        this.manualDisconnect = true;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        this.cleanupSocket();
        this.connected = false;
        this.connecting = false;
        this.connectionPromise = null;
    }

    public async getCredits(): Promise<FlowCreditsResponse> {
        this.ensureFlowKey();
        const params: Record<string, string> = { flowKey: this.flowKey as string };

        return this.sendRequest<FlowCreditsResponse>('getCredits', params);
    }

    public async createProject(
        projectTitle: string,
        toolName: string = 'PINHOLE',
        timeoutMs?: number,
    ): Promise<any> {
        this.ensureFlowKey();
        const params: Record<string, string> = {
            flowKey: this.flowKey as string,
            projectTitle,
            toolName,
        };

        return this.sendRequest<any>('createProject', params, timeoutMs);
    }

    public async generateImages(params: {
        prompt: string;
        projectId: string;
        aspectRatio?: string;
        userPaygateTier?: PaygateTier;
        modelKey?: string;
        characterMediaIds?: string[];
    }): Promise<any> {
        this.ensureFlowKey();
        const body: Record<string, any> = {
            flowKey: this.flowKey as string,
            projectId: params.projectId,
            userPaygateTier: params.userPaygateTier || 'PAYGATE_TIER_TWO',
            prompt: params.prompt,
            aspectRatio: params.aspectRatio || 'IMAGE_ASPECT_RATIO_PORTRAIT',
        };

        if (params.modelKey) {
            body.modelKey = params.modelKey;
        }

        if (params.characterMediaIds && params.characterMediaIds.length) {
            body.characterMediaIds = params.characterMediaIds;
        }

        return this.sendRequest<any>('generateImages', body);
    }

    public async uploadImage(imageBase64: string, mimeType: string, projectId: string, fileName: string): Promise<any> {
        this.ensureFlowKey();
        const body: Record<string, any> = {
            flowKey: this.flowKey as string,
            projectId,
            fileName,
            imageBytes: imageBase64,
            mimeType,
            isHidden: false,
            isUserUploaded: true,
        };

        return this.sendRequest<any>('uploadImage', body);
    }

    public async generateVideo(params: {
        startImageMediaId?: string;
        prompt: string;
        projectId: string;
        sceneId: string;
        aspectRatio?: string;
        endImageMediaId?: string;
        userPaygateTier?: PaygateTier;
        videoModelKey?: string;
        referenceAudio?: { mediaId: string }[];
    }): Promise<any> {
        this.ensureFlowKey();
        const aspectRatio = params.aspectRatio || 'VIDEO_ASPECT_RATIO_PORTRAIT';
        const userPaygateTier = params.userPaygateTier || 'PAYGATE_TIER_TWO';
        const hasStartImage = params.startImageMediaId && params.startImageMediaId.trim();
        const hasEndImage = params.endImageMediaId && params.endImageMediaId.trim();
        const useStartEnd = hasStartImage && hasEndImage;
        const useStartImage = hasStartImage && !hasEndImage;

        const request: Record<string, any> = {
            aspectRatio,
            seed: Math.floor(Date.now() / 1000) % 10000,
            textInput: {
                structuredPrompt: {
                    parts: [{ text: params.prompt }],
                },
            },
            metadata: {},
        };

        // Chỉ thêm startImage/endImage khi có mediaId thực
        // cropCoordinates mặc định cho start_end mode
        const defaultCrop = { top: 0, left: 0.344, bottom: 1, right: 0.656 };
        if (useStartImage) {
            request.startImage = { mediaId: params.startImageMediaId, cropCoordinates: defaultCrop };
        } else if (useStartEnd) {
            request.startImage = { mediaId: params.startImageMediaId, cropCoordinates: defaultCrop };
            request.endImage = { mediaId: params.endImageMediaId, cropCoordinates: defaultCrop };
        }

        // NOTE: referenceAudio NOT supported for batchAsyncGenerateVideoStartAndEndImage
        // Only supported for reference video generation

        if (params.videoModelKey) {
            request.videoModelKey = params.videoModelKey;
        }

        const body: Record<string, any> = {
            flowKey: this.flowKey as string,
            projectId: params.projectId,
            userPaygateTier,
            mediaGenerationContext: {
                batchId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                audioFailurePreference: 'BLOCK_SILENCED_VIDEOS',
            },
            requests: [request],
            useV2ModelConfig: true,
        };

        const method = useStartEnd ? 'generateVideoStartEnd' : useStartImage ? 'generateVideo' : 'generateTextToVideo';
        return this.sendRequest<any>(method, body);
    }

    public async generateVideoFromReferences(params: {
        referenceMediaIds: string[];
        prompt: string;
        projectId: string;
        sceneId: string;
        aspectRatio?: string;
        userPaygateTier?: PaygateTier;
        videoModelKey?: string;
        referenceAudio?: { mediaId: string }[];
    }): Promise<any> {
        this.ensureFlowKey();
        const aspectRatio = params.aspectRatio || 'VIDEO_ASPECT_RATIO_PORTRAIT';
        const userPaygateTier = params.userPaygateTier || 'PAYGATE_TIER_TWO';

        const request: Record<string, any> = {
            aspectRatio,
            seed: Math.floor(Date.now() / 1000) % 10000,
            textInput: {
                structuredPrompt: {
                    parts: [{ text: params.prompt }],
                },
            },
            referenceImages: params.referenceMediaIds.map((mediaId) => ({
                mediaId,
                imageUsageType: 'IMAGE_USAGE_TYPE_ASSET',
            })),
            metadata: {},
        };

        // Add referenceAudio if provided
        if (params.referenceAudio && params.referenceAudio.length > 0) {
            request.referenceAudio = params.referenceAudio;
        }

        if (params.videoModelKey) {
            request.videoModelKey = params.videoModelKey;
        }

        const body: Record<string, any> = {
            flowKey: this.flowKey as string,
            projectId: params.projectId,
            userPaygateTier,
            mediaGenerationContext: {
                batchId: `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
                audioFailurePreference: 'BLOCK_SILENCED_VIDEOS',
            },
            requests: [request],
            useV2ModelConfig: true,
        };

        return this.sendRequest<any>('generateVideoFromReferences', body);
    }

    public async upscaleVideo(params: {
        mediaId: string;
        sceneId: string;
        aspectRatio?: string;
        resolution?: string;
    }): Promise<any> {
        this.ensureFlowKey();
        const aspectRatio = params.aspectRatio || 'VIDEO_ASPECT_RATIO_PORTRAIT';
        const resolution = params.resolution || 'VIDEO_RESOLUTION_4K';

        const body: Record<string, any> = {
            flowKey: this.flowKey as string,
            mediaId: params.mediaId,
            sceneId: params.sceneId,
            aspectRatio,
            resolution,
        };

        return this.sendRequest<any>('upscaleVideo', body);
    }

    public async checkVideoStatus(operations: any[]): Promise<any> {
        this.ensureFlowKey();
        return this.sendRequest<any>('checkVideoStatus', {
            flowKey: this.flowKey as string,
            operations,
        });
    }

    public setFlowKey(flowKey: string): void {
        this.flowKey = flowKey;
        this.emit('flowKeyChanged', flowKey);
    }

    public getFlowKey(): string | null {
        return this.flowKey;
    }

    /**
     * Classify a thrown error as an "auth failure" — meaning the user
     * likely hasn't signed into Flow in this profile yet (or their
     * session has expired and the page will redirect to login).
     *
     * Callers (e.g. tier detection retry loops) use this to stop
     * hammering the API every 5s — there's no point retrying until the
     * user manually logs in.
     */
    public isAuthError(err: unknown): boolean {
        const msg = (err instanceof Error ? err.message : String(err || '')).toLowerCase();
        if (!msg) return false;
        return (
            msg.includes('no_flow_key') ||
            msg.includes('unauthorized') ||
            msg.includes('401') ||
            msg.includes('403') ||
            msg.includes('flow api key is not configured') ||
            msg.includes('flow api connection failed') ||
            msg.includes('not signed in') ||
            msg.includes('login required')
        );
    }

    private ensureFlowKey(): void {
        if (!this.flowKey) {
            throw new Error(`[profile ${this.profileId}] Flow API key is not configured`);
        }
    }

    private sendRequest<T>(method: string, params: Record<string, any> = {}, timeoutMs?: number): Promise<T> {
        if (!this.isConnected()) {
            return this.connect()
                .then(() => this.sendRequest<T>(method, params, timeoutMs))
                .catch((error) => {
                    throw new Error(`[profile ${this.profileId}] Flow API connection failed: ${error}`);
                });
        }

        const requestId = this.generateId();
        const payload = JSON.stringify({ id: requestId, method, params });

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new Error(`[profile ${this.profileId}] Flow request ${method} timed out`));
            }, timeoutMs ?? this.timeoutMs);

            this.pending.set(requestId, {
                resolve: (value: any) => {
                    clearTimeout(timer);
                    this.pending.delete(requestId);
                    resolve(value.result ?? value);
                },
                reject: (reason?: any) => {
                    clearTimeout(timer);
                    this.pending.delete(requestId);
                    reject(reason);
                },
            });

            this.enqueue(payload);
        });
    }

    private enqueue(payload: string): void {
        this.messageQueue.push(payload);
        this.processQueue();
    }

    private processQueue(): void {
        if (this.queueLock || !this.isConnected()) {
            return;
        }

        this.queueLock = true;

        while (this.messageQueue.length > 0 && this.isConnected()) {
            const payload = this.messageQueue.shift();
            if (payload) {
                try {
                    this.ws?.send(payload);
                } catch (error) {
                    logger.warn('[profile %s] Failed to send Flow message: %s', this.profileId, error);
                }
            }
        }

        this.queueLock = false;
    }

    private handleMessage(data: any): void {
        const requestId = data.id ?? data.requestId;
        if (!requestId) {
            return;
        }

        const entry = this.pending.get(requestId);
        if (!entry) {
            return;
        }

        if (data.error) {
            entry.reject(new Error(data.error));
            return;
        }

        entry.resolve(data);
    }

    private cleanupSocket(): void {
        if (this.ws) {
            try {
                this.ws.removeAllListeners();
                this.ws.close();
            } catch {
                // ignore close errors
            }
            this.ws = null;
        }
        this.connected = false;
    }

    private generateId(): string {
        return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    }
}
