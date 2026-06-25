import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { DatabaseManager, VideoPipelineRecord, SceneTaskRecord } from '../database/Database';
import logger from '../utils/logger';

export interface PipelineConfig {
    autoGenerateImage?: boolean;
    useEntityReference?: boolean;
    upscaleAfterGenerate?: boolean;
    assembleVideo?: boolean;
    defaultModel?: string;
    defaultDuration?: string;
    defaultAspectRatio?: string;
    smartDistribution?: boolean; // ưu tiên profile nhiều credits
    maxRetries?: number;
    retryDelayMs?: number;
}

export interface PipelineStatus {
    pipelineId: string;
    status: string;
    totalScenes: number;
    completedScenes: number;
    failedScenes: number;
    progress: number;
    scenes: SceneStatus[];
}

export interface SceneStatus {
    sceneIndex: number;
    status: string;
    imageUrl?: string;
    videoUrl?: string;
    error?: string;
    assignedProfileId?: string;
}

export interface CreatePipelineOptions {
    name: string;
    projectId?: string;
    scriptId: string;
    selectedProfileIds: string[];
    outputFolder: string;
    config?: PipelineConfig;
    scenes: Array<{
        sceneIndex: number;
        sceneData: any;
    }>;
}

export interface ProfileCredits {
    profileId: string;
    credits: number;
}

export class PipelineManager {
    private db: DatabaseManager;

    constructor(db: DatabaseManager) {
        this.db = db;
    }

    createPipeline(options: CreatePipelineOptions): VideoPipelineRecord {
        const pipelineId = uuidv4();
        const now = new Date().toISOString();

        // Create output directory with error handling
        try {
            if (!fs.existsSync(options.outputFolder)) {
                fs.mkdirSync(options.outputFolder, { recursive: true });
            }
        } catch (err) {
            logger.error(`[PipelineManager] Failed to create output folder: ${options.outputFolder}`, err);
            throw new Error(`Failed to create output folder: ${options.outputFolder}`);
        }

        const pipeline: Omit<VideoPipelineRecord, 'createdAt' | 'updatedAt'> = {
            id: pipelineId,
            name: options.name,
            projectId: options.projectId || null,
            scriptId: options.scriptId,
            profileIds: JSON.stringify(options.selectedProfileIds),
            status: 'pending',
            config: JSON.stringify(options.config || {}),
            totalScenes: options.scenes.length,
            completedScenes: 0,
            failedScenes: 0,
            outputFolder: options.outputFolder,
            errorMessage: '',
        };

        const createdPipeline = this.db.createVideoPipeline(pipeline);

        const tasks: Omit<SceneTaskRecord, 'startedAt' | 'completedAt'>[] = options.scenes.map((scene) => ({
            id: uuidv4(),
            pipelineId: pipelineId,
            sceneIndex: scene.sceneIndex,
            sceneData: JSON.stringify(scene.sceneData),
            status: 'pending',
            assignedProfileId: '',
            imageUrl: '',
            videoUrl: '',
            characterRefs: '{}',
            progress: 0,
            error: '',
        }));

        this.db.createSceneTasks(tasks);

        logger.info(`[PipelineManager] Created pipeline ${pipelineId} with ${tasks.length} scenes`);
        return createdPipeline;
    }

    getPipeline(pipelineId: string): VideoPipelineRecord | undefined {
        return this.db.getVideoPipeline(pipelineId);
    }

    getAllPipelines(): VideoPipelineRecord[] {
        return this.db.getAllVideoPipelines();
    }

    getPipelineStatus(pipelineId: string): PipelineStatus | null {
        const pipeline = this.db.getVideoPipeline(pipelineId);
        if (!pipeline) return null;

        const tasks = this.db.getSceneTasksByPipeline(pipelineId);

        const scenes: SceneStatus[] = tasks.map((task) => ({
            sceneIndex: task.sceneIndex,
            status: task.status,
            imageUrl: task.imageUrl || undefined,
            videoUrl: task.videoUrl || undefined,
            error: task.error || undefined,
            assignedProfileId: task.assignedProfileId || undefined,
        }));

        const progress = pipeline.totalScenes > 0
            ? Math.round(((pipeline.completedScenes + pipeline.failedScenes) / pipeline.totalScenes) * 100)
            : 0;

        return {
            pipelineId,
            status: pipeline.status,
            totalScenes: pipeline.totalScenes,
            completedScenes: pipeline.completedScenes,
            failedScenes: pipeline.failedScenes,
            progress,
            scenes,
        };
    }

