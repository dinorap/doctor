import path from 'path';
import fs from 'fs';
import { DatabaseManager, EntityReferenceRecord } from '../database/Database';
import { FlowApiRegistry } from '../flow-api/FlowApiRegistry';
import logger from '../utils/logger';

export interface ReferenceImageTarget {
    /** Unique key to identify this image (e.g., entityId or filePath) */
    key: string;
    /** Local file path to upload */
    localPath: string;
    /** Optional friendly name */
    name?: string;
    /** MIME type (default: image/jpeg) */
    mimeType?: string;
}

export interface ProfileMediaMap {
    [profileId: string]: {
        [imageKey: string]: {
            mediaId: string;
            uploadedAt: string;
            url?: string;
        };
    };
}

export interface UploadResult {
    success: boolean;
    imageKey: string;
    profileId: string;
    mediaId?: string;
    error?: string;
}

export interface UploadAllResult {
    totalImages: number;
    totalProfiles: number;
    results: UploadResult[];
    mediaMap: ProfileMediaMap;
    /** Images that were uploaded to at least one profile successfully */
    successfulUploads: string[];
    /** Images that failed on all profiles */
    failedImages: string[];
}

/**
 * ReferenceImageManager handles uploading all reference images (characters, locations,
 * environment images) to every selected profile's Flow project, and provides a
 * mediaId lookup map so scenes can reference images by key.
 *
 * Flow:
 *  1. Collect unique reference images from script scenes
 *  2. Upload each image to every profile's Flow project
 *  3. Return { imageKey -> { profileId -> mediaId } }
 *  4. VideoWorker uses this map to inject referenceMediaIds into video payloads
 */
export class ReferenceImageManager {
    private db: DatabaseManager;
    private flowRegistry: FlowApiRegistry;

    constructor(db: DatabaseManager, flowRegistry: FlowApiRegistry) {
        this.db = db;
        this.flowRegistry = flowRegistry;
    }

    /**
     * Collect all unique reference images from a set of scenes.
     * Supports:
     *  - entity references (characters from entity library)
     *  - explicit image paths in scene data
     *  - environment/background images
     */
    collectReferenceImages(scenes: Array<Record<string, any>>): ReferenceImageTarget[] {
        const seen = new Set<string>();
        const targets: ReferenceImageTarget[] = [];

        for (const scene of scenes) {
            // 1. Entity character references
            const characters: string[] = Array.isArray(scene.characters) ? scene.characters : [];
            for (const charName of characters) {
                const entity = this.findEntityByName(String(charName));
                if (entity && entity.localPath && !seen.has(entity.id)) {
                    seen.add(entity.id);
                    targets.push({
                        key: entity.id,
                        localPath: entity.localPath,
                        name: entity.name,
                        mimeType: this.inferMimeType(entity.localPath),
                    });
                }
            }

            // 2. Explicit reference_image_paths in scene
            const refPaths: string[] = Array.isArray(scene.reference_image_paths)
                ? scene.reference_image_paths
                : [];
            for (const p of refPaths) {
                const resolved = this.resolveImagePath(String(p));
                if (resolved && !seen.has(resolved)) {
                    seen.add(resolved);
                    targets.push({
                        key: resolved,
                        localPath: resolved,
                        mimeType: this.inferMimeType(resolved),
                    });
                }
            }

            // 3. Direct reference_image_url or imageUrl in scene
            const refUrl = scene.reference_image_url || scene.imageUrl;
            if (refUrl && typeof refUrl === 'string' && !seen.has(refUrl)) {
                seen.add(refUrl);
                targets.push({
                    key: refUrl,
                    localPath: refUrl,
                    mimeType: this.inferMimeType(refUrl),
                });
            }

            // 4. Environment / background image
            const envPath = scene.environment_image || scene.background_image;
            if (envPath && typeof envPath === 'string' && !seen.has(envPath)) {
                seen.add(envPath);
                targets.push({
                    key: envPath,
                    localPath: envPath,
                    name: 'environment',
                    mimeType: this.inferMimeType(envPath),
                });
            }
        }

        logger.info(`[ReferenceImageManager] Collected ${targets.length} unique reference images`);
        return targets;
    }

