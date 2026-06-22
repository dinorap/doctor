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

        return {
            credits: typeof normalized?.credits === 'number' ? normalized.credits : null,
            userPaygateTier: typeof normalized?.userPaygateTier === 'string' ? normalized.userPaygateTier : null,
        };
    }

    public async getStatusWithDetails(): Promise<any> {
        return this.sendRequest('get_status', {});
    }

    public async getSession(): Promise<any> {
        return this.sendRequest('get_session', {});
    }

    public async apiRequest<T = any>(payload: {
        url: string;
        method?: string;
        headers?: Record<string, string>;
        body?: any;
        captchaAction?: string;
    }): Promise<T> {
        const response = await this.sendRequest<any>('api_request', {
            url: payload.url,
            method: payload.method || 'GET',
            headers: payload.headers,
            body: payload.body,
            captchaAction: payload.captchaAction,
        });

        if (typeof response === 'string') {
            return JSON.parse(response) as T;
        }

        return response as T;
    }

    public async getActiveProject(): Promise<any> {
        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/project.getActiveProject',
            method: 'GET',
        });

        return response;
    }

    public async getActiveScene(): Promise<any> {
        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/scene.getActiveScene',
            method: 'GET',
        });

        return response;
    }

    public async getActiveVideo(): Promise<any> {
        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/video.getActiveVideo',
            method: 'GET',
        });

        return response;
    }

    public async getMediaList(projectId: string, sceneId: string): Promise<any> {
        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/media.list',
            method: 'POST',
            body: {
                json: {
                    projectId,
                    sceneId,
                },
            },
        });

        return response;
    }

    public async getMediaDetails(projectId: string, sceneId: string, mediaId: string): Promise<any> {
        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/media.get',
            method: 'POST',
            body: {
                json: {
                    projectId,
                    sceneId,
                    mediaId,
                },
            },
        });

        return response;
    }

    public async getMediaDownloadLink(projectId: string, sceneId: string, mediaId: string): Promise<any> {
        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/media.download',
            method: 'POST',
            body: {
                json: {
                    projectId,
                    sceneId,
                    mediaId,
                },
            },
        });

        return response;
    }

    public async uploadImage(params: {
        projectId: string;
        sceneId?: string;
        filePath?: string;
        fileName?: string;
        fileData?: string; // base64 encoded data
        mimeType?: string;
    }): Promise<any> {
        let base64Data = params.fileData;
        
        // If filePath is provided but no base64, read from disk (server-side only)
        if (!base64Data && params.filePath) {
            if (typeof require !== 'undefined') {
                try {
                    const fs = require('fs');
                    const fileBuffer = fs.readFileSync(params.filePath);
                    base64Data = fileBuffer.toString('base64');
                } catch (e) {
                    logger.warn('[ExtensionBridge] Cannot read file from path, expecting base64 data');
                }
            }
        }

        if (!base64Data) {
            throw new Error('uploadImage requires either filePath or fileData');
        }

        const fileName = params.fileName || 'upload.png';
        const mimeType = params.mimeType || 'image/jpeg';

        // Match Python API: /v1/flow/uploadImage
        const response = await this.sendRequest('api_request', {
            url: 'https://aisandbox-pa.googleapis.com/v1/flow/uploadImage',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: {
                clientContext: {
                    projectId: params.projectId,
                    tool: 'PINHOLE',
                    sessionId: `;${Date.now()}`,
                },
                fileName,
                imageBytes: base64Data,
                mimeType,
                isHidden: false,
                isUserUploaded: true,
            },
            captchaAction: 'IMAGE_UPLOAD',
        });

        // Extract media ID from response
        // Response: { media: { name: "uuid" } }
        if (response && !response.error) {
            const media = response.media || (response.data && response.data.media);
            if (media?.name) {
                response._mediaId = media.name;
            }
        }

        return response;
    }

    public async generateImages(params: {
        projectId: string;
        sceneId: string;
        prompt: string;
        modelKey?: string;
        aspectRatio?: string;
        numberOfImages?: number;
        userPaygateTier?: string;
    }): Promise<any> {
        const aspectRatio = params.aspectRatio || 'VIDEO_ASPECT_RATIO_PORTRAIT';
        const userPaygateTier = params.userPaygateTier || 'PAYGATE_TIER_TWO';
        const numberOfImages = params.numberOfImages || 4;

        const baseClientContext = {
            recaptchaContext: {
                applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                token: '',
            },
            projectId: params.projectId,
            tool: 'PINHOLE',
            userPaygateTier,
            sessionId: `;${Date.now()}`,
        };

        // Build each request item (one per output image, varying seed)
        const requests: any[] = [];
        for (let i = 0; i < numberOfImages; i++) {
            requests.push({
                clientContext: { ...baseClientContext, sessionId: `;${Date.now() + i}` },
                imageAspectRatio: aspectRatio,
                seed: (Math.floor(Date.now() / 1000) + i) % 1000000,
                prompt: params.prompt,
                imageInputs: [],
                ...(params.modelKey ? { imageModelName: params.modelKey } : {}),
            });
        }

        const body: any = {
            clientContext: baseClientContext,
            mediaGenerationContext: { batchId: crypto.randomUUID() },
            useNewMedia: true,
            requests,
        };

        const response: any = await this.sendRequest('api_request', {
            url: `https://aisandbox-pa.googleapis.com/v1/projects/${params.projectId}/flowMedia:batchGenerateImages`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body,
            captchaAction: 'IMAGE_GENERATION',
        });

        if (response?.error) {
            throw new Error(response.error);
        }

        return response?.data ?? response;
    }

    public async generateVideo(params: {
        startImageMediaId?: string;
        prompt: string;
        projectId: string;
        sceneId: string;
        aspectRatio?: string;
        endImageMediaId?: string;
        userPaygateTier?: string;
        videoModelKey?: string;
        referenceAudio?: { mediaId: string }[];
    }): Promise<any> {
        const aspectRatio = params.aspectRatio || 'VIDEO_ASPECT_RATIO_PORTRAIT';
        const userPaygateTier = params.userPaygateTier || 'PAYGATE_TIER_TWO';
        const hasStartImage = params.startImageMediaId && params.startImageMediaId.trim();
        const hasEndImage = params.endImageMediaId && params.endImageMediaId.trim();
        const useStartEnd = hasStartImage && hasEndImage;
        const useStartImage = hasStartImage && !hasEndImage;

        const request: any = {
            aspectRatio,
            seed: Math.floor(Date.now() / 1000) % 10000,
            textInput: {
                structuredPrompt: {
                    parts: [{ text: params.prompt }],
                },
            },
            metadata: { sceneId: params.sceneId },
        };

        // Chỉ thêm startImage khi có mediaId thực
        if (useStartImage) {
            request.startImage = { mediaId: params.startImageMediaId };
        } else if (useStartEnd) {
            request.startImage = { mediaId: params.startImageMediaId };
            request.endImage = { mediaId: params.endImageMediaId };
        }

        // Thêm referenceAudio để đồng nhất giọng nhân vật
        if (params.referenceAudio && params.referenceAudio.length > 0) {
            request.referenceAudio = params.referenceAudio;
        }

        if (params.videoModelKey) {
            request.videoModelKey = params.videoModelKey;
        }

        const body: any = {
            mediaGenerationContext: {
                batchId: crypto.randomUUID(),
                audioFailurePreference: 'BLOCK_SILENCED_VIDEOS',
            },
            clientContext: {
                recaptchaContext: {
                    applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                    token: '',
                },
                projectId: params.projectId,
                tool: 'PINHOLE',
                userPaygateTier,
                sessionId: `;${Date.now()}`,
            },
            requests: [request],
            useV2ModelConfig: true,
        };

        // Chọn endpoint đúng dựa trên loại video
        let url: string;
        if (useStartEnd) {
            url = 'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartAndEndImage';
        } else if (useStartImage) {
            url = 'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage';
        } else {
            // Pure T2V - text to video không có image
            url = 'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText';
        }

        const response: any = await this.sendRequest('api_request', {
            url,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body,
            captchaAction: 'VIDEO_GENERATION',
        });

        if (response?.error) {
            throw new Error(response.error);
        }

        return response?.data ?? response;
    }

    public async generateVideoFromReferences(params: {
        referenceMediaIds: string[];
        prompt: string;
        projectId: string;
        sceneId: string;
        aspectRatio?: string;
        userPaygateTier?: string;
        videoModelKey?: string;
        referenceAudio?: { mediaId: string }[];
    }): Promise<any> {
        const aspectRatio = params.aspectRatio || 'VIDEO_ASPECT_RATIO_PORTRAIT';
        const userPaygateTier = params.userPaygateTier || 'PAYGATE_TIER_TWO';

        const request: any = {
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

        const body: any = {
            mediaGenerationContext: {
                batchId: crypto.randomUUID(),
                audioFailurePreference: 'BLOCK_SILENCED_VIDEOS',
            },
            clientContext: {
                recaptchaContext: {
                    applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                    token: '',
                },
                projectId: params.projectId,
                tool: 'PINHOLE',
                userPaygateTier,
                sessionId: `;${Date.now()}`,
            },
            requests: [request],
            useV2ModelConfig: true,
        };

        const response: any = await this.sendRequest('api_request', {
            url: 'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body,
            captchaAction: 'VIDEO_GENERATION',
        });

        if (response?.error) {
            throw new Error(response.error);
        }

        return response?.data ?? response;
    }

    /**
     * Upscale an image to higher resolution (2K or 4K)
     * Endpoint: POST https://aisandbox-pa.googleapis.com/v1/flow/upsampleImage
     */
    public async upscaleImage(params: {
        mediaId: string;
        targetResolution: string;
        projectId?: string;
        userPaygateTier?: string;
    }): Promise<any> {
        const userPaygateTier = params.userPaygateTier || 'PAYGATE_TIER_TWO';

        const body: any = {
            mediaId: params.mediaId,
            targetResolution: params.targetResolution,
            clientContext: {
                recaptchaContext: {
                    applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                    token: '',
                },
                projectId: params.projectId || '',
                tool: 'PINHOLE',
                userPaygateTier,
                sessionId: `;${Date.now()}`,
            },
        };

        const response: any = await this.sendRequest('api_request', {
            url: 'https://aisandbox-pa.googleapis.com/v1/flow/upsampleImage',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body,
            captchaAction: 'IMAGE_GENERATION', // Same action as image gen (not IMAGE_UPSCALE)
        });

        if (response?.error) {
            throw new Error(response.error);
        }

        return response?.data ?? response;
    }

    /**
     * Upscale a video to higher resolution (1080P, 4K)
     * Endpoint: POST https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoUpsampleVideo
     * Video upscale is ALWAYS async - requires polling via checkVideoStatus
     */
    public async upscaleVideo(params: {
        mediaId: string;
        sceneId?: string;
        aspectRatio?: string;
        resolution?: string;
        projectId?: string;
        userPaygateTier?: string;
        recaptchaToken?: string;
        workflowId?: string;
    }): Promise<any> {
        const aspectRatio = params.aspectRatio || 'VIDEO_ASPECT_RATIO_PORTRAIT';
        const resolution = params.resolution || 'VIDEO_RESOLUTION_4K';
        const userPaygateTier = params.userPaygateTier || 'PAYGATE_TIER_TWO';

        // Map resolution to model key
        const UPSCALE_MODELS: Record<string, string> = {
            'VIDEO_RESOLUTION_1080P': 'veo_3_1_upsampler_1080p',
            'VIDEO_RESOLUTION_4K': 'veo_3_1_upsampler_4k',
        };
        const videoModelKey = UPSCALE_MODELS[resolution] || 'veo_3_1_upsampler_4k';

        const body: any = {
            // Exact payload from browser network capture
            mediaGenerationContext: {
                batchId: `;${Date.now()}`, // Same format as sessionId
                audioFailurePreference: 'BLOCK_SILENCED_VIDEOS', // Important!
            },
            clientContext: {
                projectId: params.projectId,
                tool: 'PINHOLE',
                userPaygateTier: userPaygateTier,
                sessionId: `;${Date.now()}`,
                recaptchaContext: {
                    token: params.recaptchaToken || '', // Real token required!
                    applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                },
            },
            requests: [{
                resolution,
                aspectRatio,
                videoModelKey,
                seed: Math.floor(Math.random() * 100000),
                metadata: params.workflowId ? { workflowId: params.workflowId } : undefined,
                videoInput: {
                    mediaId: params.mediaId,
                },
            }],
            useV2ModelConfig: true, // Important! Enables v2 model config
        };

        logger.info(`[ExtensionBridge] upscaleVideo: mediaId=${params.mediaId}, resolution=${resolution}, projectId=${params.projectId}, userPaygateTier=${userPaygateTier}`);

        const response: any = await this.sendRequest('api_request', {
            url: 'https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoUpsampleVideo',
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body,
            captchaAction: 'VIDEO_GENERATION', // Same action as video gen
        });

        if (response?.error) {
            throw new Error(response.error);
        }

        return response?.data ?? response;
    }

    /**
     * Check video generation status
     * Supports both operation-based (old) and media-based (v3.1) APIs
     * For reference video, media-based API may 404 → fallback to operations
     */
    public async checkVideoStatus(params: {
        operations?: string[];
        mediaIds?: string[];
        projectId?: string;
    }): Promise<any> {
        const { operations = [], mediaIds = [], projectId } = params;
        
        // Use video:batchCheckAsyncVideoGenerationStatus endpoint
        // Request format: { media: [{ name: "mediaId", projectId: "projectId" }] }
        if (mediaIds.length > 0) {
            const response = await this.sendRequest('api_request', {
                url: 'https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: {
                    media: mediaIds.map(id => ({
                        name: id,
                        ...(projectId ? { projectId } : {}),
                    })),
                },
            });
            logger.info(`[checkVideoStatus] mediaIds=${mediaIds.length} responseStatus=${response?.status || response?.data?.status || 'unknown'}`);
            return response;
        }
        
        // Fallback to operations format if no mediaIds
        if (operations.length > 0) {
            const response = await this.sendRequest('api_request', {
                url: 'https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: {
                    operations: operations.map(op => ({ 
                        operation: { name: op } 
                    })),
                },
            });
            logger.info(`[checkVideoStatus] operations=${operations.length} responseStatus=${response?.status || response?.data?.status || 'unknown'}`);
            return response;
        }
        
        return { media: [], operations: [] };
    }

    private async checkViaOperations(operations: string[]): Promise<any> {
        // Poll each operation individually using getOperation endpoint
        const results = [];
        for (const opName of operations) {
            if (!opName) continue;
            try {
                const opResult = await this.getOperation(opName);
                results.push(opResult);
            } catch (e) {
                logger.warn(`[checkViaOperations] Failed to get operation ${opName}: ${e}`);
            }
        }
        // Return as operations array for consistent parsing
        return { operations: results };
    }
    
    /**
     * Get operation details (for download after completion)
     */
    public async getOperation(operationName: string): Promise<any> {
        const response = await this.sendRequest('api_request', {
            url: `https://aisandbox-pa.googleapis.com/v1/${operationName}`,
            method: 'GET',
            headers: {
                'Authorization': 'Bearer ...', // Will be filled by sendRequest
            },
        });
        return response;
    }

    public async listProjects(): Promise<any> {
        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/project.list',
            method: 'GET',
        });

        return response;
    }

    public async listScenes(projectId: string): Promise<any> {
        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/scene.list',
            method: 'POST',
            body: {
                json: {
                    projectId,
                },
            },
        });

        return response;
    }

    public async createScene(projectId: string, sceneTitle?: string): Promise<any> {
        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/scene.createScene',
            method: 'POST',
            body: {
                json: {
                    projectId,
                    sceneTitle: sceneTitle || 'Scene',
                },
            },
        });

        return response;
    }

    public async deleteScene(projectId: string, sceneId: string): Promise<any> {
        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/scene.deleteScene',
            method: 'POST',
            body: {
                json: {
                    projectId,
                    sceneId,
                },
            },
        });

        return response;
    }

    public async renameScene(projectId: string, sceneId: string, newTitle: string): Promise<any> {
        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/scene.updateScene',
            method: 'POST',
            body: {
                json: {
                    projectId,
                    sceneId,
                    title: newTitle,
                },
            },
        });

        return response;
    }

    public async deleteMedia(projectId: string, sceneId: string, mediaId: string): Promise<any> {
        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/media.delete',
            method: 'POST',
            body: {
                json: {
                    projectId,
                    sceneId,
                    mediaId,
                },
            },
        });

        return response;
    }

    public async getMediaStatus(mediaId: string): Promise<any> {
        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/media.getStatus',
            method: 'POST',
            body: {
                json: {
                    mediaId,
                },
            },
        });

        return response;
    }

    /**
     * Get media details via trpc (uses browser cookies automatically).
     * POST /api/trpc/media.get
     * Fallback option if direct GET fails. The browser does not have a Bearer
     * token, so this route is more reliable.
     */
    public async getMediaTrpc(mediaId: string, projectId?: string, sceneId?: string): Promise<any> {
        const body: any = { json: { mediaId } };
        if (projectId) body.json.projectId = projectId;
        if (sceneId) body.json.sceneId = sceneId;

        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/media.get',
            method: 'POST',
            body,
        });
        return response;
    }

    /**
     * Direct GET /v1/media/{id}?clientContext.tool=PINHOLE
     * Same pattern as api_request (checkVideoStatus) - the extension fetches
     * in the browser context using its own cookies. Do NOT send an
     * Authorization header because the browser does NOT have a Bearer token.
     */
    public async getMedia(mediaId: string): Promise<any> {
        const response = await this.sendRequest('api_request', {
            url: `https://aisandbox-pa.googleapis.com/v1/media/${mediaId}?clientContext.tool=PINHOLE`,
            method: 'GET',
        });
        return response;
    }

    /**
     * trpc variant (kept as fallback). Some media may only be reachable
     * via the trpc media.get endpoint.
     */

    public async getTierStatus(): Promise<any> {
        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/user.getTierStatus',
            method: 'GET',
        });

        return response;
    }

    public async getUserProfile(): Promise<any> {
        const response = await this.sendRequest('trpc_request', {
            url: 'https://labs.google/fx/api/trpc/user.getProfile',
            method: 'GET',
        });

        return response;
    }

    public close(): void {
        if (this.ws) {
            try {
                this.ws.close();
            } catch {
                // ignore
            }
            this.ws = null;
        }
        this.updateStatus({ connected: false, state: 'off' });
    }
}
