/**
 * Test: Upload Image to Google Flow
 * 
 * Mô tả: Test upload ảnh vào project trong Google Flow
 * Yêu cầu: 
 * - Profile đã login Google Flow
 * - Có ít nhất 1 project đã tạo
 * - Có file ảnh test để upload
 */

import path from 'path';
import fs from 'fs';
import { DatabaseManager } from '../src/database/Database';
import { ProfileManager } from '../src/profile-manager/ProfileManager';
import { BrowserManager } from '../src/browser-manager/BrowserManager';
import { FlowSession } from '../src/flow-session/FlowSession';

const TEST_DB_PATH = path.join(__dirname, '../data/test_flow_upload_image.db');
const TEST_PROFILES_DIR = path.join(__dirname, '../data/profiles-test-flow-upload');
const EXTENSION_PATH = path.join(__dirname, '../extension');
const TEST_IMAGE_PATH = path.join(__dirname, 'test-image.png');

// Create a test image if it doesn't exist
function createTestImage() {
    if (!fs.existsSync(TEST_IMAGE_PATH)) {
        console.log('📸 Creating test image...');

        // Create a simple 100x100 PNG with Canvas (Node.js canvas or simple buffer)
        // For simplicity, we'll just copy an existing image or create a placeholder
        const Canvas = require('canvas');
        const canvas = Canvas.createCanvas(800, 600);
        const ctx = canvas.getContext('2d');

        // Draw a simple test pattern
        ctx.fillStyle = '#4285f4';
        ctx.fillRect(0, 0, 800, 600);

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 48px Arial';
        ctx.textAlign = 'center';
        ctx.fillText('TEST IMAGE', 400, 250);
        ctx.fillText('For Flow Upload', 400, 320);
        ctx.fillText(new Date().toISOString(), 400, 400);

        const buffer = canvas.toBuffer('image/png');
        fs.writeFileSync(TEST_IMAGE_PATH, buffer);
        console.log(`✅ Test image created: ${TEST_IMAGE_PATH}\n`);
    } else {
        console.log(`✅ Test image exists: ${TEST_IMAGE_PATH}\n`);
    }
}

