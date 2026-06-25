import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseManager, VideoPipelineRecord, SceneTaskRecord } from '../database/Database';
import { PipelineManager } from './PipelineManager';
import { EntityResolver } from './EntityResolver';
import { VideoAssembler } from './VideoAssembler';
import { OutputFormatter } from './OutputFormatter';
import { ReferenceImageManager, ProfileMediaMap } from './ReferenceImageManager';
import { VideoFinalizeRunner } from '../server/services/VideoFinalizeRunner';
import { FlowApiRegistry } from '../flow-api/FlowApiRegistry';
import { BrowserManager } from '../browser-manager/BrowserManager';
import logger from '../utils/logger';

export interface WorkerOptions {
    profileId: string;
    pipelineId: string;
    flowRegistry: FlowApiRegistry;
    browserManager: BrowserManager;
    db: DatabaseManager;
    pipelineManager: PipelineManager;
    entityResolver: EntityResolver;
    referenceManager?: ReferenceImageManager;
    /** Pre-uploaded media map from ReferenceImageManager.uploadAll() */
    mediaMap?: ProfileMediaMap;
}

export interface SceneResult {
    ok: boolean;
    imagePath?: string;
    videoPath?: string;
    error?: string;
}

const DEFAULT_WORKER_SLEEP_MS = 1000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 3000;

// Helper to check if error is retryable
function isRetryableError(error: string): boolean {
    const err = error.toLowerCase();
    return err.includes('403') || 
           err.includes('captcha') || 
           err.includes('blocked') || 
           err.includes('verify') ||
           err.includes('human') ||
           err.includes('rate limit') ||
           err.includes('429') ||
           err.includes('timeout') ||
           err.includes('network') ||
           err.includes('econnreset') ||
           err.includes('html') ||
           err.includes('<!doctype') ||
           err.includes('econnrefused') ||
           err.includes('etimedout') ||
           err.includes('empty') ||
           err.includes('no downloadable');
}

export class VideoWorker {
    private profileId: string;
    private pipelineId: string;
    private flowRegistry: FlowApiRegistry;
    private browserManager: BrowserManager;
    private db: DatabaseManager;
    private pipelineManager: PipelineManager;
    private entityResolver: EntityResolver;
    private referenceManager?: ReferenceImageManager;
    private mediaMap?: ProfileMediaMap;

    private running = false;
    private currentTaskId: string | null = null;

    constructor(options: WorkerOptions) {
        this.profileId = options.profileId;
        this.pipelineId = options.pipelineId;
        this.flowRegistry = options.flowRegistry;
        this.browserManager = options.browserManager;
        this.db = options.db;
        this.pipelineManager = options.pipelineManager;
        this.entityResolver = options.entityResolver;
        this.referenceManager = options.referenceManager;
        this.mediaMap = options.mediaMap;
    }

    isRunning(): boolean {
        return this.running;
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        logger.info(`[VideoWorker] Start worker profile=${this.profileId} pipeline=${this.pipelineId}`);

        try {
            await this.runLoop();
        } catch (err) {
            logger.error(`[VideoWorker] Worker error profile=${this.profileId}: ${String(err)}`);
        } finally {
            this.running = false;
            this.currentTaskId = null;
            logger.info(`[VideoWorker] Stop worker profile=${this.profileId}`);
        }
    }

    stop(): void {
        this.running = false;
        logger.info(`[VideoWorker] Stop requested profile=${this.profileId}`);
    }

    private async runLoop(): Promise<void> {
        while (this.running) {
            const pipeline = this.db.getVideoPipeline(this.pipelineId);
            if (!pipeline) {
                logger.warn(`[VideoWorker] Pipeline ${this.pipelineId} not found`);
                break;
            }

            if (['paused', 'failed'].includes(pipeline.status)) {
                await this.sleep(DEFAULT_WORKER_SLEEP_MS * 3);
                continue;
            }

            const task = this.pipelineManager.getNextTaskForProfile(this.profileId, this.pipelineId);
            if (!task) {
                const allTasks = this.db.getSceneTasksByPipeline(this.pipelineId);
                const allDone = allTasks.every(t => ['completed', 'failed'].includes(t.status));
                if (allDone) {
                    await this.finalizePipeline(pipeline, allTasks);
                    break;
                }
                await this.sleep(DEFAULT_WORKER_SLEEP_MS);
                continue;
            }

            try {
                this.currentTaskId = task.id;
                await this.processScene(task, pipeline);
            } catch (err) {
                const error = String(err instanceof Error ? err.message : err);
                logger.error(`[VideoWorker] Task ${task.sceneIndex} failed for profile ${this.profileId}: ${error}`);
                this.db.updateSceneTask(task.id, {
                    status: 'failed',
                    error,
                });
                this.pipelineManager.updatePipelineStats(this.pipelineId);

                if (this.isCaptchaError(error)) {
                    logger.warn(`[VideoWorker] Captcha detected for task ${task.sceneIndex}, pipeline paused for resolution`);
                }
            } finally {
                this.currentTaskId = null;
            }
        }
    }