    distributeTasks(pipelineId: string, profileCredits?: ProfileCredits[]): void {
        const pipeline = this.db.getVideoPipeline(pipelineId);
        if (!pipeline) {
            logger.error(`[PipelineManager] Pipeline ${pipelineId} not found`);
            return;
        }

        let profileIds: string[] = [];
        try {
            profileIds = JSON.parse(pipeline.profileIds);
        } catch {
            logger.warn(`[PipelineManager] Invalid profileIds JSON for pipeline ${pipelineId}`);
        }
        if (profileIds.length === 0) {
            logger.error(`[PipelineManager] No profiles assigned to pipeline ${pipelineId}`);
            return;
        }

        const tasks = this.db.getSceneTasksByPipeline(pipelineId);
        const pendingTasks = tasks.filter(t => t.status === 'pending');

        if (pendingTasks.length === 0) return;

        let distribution: Map<string, SceneTaskRecord[]>;

        if (profileCredits && profileCredits.length > 0 && pendingTasks.length > 1) {
            distribution = this.distributeByCredits(pendingTasks, profileIds, profileCredits);
        } else {
            distribution = this.distributeRoundRobin(pendingTasks, profileIds);
        }

        for (const [assignedProfileId, assignedTasks] of distribution) {
            for (const task of assignedTasks) {
                this.db.updateSceneTask(task.id, {
                    assignedProfileId,
                    status: 'assigned',
                });
                logger.debug(`[PipelineManager] Assigned scene ${task.sceneIndex} to profile ${assignedProfileId}`);
            }
        }

        logger.info(`[PipelineManager] Distributed ${pendingTasks.length} tasks across ${profileIds.length} profiles`);
    }

    private distributeRoundRobin(tasks: SceneTaskRecord[], profileIds: string[]): Map<string, SceneTaskRecord[]> {
        const distribution = new Map<string, SceneTaskRecord[]>();
        profileIds.forEach(id => distribution.set(id, []));

        tasks.forEach((task, index) => {
            const profileIdx = index % profileIds.length;
            const profileId = profileIds[profileIdx];
            distribution.get(profileId)!.push(task);
        });

        return distribution;
    }

    private distributeByCredits(tasks: SceneTaskRecord[], profileIds: string[], profileCredits: ProfileCredits[]): Map<string, SceneTaskRecord[]> {
        const distribution = new Map<string, SceneTaskRecord[]>();
        profileIds.forEach(id => distribution.set(id, []));

        const creditsMap = new Map<string, number>();
        profileIds.forEach(id => {
            const found = profileCredits.find(c => c.profileId === id);
            creditsMap.set(id, found?.credits ?? 0);
        });

        const sortedProfiles = profileIds.sort((a, b) => (creditsMap.get(b) ?? 0) - (creditsMap.get(a) ?? 0));
        const totalCredits = Array.from(creditsMap.values()).reduce((sum, c) => sum + c, 0) || 1;

        let profileIdx = 0;
        let remainingTasks = [...tasks];

        while (remainingTasks.length > 0) {
            const profileId = sortedProfiles[profileIdx % sortedProfiles.length];
            const credits = creditsMap.get(profileId) ?? 0;
            const shareRatio = credits / totalCredits;
            const baseShare = Math.floor(tasks.length * shareRatio);
            const extraShare = (credits / totalCredits * 1000) % 1 >= (profileIdx % 1000) / 1000 ? 1 : 0;
            const targetCount = baseShare + extraShare;

            const currentAssigned = distribution.get(profileId)!.length;
            const toAssign = Math.min(remainingTasks.length, Math.max(1, targetCount - currentAssigned));

            if (currentAssigned >= targetCount && remainingTasks.length > 0) {
                profileIdx++;
                continue;
            }

            for (let i = 0; i < toAssign && remainingTasks.length > 0; i++) {
                const task = remainingTasks.shift()!;
                distribution.get(profileId)!.push(task);
            }

            profileIdx++;
        }

        return distribution;
    }

    getNextTaskForProfile(profileId: string, pipelineId: string): SceneTaskRecord | undefined {
        let task = this.db.getSceneTaskForProfile(profileId, pipelineId);

        if (!task) {
            task = this.db.getNextPendingTaskForProfile(profileId, pipelineId);
            if (task) {
                this.db.updateSceneTask(task.id, {
                    assignedProfileId: profileId,
                    status: 'assigned',
                });
                logger.debug(`[PipelineManager] Profile ${profileId} claimed scene ${task.sceneIndex}`);
            }
        }

        return task;
    }

