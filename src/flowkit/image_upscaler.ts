/**
 * FlowKit Image Upscaler - Standalone module to upscale images to 2K/4K.
 * 
 * This module provides image upscaling functionality using Google Flow API.
 */

import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import { v4 as uuidv4 } from 'uuid';

const POLL_INTERVAL = 5;
const DEFAULT_UPSCALE_TIMEOUT = 180;

export interface ImageUpscaleResult {
    success: boolean;
    media_id?: string;
    url?: string;
    local_path?: string;
    error?: string;
}

export class ImageUpscalerStandalone {
    private _sendFn: ((method: string, params: Record<string, any>) => Promise<Record<string, any>>) | null = null;
    private _timeout = 300;

    constructor(sendFn: ((method: string, params: Record<string, any>) => Promise<Record<string, any>>) | null) {
        this._sendFn = sendFn;
    }

    get connected(): boolean {
        return this._sendFn !== null;
    }

    private async _send(method: string, params: Record<string, any>, timeout: number = 60): Promise<Record<string, any>> {
        if (!this._sendFn) {
            return { error: 'Send function not available' };
        }
        return await this._sendFn(method, params);
    }

    async upscale(
        mediaId: string,
        targetResolution: string = 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL',
        timeout: number = DEFAULT_UPSCALE_TIMEOUT,
        downloadTo?: string
    ): Promise<ImageUpscaleResult> {
        if (!this.connected) {
            return { success: false, error: 'Send function not available' };
        }

        if (!mediaId) {
            return { success: false, error: 'No media_id provided' };
        }

        const validResolutions = [
            'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL',
            'UPSAMPLE_IMAGE_RESOLUTION_2K',
            'UPSAMPLE_IMAGE_RESOLUTION_4K'
        ];

        if (!validResolutions.includes(targetResolution)) {
            return { success: false, error: `Invalid resolution: ${targetResolution}` };
        }

        console.log(`[ImageUpscaler] Submitting upscale: media_id=${mediaId.substring(0, 20)}, resolution=${targetResolution}`);

        // Submit upscale request
        const submitResult = await this._submitUpscale(mediaId, targetResolution);

        if (this._isError(submitResult)) {
            const errorMsg = submitResult.error || (submitResult.data as any)?.error || 'Unknown error';
            return { success: false, error: errorMsg };
        }

        // Parse operations
        const operations = this._parseOperations(submitResult);
        if (!operations || operations.length === 0) {
            return { success: false, error: 'No operations returned' };
        }

        const op = operations[0];

        // Check for immediate success
        if (op.status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
            const url = this._extractImageUrl(op);
            const mediaIdOut = this._extractMediaId(submitResult);
            console.log(`[ImageUpscaler] Upscale completed immediately: ${mediaIdOut}`);

            let localPath: string | undefined;
            if (downloadTo && url) {
                localPath = await this._downloadImage(url, downloadTo) || undefined;
            }

            return {
                success: true,
                media_id: mediaIdOut || mediaId,
                url,
                local_path: localPath
            };
        }

        if (op.status === 'MEDIA_GENERATION_STATUS_FAILED') {
            return { success: false, error: 'Image upscale failed' };
        }

        // Poll for completion
        console.log(`[ImageUpscaler] Polling for completion...`);
        const pollResult = await this._pollOperations(operations, timeout);

        if (this._isError(pollResult)) {
            return { success: false, error: pollResult.error || 'Poll failed' };
        }

        // Extract results
        const pollOps = this._parseOperations(pollResult);
        if (pollOps && pollOps.length > 0) {
            const finalOp = pollOps[0];
            const url = this._extractImageUrl(finalOp);
            const mediaIdOut = this._extractMediaId(pollResult);

            let localPath: string | undefined;
            if (downloadTo && url) {
                localPath = await this._downloadImage(url, downloadTo) || undefined;
            }

            if (finalOp.status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL') {
                console.log(`[ImageUpscaler] Upscale completed after polling: ${mediaIdOut}`);
                return {
                    success: true,
                    media_id: mediaIdOut || mediaId,
                    url,
                    local_path: localPath
                };
            } else {
                return { success: false, error: `Operation status: ${finalOp.status}` };
            }
        }

        return { success: false, error: 'No poll result' };
    }

    private async _submitUpscale(mediaId: string, targetResolution: string): Promise<Record<string, any>> {
        const params = {
            sessionId: crypto.randomUUID(),
            recaptchaContext: {
                applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB',
                token: '',
            },
            requests: [{
                seed: Date.now() % 100000,
                imageInput: { mediaId },
                targetResolution,
                modelKey: 'imagen_3_upscale',
            }],
        };
        return await this._send('upscaleImage', params, 60);
    }