    private isCaptchaError(error: string): boolean {
        const lowered = error.toLowerCase();
        return lowered.includes('captcha') || lowered.includes('verify you are human') || lowered.includes('blocked');
    }

    private async processScene(task: SceneTaskRecord, pipeline: VideoPipelineRecord): Promise<void> {
        this.db.updateSceneTask(task.id, { status: 'generating', progress: 5 });
        this.pipelineManager.updatePipelineStats(this.pipelineId);

        const sceneData = this.safeJson(task.sceneData, {});
        const outputDir = this.sceneOutputDir(pipeline.outputFolder, task.sceneIndex);
        fs.mkdirSync(outputDir, { recursive: true });

        const flowClient = this.flowRegistry.getOrCreate(this.profileId);
        if (!flowClient || !flowClient.hasFlowKey()) {
            throw new Error('Flow key missing for profile. Please login in browser first.');
        }

        const visualPrompt = String(sceneData?.visual_prompt || sceneData?.prompt || '').trim();
        const ttsScript = String(sceneData?.tts_script || sceneData?.narration || '').trim();
        let prompt = visualPrompt;
        if (ttsScript) {
            const sceneCharacters = Array.isArray(sceneData?.characters) ? sceneData.characters : [];
            if (sceneCharacters.length > 0) {
                const character = sceneCharacters[0];
                prompt = `${visualPrompt}\n${character} say: "${ttsScript}"`;
            } else {
                prompt = `${visualPrompt}\nNarration say: "${ttsScript}"`;
            }
        }
        if (!prompt) {
            throw new Error('Scene prompt is empty');
        }

        const profile = this.db.getProfile(this.profileId);
        const tier = (profile?.metadata as any)?.tier || 'PAYGATE_TIER_TWO';
        let config: any = {};
        try {
            if (pipeline.config) {
                config = JSON.parse(pipeline.config);
            }
        } catch {
            logger.warn(`[VideoWorker] Invalid config JSON for pipeline ${this.pipelineId}`);
        }
        const modelKey = String(config.defaultModel || 'veo_3_1');
        const aspectRatio = String(config.defaultAspectRatio || 'VIDEO_ASPECT_RATIO_PORTRAIT');

        // Build scene references from pre-uploaded media map
        let startImageMediaId: string | undefined;
        let endImageMediaId: string | undefined;
        let referenceMediaIds: string[] = [];

        if (this.referenceManager && this.mediaMap) {
            const refs = this.referenceManager.buildSceneReferences(sceneData, this.mediaMap, this.profileId, this.db);
            referenceMediaIds = refs.referenceMediaIds;
            startImageMediaId = refs.startImageMediaId;
            endImageMediaId = refs.endImageMediaId;
        }

        // Fallback: try entityResolver for character images
        if (!startImageMediaId && referenceMediaIds.length === 0) {
            const entityMappings = await this.entityResolver.resolveSceneEntities(sceneData, this.profileId);
            if (entityMappings.length > 0 && entityMappings[0].entity) {
                const firstEntity = entityMappings[0];
                startImageMediaId = firstEntity.entity.mediaId || undefined;
                // Add all character mediaIds as references
                referenceMediaIds = entityMappings
                    .map(m => m.entity?.mediaId)
                    .filter(Boolean) as string[];
            }
        }

        this.db.updateSceneTask(task.id, { progress: 15 });
        this.pipelineManager.updatePipelineStats(this.pipelineId);

        // Retry loop for video generation
        let lastError: string = '';
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            try {
                if (attempt > 0) {
                    logger.info(`[VideoWorker] Retry attempt ${attempt}/${MAX_RETRIES} for scene ${task.sceneIndex}`);
                    this.db.updateSceneTask(task.id, { 
                        progress: 15,
                        error: `Retry ${attempt}/${MAX_RETRIES}: ${lastError}`
                    });
                    // Exponential backoff delay
                    await this.sleep(RETRY_BASE_DELAY_MS * attempt);
                }

                const videoResult = await flowClient.generateVideo({
                    prompt,
                    projectId: pipeline.projectId || pipeline.id,
                    sceneId: `${task.sceneIndex}-attempt-${attempt}`,
                    aspectRatio,
                    userPaygateTier: tier,
                    videoModelKey: modelKey,
                    startImageMediaId,
                    endImageMediaId,
                    referenceAudio: referenceMediaIds.length > 0
                        ? referenceMediaIds.map(mediaId => ({ mediaId }))
                        : undefined,
                });

                this.db.updateSceneTask(task.id, { progress: 55 });
                this.pipelineManager.updatePipelineStats(this.pipelineId);

                const operations = Array.isArray((videoResult as any)?.operations)
                    ? ((videoResult as any).operations as any[])
                    : [];

                let videoStatus: any = null;
                let statusError: string | null = null;
                try {
                    videoStatus = await flowClient.checkVideoStatus(operations);
                } catch (err) {
                    statusError = String(err);
                    logger.warn(`[VideoWorker] checkVideoStatus failed for task ${task.sceneIndex}: ${statusError}`);
                }

                // Check if video status indicates failure
                const hasFailedStatus = videoStatus && (
                    (Array.isArray(videoStatus.media) && videoStatus.media.some((m: any) => m.status === 'FAILED')) ||
                    (Array.isArray(videoStatus.operations) && videoStatus.operations.some((o: any) => o.status === 'FAILED'))
                );

                if (hasFailedStatus && attempt < MAX_RETRIES) {
                    lastError = 'Video status indicates failure, will retry';
                    continue; // Retry
                }

                const downloadedPath = await this.downloadResultVideo(videoStatus, outputDir, task.sceneIndex, pipeline.projectId || pipeline.id);

                if (!downloadedPath && attempt < MAX_RETRIES) {
                    lastError = 'Video generation finished but no downloadable result was found';
                    continue; // Retry
                }

                if (!downloadedPath) {
                    throw new Error('Video generation finished but no downloadable result was found');
                }

                // Success!
                const videoUrl = this.relativePath(pipeline.outputFolder, downloadedPath);
                let imagePath: string | undefined;

                if (this.referenceManager && this.mediaMap) {
                    const firstRef = referenceMediaIds[0];
                    if (firstRef) {
                        imagePath = await this.entityResolver.downloadEntityImage(firstRef, outputDir) || undefined;
                    }
                }

                this.db.updateSceneTask(task.id, {
                    status: 'completed',
                    videoUrl,
                    imageUrl: imagePath || '',
                    progress: 100,
                    error: undefined,
                });

                this.pipelineManager.updatePipelineStats(this.pipelineId);
                return; // Exit retry loop on success

            } catch (err) {
                lastError = err instanceof Error ? err.message : String(err);
                
                // Check if error is retryable
                if (isRetryableError(lastError) && attempt < MAX_RETRIES) {
                    logger.warn(`[VideoWorker] Retryable error for scene ${task.sceneIndex} (attempt ${attempt + 1}/${MAX_RETRIES}): ${lastError}`);
                    continue; // Retry
                }
                
                // Non-retryable error or max retries exceeded
                throw new Error(lastError);
            }
        }

