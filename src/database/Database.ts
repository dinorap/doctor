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

        // Create indexes for better performance
        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_sessions_profileId ON sessions(profileId);
            CREATE INDEX IF NOT EXISTS idx_sessions_isActive ON sessions(isActive);
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