    /**
     * Upload all reference images to all specified profiles.
     * Returns a map: { imageKey -> { profileId -> { mediaId, uploadedAt } } }
     */
    async uploadAll(targets: ReferenceImageTarget[], profileIds: string[], projectId: string): Promise<UploadAllResult> {
        const results: UploadResult[] = [];
        const mediaMap: ProfileMediaMap = {};
        const successfulKeys = new Set<string>();
        const failedKeys = new Set<string>();

        for (const target of targets) {
            for (const profileId of profileIds) {
                if (!mediaMap[profileId]) {
                    mediaMap[profileId] = {};
                }

                const result = await this.uploadToProfile(target, profileId, projectId);
                results.push(result);

                if (result.success && result.mediaId) {
                    mediaMap[profileId][target.key] = {
                        mediaId: result.mediaId,
                        uploadedAt: new Date().toISOString(),
                    };
                    successfulKeys.add(target.key);
                } else {
                    failedKeys.add(target.key);
                }
            }
        }

        return {
            totalImages: targets.length,
            totalProfiles: profileIds.length,
            results,
            mediaMap,
            successfulUploads: Array.from(successfulKeys),
            failedImages: Array.from(failedKeys),
        };
    }

    /**
     * Upload a single reference image to a single profile.
     */
    async uploadToProfile(target: ReferenceImageTarget, profileId: string, projectId: string): Promise<UploadResult> {
        const flowClient = this.flowRegistry.getOrCreate(profileId);

        if (!flowClient.hasFlowKey()) {
            return { success: false, imageKey: target.key, profileId, error: 'No flow key' };
        }

        // Resolve and read file
        const filePath = this.resolveImagePath(target.localPath);
        if (!filePath || !fs.existsSync(filePath)) {
            return { success: false, imageKey: target.key, profileId, error: `File not found: ${target.localPath}` };
        }

        try {
            const fileBuffer = fs.readFileSync(filePath);
            const base64 = fileBuffer.toString('base64');
            const mimeType = target.mimeType || this.inferMimeType(filePath);
            const fileName = path.basename(filePath);

            const result = await flowClient.uploadImage(base64, mimeType, projectId, fileName);
            const mediaId = String(result?.mediaId || result?.id || result?.result?.mediaId || '');

            if (!mediaId) {
                return { success: false, imageKey: target.key, profileId, error: 'No mediaId returned' };
            }

            logger.info(`[ReferenceImageManager] Uploaded ${target.key} to profile ${profileId}: ${mediaId}`);
            return { success: true, imageKey: target.key, profileId, mediaId };
        } catch (err) {
            const error = String(err instanceof Error ? err.message : err);
            logger.warn(`[ReferenceImageManager] Upload failed for ${target.key} -> ${profileId}: ${error}`);
            return { success: false, imageKey: target.key, profileId, error };
        }
    }

    /**
     * Get the mediaId for a specific image and profile from the upload result.
     */
    getMediaId(mediaMap: ProfileMediaMap, imageKey: string, profileId: string): string | null {
        return mediaMap[profileId]?.[imageKey]?.mediaId || null;
    }

