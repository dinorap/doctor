import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseManager } from '../database/Database';
import { PipelineManager } from '../pipeline/PipelineManager';
import { VideoFinalizeRunner } from '../server/services/VideoFinalizeRunner';
import { FinalizeOptions } from '../pipeline/VideoAssembler';
import logger from '../utils/logger';

const router = Router();

let db: DatabaseManager;
let pipelineManager: PipelineManager;

export function initFinalizeRoutes(database: DatabaseManager, pipelineMgr: PipelineManager): void {
    db = database;
    pipelineManager = pipelineMgr;
    logger.info('[FinalizeRoutes] Initialized');
}

router.post('/:id/final-assemble', async (req: Request, res: Response) => {
    try {
        const pipelineId = req.params.id;
        const pipeline = pipelineManager.getPipeline(pipelineId);
        if (!pipeline) {
            return res.status(404).json({ success: false, error: 'Pipeline not found' });
        }

        const body = req.body || {};
        const overrides: Partial<FinalizeOptions> = {
            mode: body.mode,
            transition: body.transition,
            transitionDurationSeconds: body.transitionDurationSeconds,
            originalAudioVolumePercent: body.originalAudioVolumePercent,
            musicPath: body.musicPath,
            musicVolume: body.musicVolume,
            logoPath: body.logoPath,
            logoWidth: body.logoWidth,
            logoHeight: body.logoHeight,
            logoPosition: body.logoPosition,
            logoXPercent: body.logoXPercent,
            logoYPercent: body.logoYPercent,
            logoZoomPercent: body.logoZoomPercent,
            textOverlay: body.textOverlay,
            textBgOpacityPercent: body.textBgOpacityPercent,
        };

        const currentConfig = pipeline.config ? JSON.parse(pipeline.config) : {};
        currentConfig.finalize = { ...(currentConfig.finalize || {}), ...overrides };
        db.updateVideoPipeline(pipeline.id, { config: JSON.stringify(currentConfig) });

        const runner = new VideoFinalizeRunner(db);
        const tasks = db.getSceneTasksByPipeline(pipelineId);
        const result = await runner.run({ pipeline, tasks, overrides });

        res.json({ success: true, data: result });
    } catch (error: any) {
        logger.error('[FinalizeRoutes] Error running final assemble:', error);
        res.status(500).json({ success: false, error: error.message || 'Final assemble failed' });
    }
});

router.get('/:id/final-output', (req: Request, res: Response) => {
    try {
        const pipeline = pipelineManager.getPipeline(req.params.id);
        if (!pipeline) {
            return res.status(404).json({ success: false, error: 'Pipeline not found' });
        }

        const outputPath = path.join(pipeline.outputFolder, 'final');
        let finalVideoPath: string | undefined;
        if (fs.existsSync(outputPath)) {
            const files = fs.readdirSync(outputPath)
                .filter(name => name.endsWith('.mp4'))
                .sort()
                .reverse();
            finalVideoPath = files.length ? path.join('final', files[0]) : undefined;
        }

        const config = pipeline.config ? JSON.parse(pipeline.config) : {};
        const finalize = (config.finalize || {}) as FinalizeOptions;

        res.json({
            success: true,
            data: {
                pipelineId: pipeline.id,
                status: pipeline.status,
                finalVideoPath: finalVideoPath ? `/data/pipeline/${pipeline.id}/${finalVideoPath.replace(/\\/g, '/')}` : null,
                localFinalVideoPath: finalVideoPath ? path.join(pipeline.outputFolder, finalVideoPath) : null,
                finalize,
            },
        });
    } catch (error: any) {
        logger.error('[FinalizeRoutes] Error getting final output:', error);
        res.status(500).json({ success: false, error: error.message || 'Failed to load final output' });
    }
});

export default router;

