import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { logger } from '../utils/logger';

export interface ProfileRecord {
    id: string;
    name: string;
    profilePath: string;
    metadata: string; // JSON string
    createdAt: string;
    updatedAt: string;
}

export interface SessionRecord {
    id: string;
    profileId: string;
    tier: string;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface EntityReferenceRecord {
    id: string;
    name: string;
    description: string;
    imagePrompt?: string;
    entityType: string;
    materialId: string;
    mediaId: string;
    localPath: string;
    remoteUrl: string;
    profileId: string;
    projectId: string;
    aspectRatio: string;
    upscaleResolution: string;
    metadata: string;
    createdAt: string;
    updatedAt: string;
}

export interface ScriptReferenceRecord {
    id: string;
    projectId: string | null;
    profileId: string;
    name: string;
    version: number;
    input_type: string | null;
    topic: string | null;
    storytelling_mode: string;
    duration_text: string;
    copy_ratio: number;
    material_id: string | null;
    content: string; // JSON string
    metadata: string;
    createdAt: string;
    updatedAt: string;
}

// Pipeline types
export interface VideoPipelineRecord {
    id: string;
    name: string;
    projectId: string | null;
    scriptId: string;
    profileIds: string; // JSON array of profile IDs
    status: 'pending' | 'processing' | 'paused' | 'completed' | 'failed';
    config: string; // JSON string
    totalScenes: number;
    completedScenes: number;
    failedScenes: number;
    outputFolder: string;
    errorMessage: string;
    createdAt: string;
    updatedAt: string;
}

export interface SceneTaskRecord {
    id: string;
    pipelineId: string;
    sceneIndex: number;
    sceneData: string; // JSON string
    status: 'pending' | 'assigned' | 'generating' | 'completed' | 'failed';
    assignedProfileId: string;
    imageUrl: string;
    videoUrl: string;
    characterRefs: string; // JSON string
    progress: number; // 0-100
    error: string;
    startedAt: string;
    completedAt: string;
}

export interface VideoProjectSettingsRecord {
    id: string;
    projectId: string;
    selectedProfileIds: string; // JSON array
    defaultModel: string;
    defaultDuration: string;
    defaultAspectRatio: string;
    createdAt: string;
    updatedAt: string;
}

export class DatabaseManager {
    private db: Database.Database;
    private dbPath: string;

    constructor(dbPath: string) {
        this.dbPath = dbPath;

        // Ensure directory exists
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(dbPath);
        this.initTables();
        logger.info(`Database initialized at: ${dbPath}`);
    }

    private initTables(): void {
        // Profiles table
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

        // Ensure unique profile paths
        this.runMigration('unique_profile_path', () => {
            this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_profilePath ON profiles(profilePath)`);
        });

        // Sessions table - simplified to only track tier and active status
        // NOTE: Session data (cookies, localStorage) is automatically stored in Chromium profile
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                profileId TEXT NOT NULL,
                tier TEXT DEFAULT 'PAYGATE_TIER_ONE',
                isActive INTEGER DEFAULT 0,
                createdAt TEXT NOT NULL,
                updatedAt TEXT NOT NULL,
                FOREIGN KEY (profileId) REFERENCES profiles(id) ON DELETE CASCADE
            )
        `);

        // Migration: drop old session columns if they exist (for clean schema)
        this.runMigration('drop_old_session_columns', () => {
            const columns = (this.db.pragma('table_info(sessions)') as any[]).map((c) => c.name);
            if (columns.includes('cookies')) {
                this.db.exec('ALTER TABLE sessions DROP COLUMN cookies');
            }
            if (columns.includes('localStorage')) {
                this.db.exec('ALTER TABLE sessions DROP COLUMN localStorage');
            }
            if (columns.includes('sessionStorage')) {
                this.db.exec('ALTER TABLE sessions DROP COLUMN sessionStorage');
            }
        });

        // Create indexes for better performance
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_sessions_profileId ON sessions(profileId);
            CREATE INDEX IF NOT EXISTS idx_sessions_isActive ON sessions(isActive);
        `);

        // Migration tracking table - tracks which migrations have been applied
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS _migrations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                appliedAt TEXT NOT NULL
            )
        `);

        // Entity references table for storing generated entity images
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
                updatedAt TEXT NOT NULL,
                FOREIGN KEY (profileId) REFERENCES profiles(id) ON DELETE CASCADE
            )
        `);

        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_entity_references_profileId ON entity_references(profileId);
            CREATE INDEX IF NOT EXISTS idx_entity_references_entityType ON entity_references(entityType);
        `);

