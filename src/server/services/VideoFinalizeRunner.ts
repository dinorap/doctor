import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { DatabaseManager, VideoPipelineRecord, SceneTaskRecord } from '../../database/Database';
import { VideoAssembler, FinalizeOptions } from '../../pipeline/VideoAssembler';
import { OutputFormatter } from '../../pipeline/OutputFormatter';
import logger from '../../utils/logger';

export interface FinalizeRunnerOptions {
    pipeline: VideoPipelineRecord;
    tasks: SceneTaskRecord[];
    overrides?: Partial<FinalizeOptions>;
}

export interface FinalizeResult {
    pipelineId: string;
    finalVideoPath: string;
    finalVideoFileName: string;
    completedScenes: number;
    failedScenes: number;
    totalScenes: number;
}

export class VideoFinalizeRunner {
    constructor(private db: DatabaseManager) {}

    async run(options: FinalizeRunnerOptions): Promise<FinalizeResult | null> {
        const { pipeline, tasks, overrides = {} } = options;
        const completedVideos = this.collectCompletedVideos(pipeline, tasks);

        if (!completedVideos.length) {
            throw new Error('No completed scene videos available for final assembly');
        }

        const finalizeOptions = this.buildFinalizeOptions(pipeline, overrides);
        const outputPath = await this.resolveOutputPath(pipeline);
        const assembler = new VideoAssembler();

        logger.info(`[VideoFinalizeRunner] Assembling final video for pipeline=${pipeline.id} mode=${finalizeOptions.mode || 'concat'}`);
        await assembler.assembleFinal({
            sceneVideos: completedVideos,
            outputPath,
            finalize: finalizeOptions,
        });

        const relativePath = this.relativePath(pipeline.outputFolder, outputPath);
        this.updatePipelineOutput(pipeline, tasks, relativePath);

        return {
            pipelineId: pipeline.id,
            finalVideoPath: outputPath,
            finalVideoFileName: path.basename(outputPath),
            completedScenes: tasks.filter(t => t.status === 'completed').length,
            failedScenes: tasks.filter(t => t.status === 'failed').length,
            totalScenes: pipeline.totalScenes,
        };
    }

    private collectCompletedVideos(pipeline: VideoPipelineRecord, tasks: SceneTaskRecord[]): string[] {
        return tasks
            .filter(t => t.status === 'completed' && t.videoUrl)
            .map(t => path.join(pipeline.outputFolder, t.videoUrl))
            .filter(p => fs.existsSync(p))
            .sort((a, b) => a.localeCompare(b));
    }

    private buildFinalizeOptions(pipeline: VideoPipelineRecord, overrides: Partial<FinalizeOptions>): FinalizeOptions {
        const stored = this.safeParseFinalize(pipeline.config);
        return {
            mode: overrides.mode ?? stored.mode ?? 'concat',
            transition: overrides.transition ?? stored.transition,
            transitionDurationSeconds: overrides.transitionDurationSeconds ?? stored.transitionDurationSeconds ?? 1,
            originalAudioVolumePercent: overrides.originalAudioVolumePercent ?? stored.originalAudioVolumePercent,
            musicPath: overrides.musicPath ?? stored.musicPath,
            musicVolume: overrides.musicVolume ?? stored.musicVolume ?? 0.2,
            logoPath: overrides.logoPath ?? stored.logoPath,
            logoWidth: overrides.logoWidth ?? stored.logoWidth,
            logoHeight: overrides.logoHeight ?? stored.logoHeight,
            logoPosition: overrides.logoPosition ?? stored.logoPosition,
            logoXPercent: overrides.logoXPercent ?? stored.logoXPercent,
            logoYPercent: overrides.logoYPercent ?? stored.logoYPercent,
            logoZoomPercent: overrides.logoZoomPercent ?? stored.logoZoomPercent,
            textOverlay: overrides.textOverlay ?? stored.textOverlay,
            textBgOpacityPercent: overrides.textBgOpacityPercent ?? stored.textBgOpacityPercent,
        };
    }

    private safeParseFinalize(configRaw: string): FinalizeOptions {
        try {
            const config = JSON.parse(configRaw || '{}');
            return (config.finalize || {}) as FinalizeOptions;
        } catch {
            return {};
        }
    }

    private async resolveOutputPath(pipeline: VideoPipelineRecord): Promise<string> {
        const finalDir = path.join(pipeline.outputFolder, 'final');
        fs.mkdirSync(finalDir, { recursive: true });

        const script = this.db.getScriptReference(pipeline.scriptId);
        const scriptName = script?.name || pipeline.scriptId || 'script';
        const pipelineName = pipeline.name || pipeline.id;
        const projectId = pipeline.projectId || pipeline.id;

        const projectNameRaw = pipeline.projectId ? this.resolveProjectName(pipeline.projectId) : pipeline.projectId || 'project';
        const fileName = this.buildFinalFileName(projectNameRaw, pipelineName, scriptName);
        return path.join(finalDir, fileName);
    }

    private resolveProjectName(projectId: string): string {
        try {
            const projectsRoot = path.join(process.cwd(), 'example-edit', 'projects');
            const projectPath = path.join(projectsRoot, projectId);
            if (fs.existsSync(projectPath)) {
                const metaPath = path.join(projectPath, 'project.json');
                if (fs.existsSync(metaPath)) {
                    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
                    const name = String(meta?.name || meta?.project_name || '').trim();
                    if (name) return name;
                }
            }
        } catch {
            // ignore project name resolution failures
        }
        return projectId;
    }

    private buildFinalFileName(projectName: string, pipelineName: string, scriptName: string): string {
        const sanitize = (value: string) =>
            value
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '_')
                .replace(/^_+|_+$/g, '') || 'untitled';

        const projectSlug = sanitize(projectName);
        const pipelineSlug = sanitize(pipelineName);
        const scriptSlug = sanitize(scriptName);
        return `${projectSlug}_${pipelineSlug}_${scriptSlug}_complete_${Date.now()}.mp4`;
    }

    private updatePipelineOutput(pipeline: VideoPipelineRecord, tasks: SceneTaskRecord[], finalRelativePath: string): void {
        const formatter = new OutputFormatter();
        formatter.save(pipeline, tasks, pipeline.outputFolder, { final_video_path: finalRelativePath });

        this.db.updateVideoPipeline(pipeline.id, {
            errorMessage: '',
        });

        const jsonPath = path.join(pipeline.outputFolder, 'pipeline.json');
        try {
            const payload = {
                pipeline: {
                    id: pipeline.id,
                    name: pipeline.name,
                    status: pipeline.status,
                    totalScenes: pipeline.totalScenes,
                    completedScenes: tasks.filter(t => t.status === 'completed').length,
                    failedScenes: tasks.filter(t => t.status === 'failed').length,
                },
                scenes: tasks
                    .sort((a, b) => a.sceneIndex - b.sceneIndex)
                    .map(task => ({
                        sceneId: String(task.sceneIndex),
                        status: task.status,
                        videoPath: task.videoUrl || undefined,
                        error: task.error || undefined,
                    })),
                finalVideoPath: finalRelativePath,
            };
            fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf-8');
        } catch (error) {
            logger.warn(`[VideoFinalizeRunner] Failed to update pipeline JSON: ${String(error)}`);
        }
    }

    private relativePath(fromDir: string, filePath: string): string {
        const rel = path.relative(fromDir, filePath);
        return rel.split(path.sep).join('/');
    }
}
