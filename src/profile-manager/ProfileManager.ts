import { v4 as uuidv4 } from 'uuid';
import path from 'path';
import fs from 'fs';
import { ProfileConfig, ProfileState } from '../types';
import { CONFIG } from '../config';
import { logger } from '../utils/logger';
import { DatabaseManager } from '../database/Database';

export class ProfileManager {
    private db: DatabaseManager;
    private profilesDir: string;

    constructor(db: DatabaseManager) {
        this.db = db;
        this.profilesDir = CONFIG.paths.profiles;
        this.ensureProfilesDirectory();
    }

    private ensureProfilesDirectory(): void {
        if (!fs.existsSync(this.profilesDir)) {
            fs.mkdirSync(this.profilesDir, { recursive: true });
            logger.info(`Created profiles directory: ${this.profilesDir}`);
        }
    }

    createProfile(config: { name: string; metadata?: Record<string, any> }): ProfileConfig {
        const id = uuidv4();
        const profilePath = path.join(this.profilesDir, id);

        // Create profile directory
        if (!fs.existsSync(profilePath)) {
            fs.mkdirSync(profilePath, { recursive: true });
        }

        // Save to database
        const profileRecord = this.db.createProfile({
            id,
            name: config.name,
            profilePath,
            metadata: JSON.stringify(config.metadata || {}),
        });

        logger.info(`Created new profile: ${config.name} (${id})`);

        return {
            id: profileRecord.id,
            name: profileRecord.name,
            profilePath: profileRecord.profilePath,
            metadata: JSON.parse(profileRecord.metadata),
            createdAt: new Date(profileRecord.createdAt),
            lastUsed: new Date(profileRecord.updatedAt),
        };
    }

    getProfile(id: string): ProfileConfig | null {
        const record = this.db.getProfile(id);
        if (!record) {
            return null;
        }

        return {
            id: record.id,
            name: record.name,
            profilePath: record.profilePath,
            metadata: JSON.parse(record.metadata),
            createdAt: new Date(record.createdAt),
            lastUsed: new Date(record.updatedAt),
        };
    }

    getAllProfiles(): ProfileConfig[] {
        const records = this.db.getAllProfiles();
        return records.map(record => ({
            id: record.id,
            name: record.name,
            profilePath: record.profilePath,
            metadata: JSON.parse(record.metadata),
            createdAt: new Date(record.createdAt),
            lastUsed: new Date(record.updatedAt),
        }));
    }

    updateProfile(id: string, updates: { name?: string; metadata?: Record<string, any> }): boolean {
        const updateData: any = {};

        if (updates.name !== undefined) {
            updateData.name = updates.name;
        }
        if (updates.metadata !== undefined) {
            updateData.metadata = JSON.stringify(updates.metadata);
        }

        const success = this.db.updateProfile(id, updateData);

        if (success) {
            logger.info(`Updated profile: ${id}`);
        }

        return success;
    }

    deleteProfile(id: string): boolean {
        const profile = this.getProfile(id);
        if (!profile) {
            return false;
        }

        // Delete from database (this will cascade delete sessions)
        const success = this.db.deleteProfile(id);

        if (success) {
            // Delete profile directory
            if (fs.existsSync(profile.profilePath)) {
                fs.rmSync(profile.profilePath, { recursive: true, force: true });
                logger.info(`Deleted profile directory: ${profile.profilePath}`);
            }

            logger.info(`Deleted profile: ${id}`);
        }

        return success;
    }

    profileExists(id: string): boolean {
        return this.getProfile(id) !== null;
    }

    touchProfile(id: string): void {
        // Update the updatedAt timestamp
        this.db.updateProfile(id, {});
    }
}
