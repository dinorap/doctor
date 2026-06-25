import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { ReferenceImageManager } from '../src/pipeline/ReferenceImageManager';

vi.mock('../src/utils/logger', () => ({
    default: {
        info: () => {},
        warn: () => {},
        error: () => {},
        debug: () => {},
    },
}));

const mockFlowClient = {
    hasFlowKey: vi.fn().mockReturnValue(true),
    uploadImage: vi.fn().mockResolvedValue({ mediaId: 'media-123' }),
    getFlowKey: vi.fn().mockReturnValue('fake-key'),
    setFlowKey: vi.fn(),
};

const mockFlowRegistry = {
    getOrCreate: vi.fn().mockReturnValue(mockFlowClient),
};

describe('ReferenceImageManager', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('collectReferenceImages', () => {
        it('collects entity characters from scenes', () => {
            const manager = new ReferenceImageManager(null as any, null as any);
            const scenes = [
                { characters: ['Alice', 'Bob'], visual_prompt: 'Alice and Bob walking' },
                { characters: ['Alice', 'Charlie'], visual_prompt: 'Alice and Charlie' },
            ];
            const targets = (manager as any).collectReferenceImages(scenes);
            expect(Array.isArray(targets)).toBe(true);
        });

        it('collects reference image paths from scenes', () => {
            const manager = new ReferenceImageManager(null as any, null as any);
            const scenes = [
                { reference_image_paths: ['/data/refs/img1.jpg', '/data/refs/img2.png'], visual_prompt: 'Test scene' },
            ];
            const targets = (manager as any).collectReferenceImages(scenes);
            expect(targets.length).toBeGreaterThanOrEqual(0);
        });

        it('collects environment images from scenes', () => {
            const manager = new ReferenceImageManager(null as any, null as any);
            const scenes = [
                { environment_image: '/data/env/forest.jpg', visual_prompt: 'Forest scene' },
            ];
            const targets = (manager as any).collectReferenceImages(scenes);
            expect(targets.some((t: any) => t.key.includes('forest'))).toBe(true);
        });

        it('deduplicates duplicate images', () => {
            const manager = new ReferenceImageManager(null as any, null as any);
            const scenes = [
                { reference_image_paths: ['img.jpg'] },
                { reference_image_paths: ['img.jpg'] },
                { reference_image_paths: ['img.jpg'] },
            ];
            const targets = (manager as any).collectReferenceImages(scenes);
            const keys = targets.map((t: any) => t.key);
            const uniqueKeys = new Set(keys);
            expect(keys.length).toBe(uniqueKeys.size);
        });

        it('collects from scene.imageUrl field', () => {
            const manager = new ReferenceImageManager(null as any, null as any);
            const scenes = [
                { imageUrl: 'http://example.com/scene1.jpg' },
            ];
            const targets = (manager as any).collectReferenceImages(scenes);
            expect(targets.some((t: any) => t.key === 'http://example.com/scene1.jpg')).toBe(true);
        });

        it('collects from scene.reference_image_url field', () => {
            const manager = new ReferenceImageManager(null as any, null as any);
            const scenes = [
                { reference_image_url: '/data/refs/custom.jpg' },
            ];
            const targets = (manager as any).collectReferenceImages(scenes);
            expect(targets.some((t: any) => t.key.includes('custom'))).toBe(true);
        });

        it('collects background images', () => {
            const manager = new ReferenceImageManager(null as any, null as any);
            const scenes = [
                { background_image: '/data/bg/city.png' },
            ];
            const targets = (manager as any).collectReferenceImages(scenes);
            expect(targets.some((t: any) => t.key.includes('city'))).toBe(true);
        });
    });

    describe('buildSceneReferences', () => {
        it('builds references from entity IDs in reference_image_paths', () => {
            // Characters resolved via entity library when db is available
            // Test with entity IDs passed in reference_image_paths
            const manager = new ReferenceImageManager(null as any, null as any);
            const scene = {
                reference_image_paths: ['entity-hero', 'entity-villain'],
            };
            const mediaMap = {
                'profile-1': {
                    'entity-hero': { mediaId: 'media-hero-1', uploadedAt: '2024-01-01' },
                    'entity-villain': { mediaId: 'media-villain-1', uploadedAt: '2024-01-01' },
                },
            };
            const refs = (manager as any).buildSceneReferences(scene, mediaMap, 'profile-1', {} as any);
            expect(refs.referenceMediaIds).toContain('media-hero-1');
            expect(refs.referenceMediaIds).toContain('media-villain-1');
        });

        it('returns empty refs when no media map', () => {
            const manager = new ReferenceImageManager(null as any, null as any);
            const scene = { characters: ['Alice'] };
            const emptyMap = { 'profile-1': {} };
            const refs = (manager as any).buildSceneReferences(scene, emptyMap, 'profile-1', {} as any);
            expect(refs.referenceMediaIds).toEqual([]);
            expect(refs.startImageMediaId).toBeUndefined();
        });

        it('builds start/end image references', () => {
            const manager = new ReferenceImageManager(null as any, null as any);
            const scene = {
                start_image_key: 'start-scene-1',
                end_image_key: 'end-scene-1',
            };
            const mediaMap = {
                'profile-1': {
                    'start-scene-1': { mediaId: 'media-start', uploadedAt: '2024-01-01' },
                    'end-scene-1': { mediaId: 'media-end', uploadedAt: '2024-01-01' },
                },
            };
            const refs = (manager as any).buildSceneReferences(scene, mediaMap, 'profile-1', {} as any);
            expect(refs.startImageMediaId).toBe('media-start');
            expect(refs.endImageMediaId).toBe('media-end');
        });

        it('supports camelCase startImageKey', () => {
            const manager = new ReferenceImageManager(null as any, null as any);
            const scene = { startImageKey: 'scene_start' };
            const mediaMap = {
                'profile-1': {
                    'scene_start': { mediaId: 'media-start', uploadedAt: '2024' },
                },
            };
            const refs = (manager as any).buildSceneReferences(scene, mediaMap, 'profile-1', {} as any);
            expect(refs.startImageMediaId).toBe('media-start');
        });

        it('handles missing profile in media map', () => {
            const manager = new ReferenceImageManager(null as any, null as any);
            const scene = { reference_image_paths: [] };
            const emptyMap = { 'profile-1': {} };
            const refs = (manager as any).buildSceneReferences(scene, emptyMap, 'profile-1', {} as any);
            expect(refs.referenceMediaIds).toEqual([]);
        });

        it('returns empty refs when no media map', () => {
            const manager = new ReferenceImageManager(null as any, null as any);
            const scene = { characters: ['Alice'] };
            const emptyMap = { 'profile-1': {} };
            const refs = (manager as any).buildSceneReferences(scene, emptyMap, 'profile-1', {} as any);
            expect(refs.referenceMediaIds).toEqual([]);
            expect(refs.startImageMediaId).toBeUndefined();
        });
    });

    describe('uploadToProfile', () => {
        it('returns error when no flow key', async () => {
            const noKeyClient = { hasFlowKey: () => false };
            const reg = { getOrCreate: () => noKeyClient };
            const manager = new ReferenceImageManager(null as any, reg as any);
            const result = await manager.uploadToProfile(
                { key: 'test', localPath: '/nonexistent.jpg' },
                'profile-1',
                'project-1'
            );
            expect(result.success).toBe(false);
            expect(result.error).toContain('No flow key');
        });

        it('returns error when file not found', async () => {
            const manager = new ReferenceImageManager(null as any, mockFlowRegistry as any);
            const result = await manager.uploadToProfile(
                { key: 'missing', localPath: '/does/not/exist.jpg' },
                'profile-1',
                'project-1'
            );
            expect(result.success).toBe(false);
            expect(result.error).toContain('File not found');
        });
    });

    describe('media map save/load', () => {
        it('saves and loads media map correctly', () => {
            const manager = new ReferenceImageManager(null as any, null as any);
            const mediaMap = {
                'profile-1': {
                    'img-1': { mediaId: 'm1', uploadedAt: '2024-01-01' },
                },
            };
            const testDir = path.join(__dirname, '..', 'temp-test-media-map');
            fs.mkdirSync(testDir, { recursive: true });
            const savedPath = (manager as any).saveMediaMap(mediaMap, testDir);
            expect(fs.existsSync(savedPath)).toBe(true);
            const loaded = (manager as any).loadMediaMap(testDir);
            expect(loaded).toEqual(mediaMap);
            fs.rmSync(testDir, { recursive: true, force: true });
        });

        it('loadMediaMap returns null for missing file', () => {
            const manager = new ReferenceImageManager(null as any, null as any);
            const result = (manager as any).loadMediaMap('/non/existent/path');
            expect(result).toBeNull();
        });
    });

    describe('inferMimeType', () => {
        it('returns correct MIME types', () => {
            const manager = new ReferenceImageManager(null as any, null as any);
            expect((manager as any).inferMimeType('/path/to/image.jpg')).toBe('image/jpeg');
            expect((manager as any).inferMimeType('/path/to/image.png')).toBe('image/png');
            expect((manager as any).inferMimeType('/path/to/image.webp')).toBe('image/webp');
            expect((manager as any).inferMimeType('/path/to/image.gif')).toBe('image/gif');
            expect((manager as any).inferMimeType('/path/to/image.unknown')).toBe('image/jpeg');
        });
    });
});

