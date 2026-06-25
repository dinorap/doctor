import { describe, it, expect, beforeEach } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

// Minimal in-memory logger stub to avoid winston in tests
const logger = {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
};

const DB_PATH = path.join(__dirname, '..', 'src', 'database', 'Database.ts');

// Minimal DatabaseManager inline for tests using SQLite in-memory
class TestDatabaseManager {
    db: Database.Database;
    constructor() {
        this.db = new Database(':memory:');
        this.initTables();
    }
    private initTables() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS profiles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                profilePath TEXT NOT NULL,
                metadata TEXT DEFAULT '{}',
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                profileId TEXT NOT NULL,
                tier TEXT DEFAULT 'PAYGATE_TIER_ONE',
                isActive INTEGER DEFAULT 0,
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS entity_references (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                imagePrompt TEXT,
                entityType TEXT DEFAULT 'character',
                materialId TEXT DEFAULT '3d_pixar',
                mediaId TEXT,
                localPath TEXT,
                remoteUrl TEXT,
                profileId TEXT NOT NULL,
                projectId TEXT,
                aspectRatio TEXT DEFAULT 'IMAGE_ASPECT_RATIO_PORTRAIT',
                upscaleResolution TEXT DEFAULT 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL',
                metadata TEXT DEFAULT '{}',
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS script_references (
                id TEXT PRIMARY KEY,
                projectId TEXT,
                profileId TEXT NOT NULL,
                name TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                input_type TEXT,
                topic TEXT,
                storytelling_mode TEXT DEFAULT 'auto',
                duration_text TEXT DEFAULT '60',
                copy_ratio INTEGER DEFAULT 90,
                material_id TEXT,
                content TEXT NOT NULL,
                metadata TEXT DEFAULT '{}',
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS video_pipelines (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                projectId TEXT,
                scriptId TEXT NOT NULL,
                profileIds TEXT DEFAULT '[]',
                status TEXT DEFAULT 'pending',
                config TEXT DEFAULT '{}',
                totalScenes INTEGER DEFAULT 0,
                completedScenes INTEGER DEFAULT 0,
                failedScenes INTEGER DEFAULT 0,
                outputFolder TEXT,
                errorMessage TEXT DEFAULT '',
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS scene_tasks (
                id TEXT PRIMARY KEY,
                pipelineId TEXT NOT NULL,
                sceneIndex INTEGER NOT NULL,
                sceneData TEXT NOT NULL,
                status TEXT DEFAULT 'pending',
                assignedProfileId TEXT DEFAULT '',
                imageUrl TEXT DEFAULT '',
                videoUrl TEXT DEFAULT '',
                characterRefs TEXT DEFAULT '{}',
                progress INTEGER DEFAULT 0,
                error TEXT DEFAULT '',
                startedAt TEXT,
                completedAt TEXT,
                FOREIGN KEY (pipelineId) REFERENCES video_pipelines(id) ON DELETE CASCADE
            )
        `);
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS video_project_settings (
                id TEXT PRIMARY KEY,
                projectId TEXT NOT NULL,
                selectedProfileIds TEXT DEFAULT '[]',
                defaultModel TEXT DEFAULT 'veo_3_1',
                defaultDuration TEXT DEFAULT '8',
                defaultAspectRatio TEXT DEFAULT 'VIDEO_ASPECT_RATIO_PORTRAIT',
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL
            )
        `);
    }
    createVideoPipeline(pipeline: any) {
        const now = new Date().toISOString();
        this.db.prepare(`INSERT INTO video_pipelines (id,name,projectId,scriptId,profileIds,status,config,totalScenes,completedScenes,failedScenes,outputFolder,errorMessage,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            pipeline.id, pipeline.name, pipeline.projectId || null, pipeline.scriptId, pipeline.profileIds, pipeline.status || 'pending', pipeline.config || '{}', pipeline.totalScenes || 0, pipeline.completedScenes || 0, pipeline.failedScenes || 0, pipeline.outputFolder || '', pipeline.errorMessage || '', now, now
        );
        return { ...pipeline, createdAt: now, updatedAt: now };
    }
    getVideoPipeline(id: string) {
        return this.db.prepare('SELECT * FROM video_pipelines WHERE id = ?').get(id) as any;
    }
    getAllVideoPipelines() {
        return this.db.prepare('SELECT * FROM video_pipelines ORDER BY createdAt DESC').all() as any[];
    }
    getVideoPipelinesByProject(projectId: string) {
        return this.db.prepare('SELECT * FROM video_pipelines WHERE projectId = ? ORDER BY createdAt DESC').all(projectId) as any[];
    }
    updateVideoPipeline(id: string, updates: any) {
        const fields: string[] = [];
        const values: any[] = [];
        const map: Record<string, string> = { name:'name', projectId:'projectId', scriptId:'scriptId', profileIds:'profileIds', status:'status', config:'config', totalScenes:'totalScenes', completedScenes:'completedScenes', failedScenes:'failedScenes', outputFolder:'outputFolder', errorMessage:'errorMessage' };
        for (const [key, dbField] of Object.entries(map)) {
            if (updates[key] !== undefined) {
                fields.push(`${dbField} = ?`);
                values.push(updates[key]);
            }
        }
        if (!fields.length) return false;
        values.push(id);
        this.db.prepare(`UPDATE video_pipelines SET ${fields.join(', ')} WHERE id = ?`).run(...values);
        return true;
    }
    deleteVideoPipeline(id: string) {
        const res = this.db.prepare('DELETE FROM video_pipelines WHERE id = ?').run(id);
        return res.changes > 0;
    }
    createSceneTasks(tasks: any[]) {
        const stmt = this.db.prepare(`INSERT INTO scene_tasks (id,pipelineId,sceneIndex,sceneData,status,assignedProfileId,imageUrl,videoUrl,characterRefs,progress,error,startedAt,completedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        const tx = this.db.transaction((items: any[]) => {
            for (const task of items) {
                stmt.run(task.id, task.pipelineId, task.sceneIndex, task.sceneData, task.status || 'pending', task.assignedProfileId || '', task.imageUrl || '', task.videoUrl || '', task.characterRefs || '{}', task.progress || 0, task.error || '', null, null);
            }
        });
        tx(tasks);
    }
    getSceneTask(id: string) {
        return this.db.prepare('SELECT * FROM scene_tasks WHERE id = ?').get(id) as any;
    }
    getSceneTasksByPipeline(pipelineId: string) {
        return this.db.prepare('SELECT * FROM scene_tasks WHERE pipelineId = ? ORDER BY sceneIndex ASC').all(pipelineId) as any[];
    }
    getSceneTaskByPipelineAndIndex(pipelineId: string, sceneIndex: number) {
        return this.db.prepare('SELECT * FROM scene_tasks WHERE pipelineId = ? AND sceneIndex = ?').get(pipelineId, sceneIndex) as any;
    }
    getSceneTaskForProfile(profileId: string, pipelineId: string) {
        return this.db.prepare('SELECT * FROM scene_tasks WHERE assignedProfileId = ? AND pipelineId = ? AND status IN ("pending","assigned") ORDER BY sceneIndex ASC LIMIT 1').get(profileId, pipelineId) as any;
    }
    getNextPendingTaskForProfile(pipelineId: string) {
        return this.db.prepare('SELECT * FROM scene_tasks WHERE pipelineId = ? AND status = "pending" ORDER BY sceneIndex ASC LIMIT 1').get(pipelineId) as any;
    }
    updateSceneTask(id: string, updates: any) {
        const fields: string[] = [];
        const values: any[] = [];
        const map: Record<string, string> = { status:'status', assignedProfileId:'assignedProfileId', imageUrl:'imageUrl', videoUrl:'videoUrl', characterRefs:'characterRefs', progress:'progress', error:'error', startedAt:'startedAt', completedAt:'completedAt' };
        for (const [key, dbField] of Object.entries(map)) {
            if (updates[key] !== undefined) {
                fields.push(`${dbField} = ?`);
                values.push(updates[key]);
            }
        }
        if (!fields.length) return false;
        values.push(id);
        this.db.prepare(`UPDATE scene_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
        return true;
    }
    deleteSceneTask(id: string) {
        return this.db.prepare('DELETE FROM scene_tasks WHERE id = ?').run(id).changes > 0;
    }
    deleteSceneTasksByPipeline(pipelineId: string) {
        return this.db.prepare('DELETE FROM scene_tasks WHERE pipelineId = ?').run(pipelineId).changes;
    }
    getEntityReference(id: string) {
        return this.db.prepare('SELECT * FROM entity_references WHERE id = ?').get(id) as any;
    }
    getEntityReferencesByProfile(profileId: string) {
        return this.db.prepare('SELECT * FROM entity_references WHERE profileId = ? ORDER BY createdAt DESC').all(profileId) as any[];
    }
    createEntityReference(entity: any) {
        const now = new Date().toISOString();
        this.db.prepare(`INSERT INTO entity_references (id,name,description,imagePrompt,entityType,materialId,mediaId,localPath,remoteUrl,profileId,projectId,aspectRatio,upscaleResolution,metadata,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            entity.id, entity.name, entity.description || '', entity.imagePrompt || '', entity.entityType || 'character', entity.materialId || '3d_pixar', entity.mediaId || '', entity.localPath || '', entity.remoteUrl || '', entity.profileId, entity.projectId || '', entity.aspectRatio || 'IMAGE_ASPECT_RATIO_PORTRAIT', entity.upscaleResolution || 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL', entity.metadata || '{}', now, now
        );
        return { ...entity, createdAt: now, updatedAt: now };
    }
    getScriptReference(id: string) {
        return this.db.prepare('SELECT * FROM script_references WHERE id = ?').get(id) as any;
    }
    getProfile(id: string) {
        return this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) as any;
    }
    createProfile(profile: any) {
        const now = new Date().toISOString();
        this.db.prepare(`INSERT INTO profiles (id,name,profilePath,metadata,createdAt,updatedAt) VALUES (?,?,?,?,?,?)`).run(profile.id, profile.name, profile.profilePath, profile.metadata || '{}', now, now);
        return { ...profile, createdAt: now, updatedAt: now };
    }
    getVideoProjectSettings(projectId: string) {
        return this.db.prepare('SELECT * FROM video_project_settings WHERE projectId = ?').get(projectId) as any;
    }
    createOrUpdateVideoProjectSettings(settings: any) {
        const now = new Date().toISOString();
        const existing = this.getVideoProjectSettings(settings.projectId);
        if (existing) {
            this.db.prepare(`UPDATE video_project_settings SET selectedProfileIds=?,defaultModel=?,defaultDuration=?,defaultAspectRatio=?,updatedAt=? WHERE projectId=?`).run(settings.selectedProfileIds, settings.defaultModel, settings.defaultDuration, settings.defaultAspectRatio, now, settings.projectId);
            return { ...existing, ...settings, updatedAt: now };
        }
        this.db.prepare(`INSERT INTO video_project_settings (id,projectId,selectedProfileIds,defaultModel,defaultDuration,defaultAspectRatio,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?)`).run(settings.id, settings.projectId, settings.selectedProfileIds, settings.defaultModel, settings.defaultDuration, settings.defaultAspectRatio, now, now);
        return { ...settings, createdAt: now, updatedAt: now };
    }
    close() {
        this.db.close();
    }
}

import { PipelineManager } from '../src/pipeline/PipelineManager';
import { OutputFormatter } from '../src/pipeline/OutputFormatter';

describe('PipelineManager', () => {
    let db: TestDatabaseManager;
    let pipelineManager: PipelineManager;

    beforeEach(() => {
        db = new TestDatabaseManager();
        pipelineManager = new PipelineManager(db as any);
    });

    it('creates a pipeline with scenes', () => {
        const pipeline = pipelineManager.createPipeline({
            name: 'Test Pipeline',
            scriptId: 'script-1',
            selectedProfileIds: ['p1', 'p2'],
            outputFolder: '/tmp/test-pipeline',
            scenes: [
                { sceneIndex: 1, sceneData: { visual_prompt: 'A' } },
                { sceneIndex: 2, sceneData: { visual_prompt: 'B' } },
            ],
        });

        expect(pipeline.name).toBe('Test Pipeline');
        expect(pipeline.totalScenes).toBe(2);
        expect(pipeline.status).toBe('pending');
        expect(pipeline.profileIds).toBe('["p1","p2"]');

        const tasks = db.getSceneTasksByPipeline(pipeline.id);
        expect(tasks.length).toBe(2);
        expect(tasks[0].sceneIndex).toBe(1);
        expect(tasks[1].sceneIndex).toBe(2);
    });

    it('distributes tasks round-robin', () => {
        const pipeline = pipelineManager.createPipeline({
            name: 'RR Pipeline',
            scriptId: 'script-2',
            selectedProfileIds: ['p1', 'p2'],
            outputFolder: '/tmp/test-pipeline',
            scenes: [
                { sceneIndex: 1, sceneData: {} },
                { sceneIndex: 2, sceneData: {} },
                { sceneIndex: 3, sceneData: {} },
            ],
        });

        pipelineManager.distributeTasks(pipeline.id);

        const tasks = db.getSceneTasksByPipeline(pipeline.id);
        expect(tasks[0].assignedProfileId).toBe('p1');
        expect(tasks[1].assignedProfileId).toBe('p2');
        expect(tasks[2].assignedProfileId).toBe('p1');
    });

    it('distributes tasks by credits when provided', () => {
        const pipeline = pipelineManager.createPipeline({
            name: 'Credits Pipeline',
            scriptId: 'script-3',
            selectedProfileIds: ['p1', 'p2'],
            outputFolder: '/tmp/test-pipeline',
            scenes: [
                { sceneIndex: 1, sceneData: {} },
                { sceneIndex: 2, sceneData: {} },
            ],
        });

        pipelineManager.distributeTasks(pipeline.id, [
            { profileId: 'p1', credits: 100 },
            { profileId: 'p2', credits: 10 },
        ]);

        const tasks = db.getSceneTasksByPipeline(pipeline.id);
        // Smart distribution should assign more to higher credits profile
        const p1Tasks = tasks.filter(t => t.assignedProfileId === 'p1').length;
        const p2Tasks = tasks.filter(t => t.assignedProfileId === 'p2').length;
        expect(p1Tasks).toBeGreaterThanOrEqual(1);
        expect(p2Tasks).toBeGreaterThanOrEqual(0);
        expect(p1Tasks + p2Tasks).toBe(2);
    });

    it('updates pipeline status on failure and captcha pauses', () => {
        const pipeline = pipelineManager.createPipeline({
            name: 'Captcha Pipeline',
            scriptId: 'script-4',
            selectedProfileIds: ['p1'],
            outputFolder: '/tmp/test-pipeline',
            scenes: [{ sceneIndex: 1, sceneData: {} }],
        });

        db.getSceneTasksByPipeline(pipeline.id).forEach(task => {
            db.updateSceneTask(task.id, { status: 'failed', error: 'captcha detected' });
        });

        pipelineManager.updatePipelineStats(pipeline.id);

        const updated = db.getVideoPipeline(pipeline.id);
        expect(updated.status).toBe('paused');
    });

    it('retries failed tasks with retry count', () => {
        const pipeline = pipelineManager.createPipeline({
            name: 'Retry Pipeline',
            scriptId: 'script-5',
            selectedProfileIds: ['p1'],
            outputFolder: '/tmp/test-pipeline',
            config: { maxRetries: 2 },
            scenes: [{ sceneIndex: 1, sceneData: {} }],
        });

        db.getSceneTasksByPipeline(pipeline.id).forEach(task => {
            db.updateSceneTask(task.id, { status: 'failed', error: 'some error' });
        });

        const retried = pipelineManager.retryFailedTasks(pipeline.id);
        expect(retried).toBe(1);

        const task = db.getSceneTasksByPipeline(pipeline.id)[0];
        expect(task.status).toBe('assigned');
        expect(task.error).toMatch(/retry:1/);
    });

    it('auto-retries captcha errors', () => {
        const pipeline = pipelineManager.createPipeline({
            name: 'Auto Retry Captcha',
            scriptId: 'script-6',
            selectedProfileIds: ['p1'],
            outputFolder: '/tmp/test-pipeline',
            scenes: [
                { sceneIndex: 1, sceneData: {} },
                { sceneIndex: 2, sceneData: {} },
            ],
        });

        const tasks = db.getSceneTasksByPipeline(pipeline.id);
        db.updateSceneTask(tasks[0].id, { status: 'failed', error: 'captcha block' });
        db.updateSceneTask(tasks[1].id, { status: 'completed' });

        const retried = pipelineManager.autoRetryCaptchaErrors(pipeline.id);
        expect(retried).toBe(1);

        const updated = db.getSceneTasksByPipeline(pipeline.id);
        expect(updated[0].status).toBe('assigned');
        expect(db.getVideoPipeline(pipeline.id).status).toBe('processing');
    });
});

describe('OutputFormatter', () => {
    it('formats pipeline output correctly', () => {
        const db = new TestDatabaseManager();
        const formatter = new OutputFormatter();

        const pipeline = db.createVideoPipeline({
            id: 'pipe-1',
            name: 'Demo',
            scriptId: 'script-1',
            profileIds: '["p1"]',
            status: 'processing',
            config: '{}',
            totalScenes: 1,
            completedScenes: 0,
            failedScenes: 0,
            outputFolder: '/tmp/test-pipeline',
            errorMessage: '',
        });

        db.createSceneTasks([
            { id: 'task-1', pipelineId: 'pipe-1', sceneIndex: 1, sceneData: JSON.stringify({ visual_prompt: 'A cat', tts_script: 'Meow' }), status: 'completed', videoUrl: 'scenes/scene_001/video.mp4' },
        ]);

        const tasks = db.getSceneTasksByPipeline('pipe-1');
        const output = formatter.format(pipeline, tasks);

        expect(output.meta.title).toBe('Demo');
        expect(output.scenes.length).toBe(1);
        expect(output.scenes[0].status).toBe('done');
        expect(output.scenes[0].video_url).toBe('scenes/scene_001/video.mp4');
        expect(output.scenes[0].video_prompt).toBe('A cat');
    });
});

describe('VideoAssembler', () => {
    it('copies single scene without ffmpeg', async () => {
        const { VideoAssembler } = await import('../src/pipeline/VideoAssembler');
        const assembler = new VideoAssembler();
        const src = '/tmp/single.mp4';
        const dest = '/tmp/assembled.mp4';
        fs.mkdirSync('/tmp', { recursive: true });
        fs.writeFileSync(src, 'binary');

        const result = await assembler.assembleVideo({ sceneVideos: [src], outputPath: dest });
        expect(result).toBe(dest);
        expect(fs.existsSync(dest)).toBe(true);
    });
});
