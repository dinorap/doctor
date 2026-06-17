/**
 * Test upscale on existing image
 */
import * as fs from 'fs';
import * as path from 'path';

const PROFILE_ID = '2f97f3b0-ade6-4f65-8aae-ef3fc3b95d57';
const SERVER_URL = 'http://localhost:3000';

async function main() {
    console.log('='.repeat(60));
    console.log('Test Upscale - Profile already open');
    console.log('='.repeat(60));

    const testImagePath = path.join(process.cwd(), 'data', 'entity-references', PROFILE_ID, '7b96d916-9f2f-41b1-873b-cd18ee6d1748.jpg');
    if (fs.existsSync(testImagePath)) {
        const stats = fs.statSync(testImagePath);
        console.log(`Source image: ${(stats.size / 1024).toFixed(2)} KB`);
    }

    console.log('\nSending upscale request...');
    try {
        const res = await fetch(`${SERVER_URL}/api/entities/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Test Con Ga',
                description: 'A cute cartoon chicken',
                profileId: PROFILE_ID,
                entityType: 'character',
                materialId: '3d_pixar',
                upscaleResolution: 'UPSAMPLE_IMAGE_RESOLUTION_2K',
            }),
        });
        const result = await res.json();
        console.log('\nResult:', JSON.stringify(result, null, 2));
    } catch (e) {
        console.error('Error:', e);
    }
}

main();