    updateTaskStatus(
        taskId: string,
        update: {
            status?: 'pending' | 'assigned' | 'generating' | 'completed' | 'failed';
            imageUrl?: string;
            videoUrl?: string;
            progress?: number;
            error?: string;
        }
    ): void {
        this.db.updateSceneTask(taskId, update as any);

        const task = this.db.getSceneTask(taskId);
        if (task) {
            this.updatePipelineStats(task.pipelineId);
        }
    }

    updatePipelineStats(pipelineId: string): void {
        const tasks = this.db.getSceneTasksByPipeline(pipelineId);

        const completedScenes = tasks.filter(t => t.status === 'completed').length;
        const failedScenes = tasks.filter(t => t.status === 'failed').length;
        const hasCaptcha = tasks.some(t => t.status === 'failed' && this.isCaptchaError(t.error));

        let pipelineStatus: 'pending' | 'processing' | 'paused' | 'completed' | 'failed' = 'processing';
        const totalDone = completedScenes + failedScenes;

        if (hasCaptcha) {
            pipelineStatus = 'paused';
        } else if (totalDone === 0) {
            pipelineStatus = 'pending';
        } else if (totalDone === tasks.length) {
            pipelineStatus = failedScenes === tasks.length ? 'failed' : 'completed';
        }

        this.db.updateVideoPipeline(pipelineId, {
            completedScenes,
            failedScenes,
            status: pipelineStatus,
        });
    }

    private isCaptchaError(error?: string): boolean {
        if (!error) return false;
        const lowered = error.toLowerCase();
        return lowered.includes('captcha') || lowered.includes('verify you are human') || lowered.includes('blocked');
    }

    startPipeline(pipelineId: string, profileCredits?: ProfileCredits[]): boolean {
        const pipeline = this.db.getVideoPipeline(pipelineId);
        if (!pipeline) return false;

        this.distributeTasks(pipelineId, profileCredits);
        this.db.updateVideoPipeline(pipelineId, { status: 'processing' });

        logger.info(`[PipelineManager] Started pipeline ${pipelineId}`);
        return true;
    }

    pausePipeline(pipelineId: string): boolean {
        const pipeline = this.db.getVideoPipeline(pipelineId);
        if (!pipeline) return false;

        this.db.updateVideoPipeline(pipelineId, { status: 'paused' });

        const tasks = this.db.getSceneTasksByPipeline(pipelineId);
        tasks.forEach(task => {
            if (task.status === 'assigned' || task.status === 'generating') {
                this.db.updateSceneTask(task.id, {
                    status: 'pending',
                    assignedProfileId: '',
                });
            }
        });

        logger.info(`[PipelineManager] Paused pipeline ${pipelineId}`);
        return true;
    }

    stopPipeline(pipelineId: string): boolean {
        const pipeline = this.db.getVideoPipeline(pipelineId);
        if (!pipeline) return false;

        this.db.updateVideoPipeline(pipelineId, { status: 'failed', errorMessage: 'Stopped by user' });

        const tasks = this.db.getSceneTasksByPipeline(pipelineId);
        tasks.forEach(task => {
            if (task.status === 'generating') {
                this.db.updateSceneTask(task.id, {
                    status: 'failed',
                    error: 'Pipeline stopped by user',
                });
            }
        });

        logger.info(`[PipelineManager] Stopped pipeline ${pipelineId}`);
        return true;
    }

    retryFailedTasks(pipelineId: string, taskIds?: string[]): number {
        const tasks = this.db.getSceneTasksByPipeline(pipelineId);
        const pipeline = this.db.getVideoPipeline(pipelineId);
        let config: PipelineConfig = {};
        try {
            if (pipeline?.config) {
                config = JSON.parse(pipeline.config);
            }
        } catch {
            logger.warn(`[PipelineManager] Invalid config JSON for pipeline ${pipelineId}`);
        }
        const maxRetries = config.maxRetries ?? 3;

        let retried = 0;

        for (const task of tasks) {
            if (task.status === 'failed' && (!taskIds || taskIds.includes(task.id))) {
                const retryCount = this.getRetryCount(task.error);
                if (retryCount < maxRetries) {
                    this.db.updateSceneTask(task.id, {
                        status: 'pending',
                        error: this.incrementRetryCount(task.error),
                        assignedProfileId: '',
                    });
                    retried++;
                } else {
                    logger.info(`[PipelineManager] Task ${task.sceneIndex} exceeded max retries (${maxRetries})`);
                }
            }
        }

        if (retried > 0) {
            this.db.updateVideoPipeline(pipelineId, { status: 'processing', errorMessage: '' });
            this.distributeTasks(pipelineId);
        }

        logger.info(`[PipelineManager] Retried ${retried} failed tasks in pipeline ${pipelineId}`);
        return retried;
    }