        // Migration: Add imagePrompt column if it doesn't exist (for existing databases)
        this.runMigration('add_entity_imagePrompt', () => {
            this.db.exec(`ALTER TABLE entity_references ADD COLUMN imagePrompt TEXT`);
        });

        // Migration: Add upscaleResolution column if it doesn't exist (for existing databases)
        this.runMigration('add_entity_upscaleResolution', () => {
            this.db.exec(`ALTER TABLE entity_references ADD COLUMN upscaleResolution TEXT DEFAULT 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL'`);
        });

        // Script references table for storing generated video scripts
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
                updatedAt TEXT NOT NULL,
                FOREIGN KEY (profileId) REFERENCES profiles(id) ON DELETE CASCADE
            )
        `);

        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_script_references_profileId ON script_references(profileId);
            CREATE INDEX IF NOT EXISTS idx_script_references_projectId ON script_references(projectId);
        `);

        // Video pipelines table
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
            CREATE INDEX IF NOT EXISTS idx_video_pipelines_status ON video_pipelines(status);
            CREATE INDEX IF NOT EXISTS idx_video_pipelines_projectId ON video_pipelines(projectId);
            CREATE INDEX IF NOT EXISTS idx_video_pipelines_scriptId ON video_pipelines(scriptId);
        `);

        // Scene tasks table
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
            CREATE INDEX IF NOT EXISTS idx_scene_tasks_pipelineId ON scene_tasks(pipelineId);
            CREATE INDEX IF NOT EXISTS idx_scene_tasks_pipeline_scene ON scene_tasks(pipelineId, sceneIndex);
            CREATE INDEX IF NOT EXISTS idx_scene_tasks_status ON scene_tasks(status);
            CREATE INDEX IF NOT EXISTS idx_scene_tasks_assignedProfileId ON scene_tasks(assignedProfileId);
        `);

        // Video project settings table
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

        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_video_project_settings_projectId ON video_project_settings(projectId);
        `);

        logger.info('Database tables initialized (simplified - session data stored in Chromium profile)');
    }

    // Profile operations
    createProfile(profile: Omit<ProfileRecord, 'createdAt' | 'updatedAt'>): ProfileRecord {
        const now = new Date().toISOString();
        const stmt = this.db.prepare(`
            INSERT INTO profiles (id, name, profilePath, metadata, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        stmt.run(profile.id, profile.name, profile.profilePath, profile.metadata, now, now);

        return {
            ...profile,
            createdAt: now,
            updatedAt: now,
        };
    }

    getProfile(id: string): ProfileRecord | undefined {
        const stmt = this.db.prepare('SELECT * FROM profiles WHERE id = ?');
        return stmt.get(id) as ProfileRecord | undefined;
    }

    getAllProfiles(): ProfileRecord[] {
        const stmt = this.db.prepare('SELECT * FROM profiles ORDER BY createdAt DESC');
        return stmt.all() as ProfileRecord[];
    }

    updateProfile(id: string, updates: Partial<Omit<ProfileRecord, 'id' | 'createdAt' | 'updatedAt'>>): boolean {
        const now = new Date().toISOString();
        const fields: string[] = [];
        const values: any[] = [];

        if (updates.name !== undefined) {
            fields.push('name = ?');
            values.push(updates.name);
        }
        if (updates.profilePath !== undefined) {
            fields.push('profilePath = ?');
            values.push(updates.profilePath);
        }
        if (updates.metadata !== undefined) {
            fields.push('metadata = ?');
            values.push(updates.metadata);
        }

        if (fields.length === 0) return false;

        fields.push('updatedAt = ?');
        values.push(now, id);

        const stmt = this.db.prepare(`
            UPDATE profiles SET ${fields.join(', ')} WHERE id = ?
        `);

        const result = stmt.run(...values);
        return result.changes > 0;
    }

    deleteProfile(id: string): boolean {
        // Also delete associated session record
        this.deleteSessionsByProfileId(id);
        const stmt = this.db.prepare('DELETE FROM profiles WHERE id = ?');
        const result = stmt.run(id);
        return result.changes > 0;
    }

    // Session operations (simplified - only tier tracking)
    createSession(session: Omit<SessionRecord, 'createdAt' | 'updatedAt'>): SessionRecord {
        const now = new Date().toISOString();
        const stmt = this.db.prepare(`
            INSERT INTO sessions (id, profileId, tier, isActive, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            session.id,
            session.profileId,
            session.tier,
            session.isActive ? 1 : 0,
            now,
            now
        );

        return {
            ...session,
            createdAt: now,
            updatedAt: now,
        };
    }

    getSession(id: string): SessionRecord | undefined {
        const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
        const result = stmt.get(id) as any;
        if (!result) return undefined;

        return {
            ...result,
            isActive: result.isActive === 1,
        };
    }

    getSessionByProfileId(profileId: string): SessionRecord | undefined {
        const stmt = this.db.prepare('SELECT * FROM sessions WHERE profileId = ? ORDER BY updatedAt DESC LIMIT 1');
        const result = stmt.get(profileId) as any;
        if (!result) return undefined;

        return {
            ...result,
            isActive: result.isActive === 1,
        };
    }

    getAllSessions(): SessionRecord[] {
        const stmt = this.db.prepare('SELECT * FROM sessions ORDER BY updatedAt DESC');
        const results = stmt.all() as any[];

        return results.map(r => ({
            ...r,
            isActive: r.isActive === 1,
        }));
    }

    getActiveSessions(): SessionRecord[] {
        const stmt = this.db.prepare('SELECT * FROM sessions WHERE isActive = 1');
        const results = stmt.all() as any[];

        return results.map(r => ({
            ...r,
            isActive: true,
        }));
    }

    updateSession(id: string, updates: Partial<Omit<SessionRecord, 'id' | 'profileId' | 'createdAt' | 'updatedAt'>>): boolean {
        const now = new Date().toISOString();
        const fields: string[] = [];
        const values: any[] = [];

        if (updates.tier !== undefined) {
            fields.push('tier = ?');
            values.push(updates.tier);
        }
        if (updates.isActive !== undefined) {
            fields.push('isActive = ?');
            values.push(updates.isActive ? 1 : 0);
        }

        if (fields.length === 0) return false;

        fields.push('updatedAt = ?');
        values.push(now, id);

        const stmt = this.db.prepare(`
            UPDATE sessions SET ${fields.join(', ')} WHERE id = ?
        `);

        const result = stmt.run(...values);
        return result.changes > 0;
    }

    deleteSession(id: string): boolean {
        const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
        const result = stmt.run(id);
        return result.changes > 0;
    }

    deleteSessionsByProfileId(profileId: string): boolean {
        const stmt = this.db.prepare('DELETE FROM sessions WHERE profileId = ?');
        const result = stmt.run(profileId);
        return result.changes > 0;
    }

    // Entity reference operations
    createEntityReference(entity: Omit<EntityReferenceRecord, 'createdAt' | 'updatedAt'>): EntityReferenceRecord {
        const now = new Date().toISOString();
        const stmt = this.db.prepare(`
            INSERT INTO entity_references (id, name, description, imagePrompt, entityType, materialId, mediaId, localPath, remoteUrl, profileId, projectId, aspectRatio, upscaleResolution, metadata, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
            entity.id,
            entity.name,
            entity.description || '',
            entity.imagePrompt || '',
            entity.entityType || 'character',
            entity.materialId || '3d_pixar',
            entity.mediaId || '',
            entity.localPath || '',
            entity.remoteUrl || '',
            entity.profileId,
            entity.projectId || '',
            entity.aspectRatio || 'IMAGE_ASPECT_RATIO_PORTRAIT',
            entity.upscaleResolution || 'UPSAMPLE_IMAGE_RESOLUTION_ORIGINAL',
            entity.metadata || '{}',
            now,
            now
        );

        return {
            ...entity,
            createdAt: now,
            updatedAt: now,
        };
    }

    getEntityReference(id: string): EntityReferenceRecord | undefined {
        const stmt = this.db.prepare('SELECT * FROM entity_references WHERE id = ?');
        return stmt.get(id) as EntityReferenceRecord | undefined;
    }

    getAllEntityReferences(): EntityReferenceRecord[] {
        const stmt = this.db.prepare('SELECT * FROM entity_references ORDER BY createdAt DESC');
        return stmt.all() as EntityReferenceRecord[];
    }

    getEntityReferencesByProfile(profileId: string): EntityReferenceRecord[] {
        const stmt = this.db.prepare('SELECT * FROM entity_references WHERE profileId = ? ORDER BY createdAt DESC');
        return stmt.all(profileId) as EntityReferenceRecord[];
    }

    getEntityReferencesByType(profileId: string, entityType: string): EntityReferenceRecord[] {
        const stmt = this.db.prepare('SELECT * FROM entity_references WHERE profileId = ? AND entityType = ? ORDER BY createdAt DESC');
        return stmt.all(profileId, entityType) as EntityReferenceRecord[];
    }

    updateEntityReference(id: string, updates: Partial<Omit<EntityReferenceRecord, 'id' | 'profileId' | 'createdAt' | 'updatedAt'>>): boolean {
        const now = new Date().toISOString();
        const fields: string[] = [];
        const values: any[] = [];

        const fieldMap: Record<string, string> = {
            name: 'name',
            description: 'description',
            entityType: 'entityType',
            materialId: 'materialId',
            mediaId: 'mediaId',
            localPath: 'localPath',
            remoteUrl: 'remoteUrl',
            projectId: 'projectId',
            aspectRatio: 'aspectRatio',
            metadata: 'metadata',
            imagePrompt: 'imagePrompt',
            upscaleResolution: 'upscaleResolution',
        };

        for (const [key, dbField] of Object.entries(fieldMap)) {
            if (updates[key as keyof typeof updates] !== undefined) {
                fields.push(`${dbField} = ?`);
                values.push(updates[key as keyof typeof updates]);
            }
        }

        if (fields.length === 0) return false;

        fields.push('updatedAt = ?');
        values.push(now, id);

        const stmt = this.db.prepare(`
            UPDATE entity_references SET ${fields.join(', ')} WHERE id = ?
        `);

        const result = stmt.run(...values);
        return result.changes > 0;
    }

    deleteEntityReference(id: string): boolean {
        const stmt = this.db.prepare('DELETE FROM entity_references WHERE id = ?');
        const result = stmt.run(id);
        return result.changes > 0;
    }

    // Script reference operations
    createScriptReference(script: Omit<ScriptReferenceRecord, 'createdAt' | 'updatedAt'>): ScriptReferenceRecord {
        const now = new Date().toISOString();
        const stmt = this.db.prepare(`
            INSERT INTO script_references (id, projectId, profileId, name, version, input_type, topic, storytelling_mode, duration_text, copy_ratio, material_id, content, metadata, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            script.id,
            script.projectId || null,
            script.profileId,
            script.name,
            script.version,
            script.input_type || null,
            script.topic || null,
            script.storytelling_mode || 'auto',
            script.duration_text || '60',
            script.copy_ratio || 90,
            script.material_id || null,
            script.content,
            typeof script.metadata === 'string' ? script.metadata : JSON.stringify(script.metadata || {}),
            now,
            now
        );
        return this.getScriptReference(script.id)!;
    }

    getScriptReference(id: string): ScriptReferenceRecord | null {
        const stmt = this.db.prepare('SELECT * FROM script_references WHERE id = ?');
        const row = stmt.get(id) as ScriptReferenceRecord | undefined;
        return row || null;
    }

    getScriptReferencesByProfile(profileId: string): ScriptReferenceRecord[] {
        const stmt = this.db.prepare('SELECT * FROM script_references WHERE profileId = ? ORDER BY createdAt DESC');
        return stmt.all(profileId) as ScriptReferenceRecord[];
    }

    getScriptReferencesByProject(projectId: string): ScriptReferenceRecord[] {
        const stmt = this.db.prepare('SELECT * FROM script_references WHERE projectId = ? ORDER BY version ASC');
        return stmt.all(projectId) as ScriptReferenceRecord[];
    }

    getNextScriptVersion(projectId: string, profileId: string): number {
        const stmt = this.db.prepare(
            'SELECT MAX(version) as maxVersion FROM script_references WHERE projectId = ? AND profileId = ?'
        );
        const row = stmt.get(projectId, profileId) as { maxVersion: number | null } | undefined;
        return (row?.maxVersion || 0) + 1;
    }

    updateScriptReference(id: string, updates: Partial<Omit<ScriptReferenceRecord, 'id' | 'profileId' | 'createdAt' | 'updatedAt'>>): boolean {
        const now = new Date().toISOString();
        const fields: string[] = [];
        const values: any[] = [];

        const fieldMap: Record<string, string> = {
            name: 'name',
            version: 'version',
            input_type: 'input_type',
            topic: 'topic',
            storytelling_mode: 'storytelling_mode',
            duration_text: 'duration_text',
            copy_ratio: 'copy_ratio',
            material_id: 'material_id',
            content: 'content',
            metadata: 'metadata',
        };

        for (const [key, dbField] of Object.entries(fieldMap)) {
            if (updates[key as keyof typeof updates] !== undefined) {
                fields.push(`${dbField} = ?`);
                values.push(updates[key as keyof typeof updates]);
            }
        }

        if (fields.length === 0) return false;

        fields.push('updatedAt = ?');
        values.push(now, id);

        const stmt = this.db.prepare(`
            UPDATE script_references SET ${fields.join(', ')} WHERE id = ?
        `);

        const result = stmt.run(...values);
        return result.changes > 0;
    }

    deleteScriptReference(id: string): boolean {
        // First delete all pipelines associated with this script
        const pipelineStmt = this.db.prepare('DELETE FROM video_pipelines WHERE scriptId = ?');
        pipelineStmt.run(id);

        // Delete the script reference
        const stmt = this.db.prepare('DELETE FROM script_references WHERE id = ?');
        const result = stmt.run(id);
        return result.changes > 0;
    }

    deleteScriptReferencesByProject(projectId: string): number {
        const stmt = this.db.prepare('DELETE FROM script_references WHERE projectId = ?');
        const result = stmt.run(projectId);
        return result.changes;
    }

    // ==================== VIDEO PIPELINE OPERATIONS ====================

    createVideoPipeline(pipeline: Omit<VideoPipelineRecord, 'createdAt' | 'updatedAt'>): VideoPipelineRecord {
        const now = new Date().toISOString();
        const stmt = this.db.prepare(`
            INSERT INTO video_pipelines (id, name, projectId, scriptId, profileIds, status, config, totalScenes, completedScenes, failedScenes, outputFolder, errorMessage, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            pipeline.id,
            pipeline.name,
            pipeline.projectId || null,
            pipeline.scriptId,
            pipeline.profileIds,
            pipeline.status || 'pending',
            pipeline.config || '{}',
            pipeline.totalScenes || 0,
            pipeline.completedScenes || 0,
            pipeline.failedScenes || 0,
            pipeline.outputFolder || '',
            pipeline.errorMessage || '',
            now,
            now
        );
        return {
            ...pipeline,
            createdAt: now,
            updatedAt: now,
        } as VideoPipelineRecord;
    }

    getVideoPipeline(id: string): VideoPipelineRecord | undefined {
        const stmt = this.db.prepare('SELECT * FROM video_pipelines WHERE id = ?');
        return stmt.get(id) as VideoPipelineRecord | undefined;
    }

    getAllVideoPipelines(): VideoPipelineRecord[] {
        const stmt = this.db.prepare('SELECT * FROM video_pipelines ORDER BY createdAt DESC');
        return stmt.all() as VideoPipelineRecord[];
    }

    getVideoPipelinesByStatus(status: string): VideoPipelineRecord[] {
        const stmt = this.db.prepare('SELECT * FROM video_pipelines WHERE status = ? ORDER BY createdAt DESC');
        return stmt.all(status) as VideoPipelineRecord[];
    }

    getVideoPipelinesByProject(projectId: string): VideoPipelineRecord[] {
        const stmt = this.db.prepare('SELECT * FROM video_pipelines WHERE projectId = ? ORDER BY createdAt DESC');
        return stmt.all(projectId) as VideoPipelineRecord[];
    }

    updateVideoPipeline(id: string, updates: Partial<Omit<VideoPipelineRecord, 'id' | 'createdAt' | 'updatedAt'>>): boolean {
        const now = new Date().toISOString();
        const fields: string[] = [];
        const values: any[] = [];

        const fieldMap: Record<string, string> = {
            name: 'name',
            projectId: 'projectId',
            scriptId: 'scriptId',
            profileIds: 'profileIds',
            status: 'status',
            config: 'config',
            totalScenes: 'totalScenes',
            completedScenes: 'completedScenes',
            failedScenes: 'failedScenes',
            outputFolder: 'outputFolder',
            errorMessage: 'errorMessage',
        };

        for (const [key, dbField] of Object.entries(fieldMap)) {
            if (updates[key as keyof typeof updates] !== undefined) {
                fields.push(`${dbField} = ?`);
                values.push(updates[key as keyof typeof updates]);
            }
        }

        if (fields.length === 0) return false;

        fields.push('updatedAt = ?');
        values.push(now, id);

        const stmt = this.db.prepare(`UPDATE video_pipelines SET ${fields.join(', ')} WHERE id = ?`);
        const result = stmt.run(...values);
        return result.changes > 0;
    }

    deleteVideoPipeline(id: string): boolean {
        // First delete all scene tasks for this pipeline
        const taskStmt = this.db.prepare('DELETE FROM scene_tasks WHERE pipelineId = ?');
        taskStmt.run(id);

        // Delete the pipeline
        const stmt = this.db.prepare('DELETE FROM video_pipelines WHERE id = ?');
        const result = stmt.run(id);
        return result.changes > 0;
    }

    // ==================== SCENE TASK OPERATIONS ====================

    createSceneTask(task: Omit<SceneTaskRecord, 'startedAt' | 'completedAt'>): SceneTaskRecord {
        const now = new Date().toISOString();
        const stmt = this.db.prepare(`
            INSERT INTO scene_tasks (id, pipelineId, sceneIndex, sceneData, status, assignedProfileId, imageUrl, videoUrl, characterRefs, progress, error, startedAt, completedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
            task.id,
            task.pipelineId,
            task.sceneIndex,
            task.sceneData,
            task.status || 'pending',
            task.assignedProfileId || '',
            task.imageUrl || '',
            task.videoUrl || '',
            task.characterRefs || '{}',
            task.progress || 0,
            task.error || '',
            null,
            null
        );
        return {
            ...task,
            startedAt: '',
            completedAt: '',
        } as SceneTaskRecord;
    }

    createSceneTasks(tasks: Omit<SceneTaskRecord, 'startedAt' | 'completedAt'>[]): void {
        const stmt = this.db.prepare(`
            INSERT INTO scene_tasks (id, pipelineId, sceneIndex, sceneData, status, assignedProfileId, imageUrl, videoUrl, characterRefs, progress, error, startedAt, completedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMany = this.db.transaction((items: Omit<SceneTaskRecord, 'startedAt' | 'completedAt'>[]) => {
            for (const task of items) {
                stmt.run(
                    task.id,
                    task.pipelineId,
                    task.sceneIndex,
                    task.sceneData,
                    task.status || 'pending',
                    task.assignedProfileId || '',
                    task.imageUrl || '',
                    task.videoUrl || '',
                    task.characterRefs || '{}',
                    task.progress || 0,
                    task.error || '',
                    null,
                    null
                );
            }
        });

        insertMany(tasks);
    }

    getSceneTask(id: string): SceneTaskRecord | undefined {
        const stmt = this.db.prepare('SELECT * FROM scene_tasks WHERE id = ?');
        return stmt.get(id) as SceneTaskRecord | undefined;
    }

    getSceneTasksByPipeline(pipelineId: string): SceneTaskRecord[] {
        const stmt = this.db.prepare('SELECT * FROM scene_tasks WHERE pipelineId = ? ORDER BY sceneIndex ASC');
        return stmt.all(pipelineId) as SceneTaskRecord[];
    }

    getSceneTaskByPipelineAndIndex(pipelineId: string, sceneIndex: number): SceneTaskRecord | undefined {
        const stmt = this.db.prepare('SELECT * FROM scene_tasks WHERE pipelineId = ? AND sceneIndex = ?');
        return stmt.get(pipelineId, sceneIndex) as SceneTaskRecord | undefined;
    }

    getSceneTaskForProfile(profileId: string, pipelineId: string): SceneTaskRecord | undefined {
        const stmt = this.db.prepare('SELECT * FROM scene_tasks WHERE assignedProfileId = ? AND pipelineId = ? AND status IN ("pending", "assigned") ORDER BY sceneIndex ASC LIMIT 1');
        return stmt.get(profileId, pipelineId) as SceneTaskRecord | undefined;
    }

    getNextPendingTaskForProfile(profileId: string, pipelineId: string): SceneTaskRecord | undefined {
        const stmt = this.db.prepare('SELECT * FROM scene_tasks WHERE pipelineId = ? AND status = "pending" ORDER BY sceneIndex ASC LIMIT 1');
        return stmt.get(pipelineId) as SceneTaskRecord | undefined;
    }

    updateSceneTask(id: string, updates: Partial<Omit<SceneTaskRecord, 'id' | 'pipelineId' | 'sceneIndex' | 'sceneData' | 'startedAt' | 'completedAt'>>): boolean {
        const now = new Date().toISOString();
        const fields: string[] = [];
        const values: any[] = [];

        const fieldMap: Record<string, string> = {
            status: 'status',
            assignedProfileId: 'assignedProfileId',
            imageUrl: 'imageUrl',
            videoUrl: 'videoUrl',
            characterRefs: 'characterRefs',
            progress: 'progress',
            error: 'error',
        };

        for (const [key, dbField] of Object.entries(fieldMap)) {
            if (updates[key as keyof typeof updates] !== undefined) {
                fields.push(`${dbField} = ?`);
                values.push(updates[key as keyof typeof updates]);
            }
        }

        if (fields.length === 0) return false;

        // Auto-set startedAt when status changes to 'generating'
        if (updates.status === 'generating') {
            fields.push('startedAt = ?');
            values.push(now);
        }

        // Auto-set completedAt when status changes to 'completed' or 'failed'
        if (updates.status === 'completed' || updates.status === 'failed') {
            fields.push('completedAt = ?');
            values.push(now);
        }

        values.push(id);

        const stmt = this.db.prepare(`UPDATE scene_tasks SET ${fields.join(', ')} WHERE id = ?`);
        const result = stmt.run(...values);
        return result.changes > 0;
    }

    deleteSceneTask(id: string): boolean {
        const stmt = this.db.prepare('DELETE FROM scene_tasks WHERE id = ?');
        const result = stmt.run(id);
        return result.changes > 0;
    }

    deleteSceneTasksByPipeline(pipelineId: string): number {
        const stmt = this.db.prepare('DELETE FROM scene_tasks WHERE pipelineId = ?');
        const result = stmt.run(pipelineId);
        return result.changes;
    }

    // ==================== VIDEO PROJECT SETTINGS OPERATIONS ====================

    getVideoProjectSettings(projectId: string): VideoProjectSettingsRecord | undefined {
        const stmt = this.db.prepare('SELECT * FROM video_project_settings WHERE projectId = ?');
        return stmt.get(projectId) as VideoProjectSettingsRecord | undefined;
    }

    createOrUpdateVideoProjectSettings(settings: Omit<VideoProjectSettingsRecord, 'createdAt' | 'updatedAt'>): VideoProjectSettingsRecord {
        const now = new Date().toISOString();
        const existing = this.getVideoProjectSettings(settings.projectId);

        if (existing) {
            const stmt = this.db.prepare(`
                UPDATE video_project_settings SET selectedProfileIds = ?, defaultModel = ?, defaultDuration = ?, defaultAspectRatio = ?, updatedAt = ?
                WHERE projectId = ?
            `);
            stmt.run(settings.selectedProfileIds, settings.defaultModel, settings.defaultDuration, settings.defaultAspectRatio, now, settings.projectId);
            return {
                ...existing,
                ...settings,
                updatedAt: now,
            };
        } else {
            const stmt = this.db.prepare(`
                INSERT INTO video_project_settings (id, projectId, selectedProfileIds, defaultModel, defaultDuration, defaultAspectRatio, createdAt, updatedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            stmt.run(settings.id, settings.projectId, settings.selectedProfileIds, settings.defaultModel, settings.defaultDuration, settings.defaultAspectRatio, now, now);
            return {
                ...settings,
                createdAt: now,
                updatedAt: now,
            };
        }
    }

    deleteVideoProjectSettings(projectId: string): boolean {
        const stmt = this.db.prepare('DELETE FROM video_project_settings WHERE projectId = ?');
        const result = stmt.run(projectId);
        return result.changes > 0;
    }

    // Helper method for running migrations with tracking
    private runMigration(name: string, migrationFn: () => void): void {
        const existing = this.db.prepare('SELECT id FROM _migrations WHERE name = ?').get(name);
        if (existing) {
            return; // Already applied
        }

        try {
            migrationFn();
            this.db.prepare('INSERT INTO _migrations (name, appliedAt) VALUES (?, ?)').run(name, new Date().toISOString());
            logger.info(`Migration applied: ${name}`);
        } catch (err: any) {
            if (!err.message?.includes('duplicate column') && !err.message?.includes('no such column')) {
                logger.warn(`Migration ${name} failed: ${err.message}`);
            }
        }
    }

    // Close database connection
    close(): void {
        this.db.close();
        logger.info('Database connection closed');
    }

    // Backup database
    backup(backupPath: string): void {
        this.db.backup(backupPath);
        logger.info(`Database backed up to: ${backupPath}`);
    }
}
