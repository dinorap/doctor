import path from 'path';
import fs from 'fs';
import { VideoPipelineRecord, SceneTaskRecord } from '../database/Database';
import logger from '../utils/logger';

export interface FormattedScene {
    scene_id: number;
    video_prompt: string;
    tts_script?: string;
    status: 'pending' | 'generating' | 'done' | 'failed' | 'captcha_error';
    video_url?: string;
    image_url?: string;
    character?: string;
    assigned_profile_id?: string;
    generated_at?: string;
    error?: string;
}

export interface FormattedPipelineOutput {
    meta: {
        title: string;
        total_scenes: number;
        duration_note?: string;
        created_at: string;
        updated_at: string;
    };
    voice_bank: Array<{
        id: string;
        signature: string;
    }>;
    cast_profiles: Array<{
        name: string;
        visual_signature: string;
        reference_image_url?: string;
        entity_id?: string;
    }>;
    scenes: FormattedScene[];
    master_cast_image_prompt?: string;
    master_image_urls?: string[];
    master_image_status?: 'pending' | 'generating' | 'done' | 'failed';
    master_image_url?: string;
    is_setting_up: boolean;
    is_running: boolean;
    is_retrying: boolean;
    last_updated: number;
    tts_completed: boolean;
    video_completed: boolean;
    final_video_path?: string;
    run_error_message?: string;
}

export class OutputFormatter {
    format(pipeline: VideoPipelineRecord, tasks: SceneTaskRecord[], extra?: Partial<FormattedPipelineOutput>): FormattedPipelineOutput {
        const updatedAt = Date.now();
        const completedScenes = tasks.filter(t => t.status === 'completed').length;
        const failedScenes = tasks.filter(t => t.status === 'failed').length;
        const hasCaptcha = tasks.some(t => t.status === 'failed' && /captcha/i.test(t.error || ''));

        const output: FormattedPipelineOutput = {
            meta: {
                title: pipeline.name,
                total_scenes: pipeline.totalScenes,
                duration_note: 'Generated from script',
                created_at: pipeline.createdAt,
                updated_at: pipeline.updatedAt,
            },
            voice_bank: extra?.voice_bank ?? [],
            cast_profiles: extra?.cast_profiles ?? [],
            scenes: tasks
                .sort((a, b) => a.sceneIndex - b.sceneIndex)
                .map(task => {
                    const sceneData = this.safeParseSceneData(task.sceneData);
                    return {
                        scene_id: task.sceneIndex,
                        video_prompt: String(sceneData?.visual_prompt || sceneData?.prompt || ''),
                        tts_script: String(sceneData?.tts_script || sceneData?.narration || ''),
                        status: this.mapStatus(task.status, hasCaptcha ? !!task.error?.toLowerCase().includes('captcha') : false) as FormattedScene['status'],
                        video_url: task.videoUrl || undefined,
                        image_url: task.imageUrl || undefined,
                        character: sceneData?.character,
                        assigned_profile_id: task.assignedProfileId || undefined,
                        generated_at: task.completedAt || undefined,
                        error: task.error || undefined,
                    };
                }),
            master_cast_image_prompt: extra?.master_cast_image_prompt,
            master_image_urls: extra?.master_image_urls,
            master_image_status: extra?.master_image_status,
            master_image_url: extra?.master_image_url,
            is_setting_up: false,
            is_running: pipeline.status === 'processing',
            is_retrying: false,
            last_updated: updatedAt,
            tts_completed: false,
            video_completed: completedScenes === pipeline.totalScenes && failedScenes === 0,
            final_video_path: extra?.final_video_path,
            run_error_message: pipeline.errorMessage || undefined,
        };

        return output;
    }

    save(pipeline: VideoPipelineRecord, tasks: SceneTaskRecord[], outputDir: string, extra?: Partial<FormattedPipelineOutput>): string {
        const output = this.format(pipeline, tasks, extra);
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
        const jsonPath = path.join(outputDir, 'output.json');
        fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2), 'utf-8');
        logger.info(`[OutputFormatter] Saved output to ${jsonPath}`);
        return jsonPath;
    }

    private safeParseSceneData(raw: string): any {
        try {
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }

    private mapStatus(status: string, captcha = false): FormattedScene['status'] {
        if (captcha) return 'captcha_error';
        if (status === 'completed') return 'done';
        if (status === 'failed') return 'failed';
        if (status === 'generating') return 'generating';
        return 'pending';
    }
}