    private getRetryCount(error?: string): number {
        if (!error) return 0;
        const match = error.match(/retry:(\d+)/i);
        return match ? parseInt(match[1], 10) : 0;
    }

    private incrementRetryCount(error?: string): string {
        const count = this.getRetryCount(error);
        const base = error?.replace(/retry:\d+/gi, '').trim() || 'Unknown error';
        return count === 0 ? `retry:1 - ${base}` : base.replace(/retry:\d+/, `retry:${count + 1}`);
    }

    autoRetryCaptchaErrors(pipelineId: string): number {
        const tasks = this.db.getSceneTasksByPipeline(pipelineId);
        let retried = 0;

        for (const task of tasks) {
            if (task.status === 'failed' && this.isCaptchaError(task.error)) {
                this.db.updateSceneTask(task.id, {
                    status: 'pending',
                    error: 'Captcha resolved - retrying',
                    assignedProfileId: '',
                });
                retried++;
            }
        }

        if (retried > 0) {
            this.db.updateVideoPipeline(pipelineId, { status: 'processing' });
            this.distributeTasks(pipelineId);
            logger.info(`[PipelineManager] Auto-retry ${retried} captcha-affected tasks in pipeline ${pipelineId}`);
        }

        return retried;
    }

    claimNextPendingTask(profileId: string, pipelineId: string): SceneTaskRecord | undefined {
        const pipeline = this.db.getVideoPipeline(pipelineId);
        if (!pipeline || pipeline.status === 'paused' || pipeline.status === 'failed') {
            return undefined;
        }

        const task = this.db.getNextPendingTaskForProfile(profileId, pipelineId);
        if (task) {
            this.db.updateSceneTask(task.id, {
                assignedProfileId: profileId,
                status: 'assigned',
            });
            logger.debug(`[PipelineManager] Profile ${profileId} claimed scene ${task.sceneIndex}`);
        }

        return task;
    }

    deletePipeline(pipelineId: string): boolean {
        this.db.deleteSceneTasksByPipeline(pipelineId);
        const deleted = this.db.deleteVideoPipeline(pipelineId);

        if (deleted) {
            logger.info(`[PipelineManager] Deleted pipeline ${pipelineId}`);
        }

        return deleted;
    }

    savePipelineJson(pipelineId: string): string | null {
        const pipeline = this.db.getVideoPipeline(pipelineId);
        if (!pipeline) return null;

        const status = this.getPipelineStatus(pipelineId);
        if (!status) return null;

        const output: any = {
            pipeline: {
                id: pipeline.id,
                name: pipeline.name,
                status: pipeline.status,
                totalScenes: pipeline.totalScenes,
                completedScenes: pipeline.completedScenes,
                failedScenes: pipeline.failedScenes,
            },
            scenes: status.scenes.map(s => ({
                sceneId: s.sceneIndex.toString(),
                status: s.status,
                imagePath: s.imageUrl,
                videoPath: s.videoUrl,
                error: s.error,
                assignedProfileId: s.assignedProfileId,
            })),
        };

        const jsonPath = path.join(pipeline.outputFolder, 'pipeline.json');
        fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2), 'utf-8');

        logger.info(`[PipelineManager] Saved pipeline JSON to ${jsonPath}`);
        return jsonPath;
    }

    incrementProgress(taskId: string, progress: number): void {
        this.db.updateSceneTask(taskId, { progress });
        const task = this.db.getSceneTask(taskId);
        if (task) {
            this.updatePipelineStats(task.pipelineId);
        }
    }

    getPipelineProgress(pipelineId: string): { completed: number; failed: number; total: number; processing: number } {
        const tasks = this.db.getSceneTasksByPipeline(pipelineId);
        return {
            completed: tasks.filter(t => t.status === 'completed').length,
            failed: tasks.filter(t => t.status === 'failed').length,
            total: tasks.length,
            processing: tasks.filter(t => t.status === 'generating' || t.status === 'assigned').length,
        };
    }
}