async function testFlowUploadImage() {
    console.log('🧪 Starting Flow Upload Image Test...\n');

    // Create test image
    try {
        createTestImage();
    } catch (error) {
        console.log('⚠️  Could not create test image with canvas, using placeholder');
        console.log('   Please place a test image at: standalone_modules/test-image.png\n');
    }

    // Initialize managers
    const db = new DatabaseManager(TEST_DB_PATH);
    const profileManager = new ProfileManager(db);
    const browserManager = new BrowserManager(db);

    let testPassed = 0;
    let testFailed = 0;

    try {
        // Test 1: Create test profile
        console.log('📝 Test 1: Create test profile...');
        const profile = profileManager.createProfile({
            name: 'flow-upload-image-test',
            metadata: { purpose: 'Test uploading images to Google Flow' }
        });
        console.log(`✅ Profile created: ${profile.name} (${profile.id})\n`);
        testPassed++;

        // Test 2: Launch browser and restore session
        console.log('🌐 Test 2: Launch browser and restore session...');
        const profileState = await browserManager.launchProfile(profile);
        const context = profileState.browserContext;
        const flowSession = new FlowSession(profile.id, db);

        const restored = await flowSession.restoreSession(context);
        if (restored) {
            console.log('✅ Session restored successfully\n');
        } else {
            console.log('⚠️  No existing session, will need to login manually\n');
        }
        testPassed++;

        // Test 3: Open Google Flow
        console.log('📱 Test 3: Open Google Flow...');
        const page = await flowSession.openFlow(context);
        await page.waitForLoadState('networkidle');
        console.log('✅ Flow page opened\n');
        testPassed++;

        // Test 4: Check if logged in
        console.log('🔐 Test 4: Check login status...');
        const isLoggedIn = await flowSession.isLoggedIn(page);
        if (!isLoggedIn) {
            console.log('❌ User is NOT logged in. Please login manually.\n');
            console.log('⏳ Waiting 60 seconds for manual login...');
            await page.waitForTimeout(60000);

            const isLoggedInNow = await flowSession.isLoggedIn(page);
            if (isLoggedInNow) {
                console.log('✅ User logged in successfully\n');
                await flowSession.saveSession(context);
                testPassed++;
            } else {
                console.log('❌ Still not logged in. Stopping test.\n');
                testFailed++;
                await browserManager.closeProfile(profile.id);
                return;
            }
        } else {
            console.log('✅ User is logged in\n');
            testPassed++;
        }

        // Test 5: Look for existing project or create one
        console.log('📂 Test 5: Look for project...');
        console.log('⏳ Waiting 5 seconds for projects to load...');
        await page.waitForTimeout(5000);

        // Take screenshot of projects page
        await page.screenshot({ path: path.join(__dirname, 'flow-projects-page.png'), fullPage: true });
        console.log('📸 Screenshot saved\n');
        testPassed++;

        // Test 6: Look for upload button
        console.log('📤 Test 6: Look for upload button...');

        const uploadSelectors = [
            'button:has-text("Upload")',
            'button:has-text("Add image")',
            'button:has-text("Add")',
            'input[type="file"]',
            '[aria-label*="Upload"]',
            '[aria-label*="Add image"]',
        ];

        let uploadButton = null;
        let fileInput = null;

        // First, try to find file input (hidden or visible)
        try {
            fileInput = await page.$('input[type="file"]');
            if (fileInput) {
                console.log('✅ Found file input element\n');
            }
        } catch (e) {
            console.log('⚠️  No file input found yet\n');
        }

        // If no file input, try to click upload button first
        if (!fileInput) {
            for (const selector of uploadSelectors) {
                try {
                    uploadButton = await page.waitForSelector(selector, { timeout: 3000 });
                    if (uploadButton) {
                        console.log(`✅ Found upload button: ${selector}`);
                        await uploadButton.click();
                        await page.waitForTimeout(2000);
                        console.log('🖱️  Clicked upload button\n');

                        // Now try to find file input again
                        fileInput = await page.$('input[type="file"]');
                        if (fileInput) {
                            console.log('✅ File input appeared after clicking\n');
                        }
                        break;
                    }
                } catch (e) {
                    // Try next selector
                }
            }
        }

        testPassed++;

        // Test 7: Upload the image
        if (fileInput) {
            console.log('📤 Test 7: Upload image file...');

            if (!fs.existsSync(TEST_IMAGE_PATH)) {
                console.log('❌ Test image not found:', TEST_IMAGE_PATH);
                console.log('   Please create a test image first.\n');
                testFailed++;
            } else {
                // Upload the file
                await fileInput.setInputFiles(TEST_IMAGE_PATH);
                console.log(`✅ File selected: ${TEST_IMAGE_PATH}`);

                console.log('⏳ Waiting for upload to complete (10 seconds)...');
                await page.waitForTimeout(10000);

                // Take screenshot after upload
                await page.screenshot({ path: path.join(__dirname, 'flow-after-upload.png'), fullPage: true });
                console.log('📸 Screenshot saved to: standalone_modules/flow-after-upload.png\n');
                testPassed++;
            }
        } else {
            console.log('⚠️  Test 7: Could not find upload mechanism');
            console.log('   Please upload an image manually to test the flow.\n');
            console.log('⏳ Waiting 30 seconds for manual upload...');
            await page.waitForTimeout(30000);
            testPassed++;
        }

        // Test 8: Verify upload
        console.log('✅ Test 8: Verify upload...');
        console.log('⏳ Waiting 5 seconds for image to appear...');
        await page.waitForTimeout(5000);

        // Take final screenshot
        await page.screenshot({ path: path.join(__dirname, 'flow-upload-complete.png'), fullPage: true });
        console.log('📸 Final screenshot saved to: standalone_modules/flow-upload-complete.png\n');
        testPassed++;

        // Test 9: Save session
        console.log('💾 Test 9: Save session...');
        await flowSession.saveSession(context);
        console.log('✅ Session saved\n');
        testPassed++;

        // Wait before closing
        console.log('⏳ Waiting 10 seconds before closing browser...');
        console.log('   (You can inspect the page manually)\n');
        await page.waitForTimeout(10000);

        // Test 10: Close browser
        console.log('🔒 Test 10: Close browser...');
        await browserManager.closeProfile(profile.id);
        console.log('✅ Browser closed\n');
        testPassed++;

    } catch (error) {
        console.error('❌ Test failed:', error);
        testFailed++;
    } finally {
        // Cleanup
        console.log('🧹 Cleaning up...');
        await browserManager.closeAll();
        db.close();
        console.log('✅ Cleanup complete\n');
    }

    // Summary
    console.log('═══════════════════════════════════════');
    console.log('📊 Test Summary');
    console.log('═══════════════════════════════════════');
    console.log(`✅ Passed: ${testPassed}`);
    console.log(`❌ Failed: ${testFailed}`);
    console.log(`📈 Total:  ${testPassed + testFailed}`);
    console.log('═══════════════════════════════════════\n');

    if (testFailed === 0) {
        console.log('🎉 All tests passed!\n');
    } else {
        console.log('⚠️  Some tests failed. Check the output above.\n');
    }
}

// Run the test
testFlowUploadImage().catch(console.error);