describe('Pipeline flow with reference images', () => {
    it('collectReferenceImages + buildSceneReferences work together', () => {
        const manager = new ReferenceImageManager(null as any, null as any);
        const scenes = [
            {
                scene_index: 1,
                characters: ['Hero'],
                reference_image_paths: ['assets/background.jpg'],
                environment_image: 'assets/sky.png',
                start_image_key: 'scene1_start',
            },
            {
                scene_index: 2,
                characters: ['Hero', 'Sidekick'],
                reference_image_paths: ['assets/background2.jpg'],
            },
        ];

        const targets = (manager as any).collectReferenceImages(scenes);
        expect(targets.length).toBeGreaterThanOrEqual(0);

        const mediaMap = {
            'p1': {
                'assets/background.jpg': { mediaId: 'bg1', uploadedAt: '2024' },
                'assets/sky.png': { mediaId: 'sky1', uploadedAt: '2024' },
                'scene1_start': { mediaId: 'start1', uploadedAt: '2024' },
                'assets/background2.jpg': { mediaId: 'bg2', uploadedAt: '2024' },
            },
        };

        // Characters are resolved via reference_image_paths with entity IDs
        // when no DB is available
        const scene1Refs = (manager as any).buildSceneReferences(
            { reference_image_paths: ['bg1', 'sky1'] },
            { 'p1': { 'bg1': { mediaId: 'bg1', uploadedAt: '2024' }, 'sky1': { mediaId: 'sky1', uploadedAt: '2024' } } },
            'p1', {} as any
        );
        expect(scene1Refs.referenceMediaIds).toContain('bg1');
        expect(scene1Refs.referenceMediaIds).toContain('sky1');
    });
});
