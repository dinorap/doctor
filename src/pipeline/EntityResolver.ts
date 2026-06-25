import path from 'path';
import fs from 'fs';
import { DatabaseManager, EntityReferenceRecord } from '../database/Database';
import logger from '../utils/logger';

export interface EntityMapping {
    characterName: string;
    entityId: string;
    entity: EntityReferenceRecord;
}

export class EntityResolver {
    private db: DatabaseManager;
    private entityCache = new Map<string, EntityReferenceRecord[]>();

    constructor(db: DatabaseManager) {
        this.db = db;
    }

    async resolveSceneEntities(scene: any, profileId: string): Promise<EntityMapping[]> {
        const characters = Array.isArray(scene?.characters) ? scene.characters : [];
        if (!characters.length) return [];

        const mappings: EntityMapping[] = [];
        for (const name of characters) {
            const entity = await this.findBestEntityForCharacter(name, profileId);
            if (entity) {
                mappings.push({
                    characterName: String(name),
                    entityId: entity.id,
                    entity,
                });
            }
        }
        return mappings;
    }

    async findBestEntityForCharacter(name: string, profileId: string): Promise<EntityReferenceRecord | null> {
        const candidates = await this.getEntitiesForProfile(profileId);
        const lowered = String(name).trim().toLowerCase();

        const exact = candidates.find(e => String(e.name).trim().toLowerCase() === lowered);
        if (exact) return exact;

        const partial = candidates.find(e =>
            String(e.name).trim().toLowerCase().includes(lowered) ||
            String(e.description || '').toLowerCase().includes(lowered)
        );
        return partial || null;
    }

    getEntityImageUrl(entityId: string): string | null {
        // Use local reference path if available
        const entity = this.db.getEntityReference(entityId);
        if (!entity) return null;
        if (entity.localPath && fs.existsSync(entity.localPath)) return entity.localPath;
        if (entity.remoteUrl) return entity.remoteUrl;
        return null;
    }

    async downloadEntityImage(entityId: string, outputPath: string): Promise<string | null> {
        const url = this.getEntityImageUrl(entityId);
        if (!url) return null;

        if (fs.existsSync(url)) {
            const ext = path.extname(url) || '.png';
            const dest = path.join(outputPath, `entity_${entityId}${ext}`);
            fs.copyFileSync(url, dest);
            return dest;
        }

        logger.warn(`[EntityResolver] Cannot download entity image for ${entityId} from ${url}`);
        return null;
    }

    private async getEntitiesForProfile(profileId: string): Promise<EntityReferenceRecord[]> {
        if (this.entityCache.has(profileId)) {
            return this.entityCache.get(profileId)!;
        }
        const records = this.db.getEntityReferencesByProfile(profileId);
        this.entityCache.set(profileId, records);
        return records;
    }
}
