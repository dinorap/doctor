import express, { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseManager } from '../database/Database';
import { PipelineManager, PipelineConfig, CreatePipelineOptions } from '../pipeline/PipelineManager';
import { ReferenceImageManager, ProfileMediaMap } from '../pipeline/ReferenceImageManager';
import { FlowApiRegistry } from '../flow-api/FlowApiRegistry';
import logger from '../utils/logger';

const router = express.Router();

// Initialize managers (will be set by app.ts)
let db: DatabaseManager;
let pipelineManager: PipelineManager;
let flowRegistry: FlowApiRegistry;

export function initPipelineRoutes(
    database: DatabaseManager,
    flowApiRegistry?: FlowApiRegistry,
    externalPipelineManager?: PipelineManager,
): void {
    db = database;
    pipelineManager = externalPipelineManager || new PipelineManager(db);
    flowRegistry = flowApiRegistry as FlowApiRegistry;
    logger.info('[PipelineRoutes] Initialized');
}

// GET /pipelines - List all pipelines
router.get('/', (_req: Request, res: Response) => {
    try {
        const pipelines = pipelineManager.getAllPipelines();
        res.json({ success: true, data: pipelines });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error listing pipelines:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /pipelines/:id - Get pipeline details
router.get('/:id', (req: Request, res: Response) => {
    try {
        const pipeline = pipelineManager.getPipeline(req.params.id);
        if (!pipeline) {
            return res.status(404).json({ success: false, error: 'Pipeline not found' });
        }
        res.json({ success: true, data: pipeline });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error getting pipeline:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /pipelines/:id/status - Get pipeline status with scenes
router.get('/:id/status', (req: Request, res: Response) => {
    try {
        const status = pipelineManager.getPipelineStatus(req.params.id);
        if (!status) {
            return res.status(404).json({ success: false, error: 'Pipeline not found' });
        }
        res.json({ success: true, data: status });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error getting pipeline status:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /pipelines - Create new pipeline
router.post('/', async (req: Request, res: Response) => {
    try {
        const {
            name,
            projectId,
            scriptId,
            selectedProfileIds,
            outputFolder,
            config,
            scenes,
        } = req.body;

        // Validate required fields
        if (!name || !scriptId || !outputFolder) {
            return res.status(400).json({
                success: false,
                error: 'Missing required fields: name, scriptId, outputFolder',
            });
        }

        // Validate selectedProfileIds is an array
        if (!Array.isArray(selectedProfileIds)) {
            return res.status(400).json({
                success: false,
                error: 'selectedProfileIds must be an array',
            });
        }

        // Validate scenes is a non-empty array
        if (!Array.isArray(scenes) || scenes.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'scenes must be a non-empty array',
            });
        }

        const options: CreatePipelineOptions = {
            name,
            projectId,
            scriptId,
            selectedProfileIds,
            outputFolder,
            config: config || {},
            scenes: scenes.map((s: any, idx: number) => ({
                sceneIndex: s.sceneIndex ?? idx,
                sceneData: s,
            })),
        };

        const pipeline = pipelineManager.createPipeline(options);

        res.json({ success: true, data: pipeline });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error creating pipeline:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /pipelines/:id/upload-refs - Upload all reference images to all profiles
// Must be called BEFORE start. Uploads character images, environment images, etc.
router.post('/:id/upload-refs', async (req: Request, res: Response) => {
    try {
        const pipelineId = req.params.id;
        const pipeline = pipelineManager.getPipeline(pipelineId);
        if (!pipeline) {
            return res.status(404).json({ success: false, error: 'Pipeline not found' });
        }

        if (!flowRegistry) {
            return res.status(500).json({ success: false, error: 'Flow registry not available' });
        }

        const profileIds: string[] = JSON.parse(pipeline.profileIds || '[]');
        if (profileIds.length === 0) {
            return res.status(400).json({ success: false, error: 'No profiles assigned to pipeline' });
        }

        const projectId = pipeline.projectId || pipeline.id;
        const refManager = new ReferenceImageManager(db, flowRegistry);

        // Collect all scenes from the pipeline
        const sceneTasks = db.getSceneTasksByPipeline(pipelineId);
        const sceneDataObjects = sceneTasks.map(t => {
            try { return JSON.parse(t.sceneData); } catch { return {}; }
        });

        // Collect all unique reference images
        const targets = refManager.collectReferenceImages(sceneDataObjects);

        if (targets.length === 0) {
            return res.json({
                success: true,
                message: 'No reference images to upload',
                totalImages: 0,
                mediaMap: {},
            });
        }

        // Upload all images to all profiles
        const result = await refManager.uploadAll(targets, profileIds, projectId);

        // Save media map to output folder
        const savedPath = refManager.saveMediaMap(result.mediaMap, pipeline.outputFolder);

        res.json({
            success: true,
            message: `Uploaded ${result.successfulUploads.length}/${result.totalImages * result.totalProfiles} images`,
            totalImages: result.totalImages,
            totalProfiles: result.totalProfiles,
            successfulUploads: result.successfulUploads,
            failedImages: result.failedImages,
            mediaMapPath: savedPath,
        });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error uploading reference images:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /pipelines/:id/start - Start pipeline processing
router.post('/:id/start', (req: Request, res: Response) => {
    try {
        const { profileCredits } = req.body || {};
        const success = pipelineManager.startPipeline(req.params.id, profileCredits);
        if (!success) {
            return res.status(404).json({ success: false, error: 'Pipeline not found' });
        }
        res.json({ success: true, message: 'Pipeline started' });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error starting pipeline:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /pipelines/:id/retry-captcha - Retry captcha-affected tasks
router.post('/:id/retry-captcha', (req: Request, res: Response) => {
    try {
        const retried = pipelineManager.autoRetryCaptchaErrors(req.params.id);
        res.json({ success: true, retriedCount: retried });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error retrying captcha tasks:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /pipelines/:id/progress - Get pipeline progress
router.get('/:id/progress', (req: Request, res: Response) => {
    try {
        const progress = pipelineManager.getPipelineProgress(req.params.id);
        res.json({ success: true, data: progress });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error getting progress:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /pipelines/:id/pause - Pause pipeline
router.post('/:id/pause', (req: Request, res: Response) => {
    try {
        const success = pipelineManager.pausePipeline(req.params.id);
        if (!success) {
            return res.status(404).json({ success: false, error: 'Pipeline not found' });
        }
        res.json({ success: true, message: 'Pipeline paused' });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error pausing pipeline:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /pipelines/:id/stop - Stop pipeline
router.post('/:id/stop', (req: Request, res: Response) => {
    try {
        const success = pipelineManager.stopPipeline(req.params.id);
        if (!success) {
            return res.status(404).json({ success: false, error: 'Pipeline not found' });
        }
        res.json({ success: true, message: 'Pipeline stopped' });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error stopping pipeline:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /pipelines/:id/retry - Retry failed tasks
router.post('/:id/retry', (req: Request, res: Response) => {
    try {
        const { taskIds } = req.body;
        const retried = pipelineManager.retryFailedTasks(req.params.id, taskIds);
        res.json({ success: true, retriedCount: retried });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error retrying tasks:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /pipelines/:id/scenes - Get all scene tasks
router.get('/:id/scenes', (req: Request, res: Response) => {
    try {
        const tasks = db.getSceneTasksByPipeline(req.params.id);
        res.json({ success: true, data: tasks });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error getting scenes:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /pipelines/:id/scene/:sceneIndex - Get specific scene task
router.get('/:id/scene/:sceneIndex', (req: Request, res: Response) => {
    try {
        const sceneIndex = parseInt(req.params.sceneIndex, 10);
        if (isNaN(sceneIndex)) {
            return res.status(400).json({ success: false, error: 'Invalid sceneIndex' });
        }
        const task = db.getSceneTaskByPipelineAndIndex(req.params.id, sceneIndex);
        if (!task) {
            return res.status(404).json({ success: false, error: 'Scene not found' });
        }
        res.json({ success: true, data: task });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error getting scene:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// POST /pipelines/:id/scene/:sceneIndex/claim - Claim a scene task for a profile
router.post('/:id/scene/:sceneIndex/claim', (req: Request, res: Response) => {
    try {
        const { profileId } = req.body;
        if (!profileId) {
            return res.status(400).json({ success: false, error: 'profileId required' });
        }

        const task = pipelineManager.getNextTaskForProfile(profileId, req.params.id);
        if (!task) {
            return res.status(404).json({ success: false, error: 'No pending tasks available' });
        }

        res.json({ success: true, data: task });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error claiming scene:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// PATCH /pipelines/:id/scene/:sceneIndex - Update scene task status
router.patch('/:id/scene/:sceneIndex', (req: Request, res: Response) => {
    try {
        const sceneIndex = parseInt(req.params.sceneIndex, 10);
        if (isNaN(sceneIndex)) {
            return res.status(400).json({ success: false, error: 'Invalid sceneIndex' });
        }
        const task = db.getSceneTaskByPipelineAndIndex(req.params.id, sceneIndex);
        if (!task) {
            return res.status(404).json({ success: false, error: 'Scene not found' });
        }

        const { status, imageUrl, videoUrl, progress, error } = req.body;
        pipelineManager.updateTaskStatus(task.id, { status, imageUrl, videoUrl, progress, error });

        res.json({ success: true });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error updating scene:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// DELETE /pipelines/:id - Delete pipeline
router.delete('/:id', (req: Request, res: Response) => {
    try {
        const success = pipelineManager.deletePipeline(req.params.id);
        if (!success) {
            return res.status(404).json({ success: false, error: 'Pipeline not found' });
        }
        res.json({ success: true, message: 'Pipeline deleted' });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error deleting pipeline:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// GET /pipelines/:id/export - Export pipeline JSON
router.get('/:id/export', (req: Request, res: Response) => {
    try {
        const jsonPath = pipelineManager.savePipelineJson(req.params.id);
        if (!jsonPath) {
            return res.status(404).json({ success: false, error: 'Pipeline not found' });
        }
        res.json({ success: true, path: jsonPath });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error exporting pipeline:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Project video settings endpoints
router.get('/settings/project/:projectId', (req: Request, res: Response) => {
    try {
        const settings = db.getVideoProjectSettings(req.params.projectId);
        res.json({ success: true, data: settings });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error getting project settings:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

router.post('/settings/project/:projectId', (req: Request, res: Response) => {
    try {
        const { selectedProfileIds, defaultModel, defaultDuration, defaultAspectRatio } = req.body;

        const settings = db.createOrUpdateVideoProjectSettings({
            id: uuidv4(),
            projectId: req.params.projectId,
            selectedProfileIds: JSON.stringify(selectedProfileIds || []),
            defaultModel: defaultModel || 'veo_3_1',
            defaultDuration: defaultDuration || '8',
            defaultAspectRatio: defaultAspectRatio || 'VIDEO_ASPECT_RATIO_PORTRAIT',
        });

        res.json({ success: true, data: settings });
    } catch (error: any) {
        logger.error('[PipelineRoutes] Error saving project settings:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
