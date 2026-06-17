/**
 * Test upscale - Find all existing images and upscale them
 */
import * as fs from 'fs';
import * as path from 'path';
import { ImageUpscalerStandalone } from './image_upscaler';

const PROFILE_ID = '2f97f3b0-ade6-4f65-8aae-ef3fc3b95d57';
const SERVER_URL = 'http://localhost:3000';

async function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('='.repeat(60));
    console.log('Test Upscale - All Existing Images');
    console.log('='.repeat(60));

    const entitiesDir = path.join(process.cwd(), 'data', 'entity-references', PROFILE_ID);
    
    // Find all jpg/png images (exclude _2k and _4k suffixes)
    const allFiles = fs.readdirSync(entitiesDir);
    const imageFiles = allFiles.filter(f => {
        const ext = path.extname(f).toLowerCase();
        return (ext === '.jpg' || ext === '.png') && !f.includes('_2k') && !f.includes('_4k');
    });

    console.log(`Found ${imageFiles.length} images to upscale:`);
    imageFiles.forEach(f => {
        const stats = fs.statSync(path.join(entitiesDir, f));
        console.log(`  - ${f} (${(stats.size / 1024).toFixed(2)} KB)`);
    });

    // Get all image IDs to upscale
    for (const imageFile of imageFiles) {
        const mediaId = path.basename(imageFile, path.extname(imageFile));
        console.log(`\n${'='.repeat(50)}`);
        console.log(`Upscaling: ${imageFile}`);
        
        try {
            const res = await fetch(`${SERVER_URL}/api/entities/upscale`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mediaId,
                    profileId: PROFILE_ID,
                    targetResolution: 'UPSAMPLE_IMAGE_RESOLUTION_2K',
                }),
            });
            const result = await res.json();
            console.log('Result:', JSON.stringify(result, null, 2));
            
            // Wait between requests
            await sleep(3000);
        } catch (e) {
            console.error('Error:', e);
        }
    }
}

main();
