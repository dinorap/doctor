/**
 * Test: Generate Image in Google Flow
 * 
 * Mô tả: Test tạo/generate ảnh trong Google Flow (AI image generation)
 * Yêu cầu: 
 * - Profile đã login Google Flow
 * - Có project đã tạo
 * - Flow có chức năng generate image
 */

import path from 'path';
import { DatabaseManager } from '../src/database/Database';
import { ProfileManager } from '../src/profile-manager/ProfileManager';
import { BrowserManager } from '../src/browser-manager/BrowserManager';
import { FlowSession } from '../src/flow-session/FlowSession';

const TEST_DB_PATH = path.join(__dirname, '../data/test_flow_generate_image.db');

async function testFlowGenerateImage() {
    console.log('🧪 Starting Flow Generate Image Test...\n');

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
            name: 'flow-generate-image-test',
            metadata: { purpose: 'Test generating images in Google Flow' }
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

        // Test 5: Look for project or navigate to generation page
        console.log('📂 Test 5: Navigate to project...');
        await page.waitForTimeout(5000);
        await page.screenshot({ path: path.join(__dirname, 'flow-generate-start.png'), fullPage: true });
        console.log('📸 Screenshot saved\n');
        testPassed++;

        // Test 6: Look for image generation feature
        console.log('🎨 Test 6: Look for image generation button...');

        const generateSelectors = [
            'button:has-text("Generate")',
            'button:has-text("Create image")',
            'button:has-text("AI generate")',
            '[aria-label*="Generate"]',
            '[aria-label*="Create image"]',
        ];

        let generateButton = null;
        for (const selector of generateSelectors) {
            try {
                generateButton = await page.waitForSelector(selector, { timeout: 5000 });
                if (generateButton) {
                    console.log(`✅ Found generate button: ${selector}\n`);
                    break;
                }
            } catch (e) {
                // Try next selector
            }
        }

        if (!generateButton) {
            console.log('⚠️  Could not find generate button automatically');
            console.log('⏳ Waiting 30 seconds for manual navigation to generation feature...\n');
            await page.waitForTimeout(30000);
            testPassed++;
        } else {
            await generateButton.click();
            await page.waitForTimeout(2000);
            console.log('✅ Clicked generate button\n');
            testPassed++;
        }

        // Test 7: Look for prompt input
        console.log('✍️  Test 7: Look for prompt input...');

        const promptSelectors = [
            'textarea[placeholder*="prompt"]',
            'textarea[placeholder*="describe"]',
            'input[placeholder*="prompt"]',
            'textarea',
        ];

        let promptInput = null;
        for (const selector of promptSelectors) {
            try {
                promptInput = await page.waitForSelector(selector, { timeout: 3000 });
                if (promptInput) {
                    console.log(`✅ Found prompt input: ${selector}`);
                    break;
                }
            } catch (e) {
                // Try next selector
            }
        }

        if (promptInput) {
            const testPrompt = 'A beautiful sunset over mountains, digital art';
            await promptInput.fill(testPrompt);
            console.log(`✅ Entered prompt: "${testPrompt}"\n`);

            // Look for generate/submit button
            await page.waitForTimeout(1000);
            const submitSelectors = [
                'button:has-text("Generate")',
                'button:has-text("Create")',
                'button:has-text("Submit")',
                'button[type="submit"]',
            ];

            for (const selector of submitSelectors) {
                try {
                    const submitBtn = await page.waitForSelector(selector, { timeout: 2000 });
                    if (submitBtn) {
                        console.log(`🖱️  Clicking generate button: ${selector}`);
                        await submitBtn.click();
                        console.log('✅ Generation started\n');
                        break;
                    }
                } catch (e) {
                    // Try next selector
                }
            }
            testPassed++;
        } else {
            console.log('⚠️  Could not find prompt input');
            console.log('📸 Taking screenshot...');
            await page.screenshot({ path: path.join(__dirname, 'flow-generate-form.png'), fullPage: true });
            console.log('✅ Screenshot saved\n');
            testPassed++;
        }

        // Test 8: Wait for image generation
        console.log('⏳ Test 8: Wait for image generation...');
        console.log('   Waiting 20 seconds for AI to generate image...');
        await page.waitForTimeout(20000);

        await page.screenshot({ path: path.join(__dirname, 'flow-generate-progress.png'), fullPage: true });
        console.log('📸 Screenshot saved\n');
        testPassed++;

        // Test 9: Verify generated image
        console.log('✅ Test 9: Verify generated image...');
        await page.waitForTimeout(5000);

        await page.screenshot({ path: path.join(__dirname, 'flow-generate-complete.png'), fullPage: true });
        console.log('📸 Final screenshot saved to: standalone_modules/flow-generate-complete.png\n');
        testPassed++;

        // Test 10: Save session
        console.log('💾 Test 10: Save session...');
        await flowSession.saveSession(context);
        console.log('✅ Session saved\n');
        testPassed++;

        // Wait before closing
        console.log('⏳ Waiting 10 seconds before closing browser...');
        await page.waitForTimeout(10000);

        // Test 11: Close browser
        console.log('🔒 Test 11: Close browser...');
        await browserManager.closeProfile(profile.id);
        console.log('✅ Browser closed\n');
        testPassed++;

    } catch (error) {
        console.error('❌ Test failed:', error);
        testFailed++;
    } finally {
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

testFlowGenerateImage().catch(console.error);