        // Should not reach here, but just in case
        throw new Error(lastError || 'Max retries exceeded');
    }

    private async downloadResultVideo(videoStatus: any, outputDir: string, sceneIndex: number, projectId: string): Promise<string | null> {
        const target = path.join(outputDir, `scene_${String(sceneIndex).padStart(3, '0')}.mp4`);
        try {
            const media = Array.isArray(videoStatus?.media) ? videoStatus.media : [];
            const first = media.find((m: any) => m?.videoUrl || m?.downloadUrl || m?.servingUri) || media[0];
            if (!first) return null;

            const videoUrl = first.videoUrl || first.downloadUrl || first.servingUri || null;
            if (!videoUrl) return null;

            fs.mkdirSync(outputDir, { recursive: true });
            await this.saveUrlToFile(videoUrl, target);
            return target;
        } catch (err) {
            logger.warn(`[VideoWorker] downloadResultVideo failed: ${String(err)}`);
            return null;
        }
    }

    private async finalizePipeline(pipeline: VideoPipelineRecord, tasks: SceneTaskRecord[]): Promise<void> {
        const completed = tasks.filter(t => t.status === 'completed').length;
        const failed = tasks.filter(t => t.status === 'failed').length;

        this.db.updateVideoPipeline(pipeline.id, {
            status: failed > 0 && completed === 0 ? 'failed' : 'completed',
            completedScenes: completed,
            failedScenes: failed,
            errorMessage: failed > 0 ? `${failed} failed scenes` : '',
        });

        // Save per-scene metadata
        const scenesDir = path.join(pipeline.outputFolder, 'scenes');
        for (const task of tasks) {
            const sceneDir = this.sceneOutputDir(pipeline.outputFolder, task.sceneIndex);
            const sceneData = this.safeJson(task.sceneData, {});
            const sceneMeta = {
                sceneIndex: task.sceneIndex,
                status: task.status,
                videoUrl: task.videoUrl || undefined,
                imageUrl: task.imageUrl || undefined,
                error: task.error || undefined,
                progress: task.progress,
                generatedAt: task.completedAt || undefined,
                prompt: String(sceneData?.visual_prompt || sceneData?.prompt || ''),
                ttsScript: String(sceneData?.tts_script || sceneData?.narration || ''),
                characters: sceneData?.characters || [],
            };
            const metaPath = path.join(sceneDir, 'metadata.json');
            fs.mkdirSync(sceneDir, { recursive: true });
            fs.writeFileSync(metaPath, JSON.stringify(sceneMeta, null, 2), 'utf-8');
        }

        // Save JSON output
        const formatter = new OutputFormatter();
        const completedVideos = tasks
            .filter(t => t.status === 'completed' && t.videoUrl)
            .map(t => path.join(pipeline.outputFolder, t.videoUrl))
            .filter(p => fs.existsSync(p))
            .sort((a, b) => a.localeCompare(b));
        const finalVideoPath = completedVideos.length >= 1
            ? `final/${path.basename(completedVideos[0])}`
            : undefined;
        formatter.save(pipeline, tasks, pipeline.outputFolder, { final_video_path: finalVideoPath });
        this.pipelineManager.savePipelineJson(pipeline.id);

        // Save media map if available
        if (this.referenceManager && this.mediaMap) {
            this.referenceManager.saveMediaMap(this.mediaMap, pipeline.outputFolder);
        }

        try {
            const finalizeRunner = new VideoFinalizeRunner(this.db);
            await finalizeRunner.run({ pipeline, tasks });
            logger.info(`[VideoWorker] Final assemble completed for pipeline ${pipeline.id}`);
        } catch (err) {
            logger.warn(`[VideoWorker] Final assemble skipped/failed: ${String(err)}`);
        }

        logger.info(`[VideoWorker] Pipeline finalized ${pipeline.id}: ${completed}/${tasks.length} scenes`);
    }

    private sceneOutputDir(outputFolder: string, sceneIndex: number): string {
        return path.join(outputFolder, 'scenes', `scene_${String(sceneIndex).padStart(3, '0')}`);
    }

    private relativePath(fromDir: string, filePath: string): string {
        const rel = path.relative(fromDir, filePath);
        return rel.split(path.sep).join('/');
    }

    private async saveUrlToFile(url: string, dest: string): Promise<void> {
        const https = await import('https');
        const http = await import('http');
        const { promisify } = await import('util');

        return new Promise((resolve, reject) => {
            const req = (url.startsWith('https') ? https : http).get(url, (response: any) => {
                const stream = require('fs').createWriteStream(dest);
                response.pipe(stream);
                stream.on('finish', () => {
                    stream.close();
                    resolve();
                });
            });
            req.on('error', (err: any) => {
                try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
                reject(err);
            });
        });
    }

    private safeJson(raw: string, fallback: any): any {
        try { return JSON.parse(raw); } catch { return fallback; }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