    private async _pollOperations(operations: any[], timeout: number): Promise<Record<string, any>> {
        let elapsed = 0;
        const currentOps = operations.map((op: any) => ({
            operation: { name: op.operation?.name || '' },
            status: 'MEDIA_GENERATION_STATUS_PENDING'
        }));

        while (elapsed < timeout) {
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL * 1000));
            elapsed += POLL_INTERVAL;

            const statusResult = await this._checkStatus(currentOps);
            if (this._isError(statusResult)) {
                console.log(`[ImageUpscaler] Status poll error: ${statusResult.error}`);
                continue;
            }

            const pollOps = this._parseOperations(statusResult);
            if (!pollOps || pollOps.length === 0) {
                continue;
            }

            // Update current ops
            for (let i = 0; i < pollOps.length; i++) {
                if (currentOps[i]) {
                    currentOps[i].status = pollOps[i].status;
                }
            }

            // Check all operations
            let allDone = true;
            let hasError = false;

            for (const op of pollOps) {
                const status = op.status || '';
                if (status === 'MEDIA_GENERATION_STATUS_PENDING') {
                    allDone = false;
                } else if (status === 'MEDIA_GENERATION_STATUS_FAILED') {
                    hasError = true;
                    break;
                }
            }

            if (hasError) {
                return { error: 'Operation failed' };
            }

            if (allDone) {
                console.log(`[ImageUpscaler] All operations completed after ${elapsed}s`);
                return statusResult;
            }

            console.log(`[ImageUpscaler] Poll ${elapsed}s/${timeout}s: in progress`);
        }

        return { error: `Polling timeout after ${timeout}s` };
    }

    private async _checkStatus(operations: any[]): Promise<Record<string, any>> {
        const params = { operations };
        return await this._send('checkImageStatus', params, 30);
    }

    private _parseOperations(result: Record<string, any>): any[] {
        const data = result.data || result;
        return data.operations || [];
    }

    private _extractImageUrl(operation: any): string {
        const metadata = operation.operation?.metadata || {};
        const imageMeta = metadata.image || {};
        return imageMeta.fifeUrl || '';
    }

    private _isError(result: Record<string, any>): boolean {
        if (result.error) return true;
        const status = result.status;
        if (typeof status === 'number' && status >= 400) return true;
        const data = result.data || {};
        if ((data as any).error) return true;
        return false;
    }

    private _extractMediaId(result: Record<string, any>): string | null {
        const data = result.data || result;
        const ops = data.operations || [];

        if (ops.length === 0) return null;

        const imageMeta = ops[0].operation?.metadata?.image || {};

        // Try various fields
        const fields = ['mediaId', 'name'];
        for (const field of fields) {
            const val = imageMeta[field];
            if (val && this._isUuid(val)) {
                return val;
            }
        }

        // Try to extract from URL
        const fifeUrl = imageMeta.fifeUrl || '';
        const uuidMatch = fifeUrl.match(/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
        if (uuidMatch) {
            return uuidMatch[1];
        }

        return null;
    }

    private _isUuid(value: string): boolean {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    }

    private async _downloadImage(url: string, destPath: string): Promise<string | null> {
        if (!url) return null;

        try {
            const dir = path.dirname(destPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            return new Promise((resolve) => {
                const file = fs.createWriteStream(destPath);
                https.get(url, (response) => {
                    if (response.statusCode === 200) {
                        response.pipe(file);
                        file.on('finish', () => {
                            file.close();
                            console.log(`[ImageUpscaler] Downloaded to: ${destPath}`);
                            resolve(destPath);
                        });
                    } else {
                        file.close();
                        console.log(`[ImageUpscaler] Failed to download: HTTP ${response.statusCode}`);
                        resolve(null);
                    }
                }).on('error', (err) => {
                    fs.unlink(destPath, () => {});
                    console.log(`[ImageUpscaler] Download error: ${err.message}`);
                    resolve(null);
                });
            });
        } catch (e: any) {
            console.log(`[ImageUpscaler] Download error: ${e.message}`);
            return null;
        }
    }
}

// Standalone utility function
export async function downloadImage(url: string, destPath: string): Promise<string | null> {
    if (!url) return null;

    try {
        const dir = path.dirname(destPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        return new Promise((resolve) => {
            const file = fs.createWriteStream(destPath);
            https.get(url, (response) => {
                if (response.statusCode === 200) {
                    response.pipe(file);
                    file.on('finish', () => {
                        file.close();
                        console.log(`[ImageUpscaler] Downloaded to: ${destPath}`);
                        resolve(destPath);
                    });
                } else {
                    file.close();
                    resolve(null);
                }
            }).on('error', (err) => {
                fs.unlink(destPath, () => {});
                resolve(null);
            });
        });
    } catch (e: any) {
        console.log(`[ImageUpscaler] Download error: ${e.message}`);
    }
    return null;
}