    /**
     * Build reference media IDs for a scene based on its character/image references
     * and the uploaded media map.
     */
    buildSceneReferences(
        scene: Record<string, any>,
        mediaMap: ProfileMediaMap,
        profileId: string,
        _db: DatabaseManager
    ): { referenceMediaIds: string[]; startImageMediaId?: string; endImageMediaId?: string } {
        const referenceMediaIds: string[] = [];

        // Character entities - resolve via entity library if db is available
        // Fallback: try to use character name as direct entity ID in mediaMap
        const characters: string[] = Array.isArray(scene.characters) ? scene.characters : [];
        for (const charName of characters) {
            let entityId: string | null = null;
            if (this.db) {
                const entity = this.findEntityByName(String(charName));
                entityId = entity?.id || null;
            } else {
                // Fallback: use character name/slug as entity ID
                const slug = String(charName).trim().toLowerCase().replace(/\s+/g, '-');
                const mediaId = this.getMediaId(mediaMap, slug, profileId);
                if (mediaId) {
                    referenceMediaIds.push(mediaId);
                    continue;
                }
                entityId = slug;
            }
            if (entityId) {
                const mediaId = this.getMediaId(mediaMap, entityId, profileId);
                if (mediaId) referenceMediaIds.push(mediaId);
            }
        }

        // Explicit reference paths (can be file paths OR entity IDs)
        const refPaths: string[] = Array.isArray(scene.reference_image_paths)
            ? scene.reference_image_paths
            : [];
        for (const p of refPaths) {
            const resolved = this.resolveImagePath(String(p));
            if (resolved) {
                const mediaId = this.getMediaId(mediaMap, resolved, profileId);
                if (mediaId) referenceMediaIds.push(mediaId);
            } else {
                // Not a file path - treat as entity ID / image key directly
                const mediaId = this.getMediaId(mediaMap, String(p), profileId);
                if (mediaId) referenceMediaIds.push(mediaId);
            }
        }

        // Environment / background image
        const envPath = scene.environment_image || scene.background_image;
        if (envPath) {
            const resolved = this.resolveImagePath(String(envPath));
            if (resolved) {
                const mediaId = this.getMediaId(mediaMap, resolved, profileId);
                if (mediaId) referenceMediaIds.push(mediaId);
            } else {
                const mediaId = this.getMediaId(mediaMap, String(envPath), profileId);
                if (mediaId) referenceMediaIds.push(mediaId);
            }
        }

        // Start/end image for video
        const startImageKey = scene.start_image_key || scene.startImageKey;
        const endImageKey = scene.end_image_key || scene.endImageKey;

        const startImageMediaId = startImageKey
            ? this.getMediaId(mediaMap, String(startImageKey), profileId) || undefined
            : undefined;
        const endImageMediaId = endImageKey
            ? this.getMediaId(mediaMap, String(endImageKey), profileId) || undefined
            : undefined;

        return { referenceMediaIds, startImageMediaId, endImageMediaId };
    }

    /**
     * Save the media map to the pipeline output folder for persistence.
     */
    saveMediaMap(mediaMap: ProfileMediaMap, outputFolder: string): string {
        const filePath = path.join(outputFolder, 'media_map.json');
        fs.mkdirSync(outputFolder, { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(mediaMap, null, 2), 'utf-8');
        logger.info(`[ReferenceImageManager] Saved media map to ${filePath}`);
        return filePath;
    }

    /**
     * Load a saved media map from the output folder.
     */
    loadMediaMap(outputFolder: string): ProfileMediaMap | null {
        const filePath = path.join(outputFolder, 'media_map.json');
        if (!fs.existsSync(filePath)) return null;
        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        } catch {
            return null;
        }
    }

    // ---- Private helpers ----

    private findEntityByName(name: string): EntityReferenceRecord | null {
        if (!this.db) return null;
        const lowered = String(name).trim().toLowerCase();
        const candidates = this.db.getEntityReferencesByProfile('');
        const exact = candidates.find(e => String(e.name).trim().toLowerCase() === lowered);
        if (exact) return exact;
        return candidates.find(e =>
            String(e.name).trim().toLowerCase().includes(lowered) ||
            String(e.description || '').toLowerCase().includes(lowered)
        ) || null;
    }

    private resolveImagePath(p: string): string | null {
        if (!p) return null;
        // Already absolute and exists
        if (fs.existsSync(p)) return p;
        // Relative to cwd
        const cwdPath = path.join(process.cwd(), p);
        if (fs.existsSync(cwdPath)) return cwdPath;
        // Try data folder
        const dataPath = path.join(process.cwd(), 'data', p);
        if (fs.existsSync(dataPath)) return dataPath;
        return null;
    }

    private inferMimeType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const map: Record<string, string> = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp',
            '.gif': 'image/gif',
            '.bmp': 'image/bmp',
        };
        return map[ext] || 'image/jpeg';
    }
}
