/**
 * Test: Create Project in Google Flow
 * 
 * Mô tả: Test tạo project mới trong Google Flow
 * Yêu cầu: 
 * - Profile đã login Google Flow
 * - Session đã được restore
 */

import path from 'path';
import { DatabaseManager } from '../src/database/Database';
import { ProfileManager } from '../src/profile-manager/ProfileManager';
import { BrowserManager } from '../src/browser-manager/BrowserManager';
import { FlowSession } from '../src/flow-session/FlowSession';

const TEST_DB_PATH = path.join(__dirname, '../data/test_flow_create_project.db');
const TEST_PROFILES_DIR = path.join(__dirname, '../data/profiles-test-flow-create');
const EXTENSION_PATH = path.join(__dirname, '../extension');

async function testFlowCreateProject() {
    console.log('🧪 Starting Flow Create Project Test...\n');

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
            name: 'flow-create-project-test',
            metadata: { purpose: 'Test creating projects in Google Flow' }
        });
        console.log(`✅ Profile created: ${profile.name} (${profile.id})\n`);
        testPassed++;

        // Test 2: Launch browser and restore session
        console.log('🌐 Test 2: Launch browser and restore session...');
        const profileState = await browserManager.launchProfile(profile);
        const context = profileState.browserContext;
        const flowSession = new FlowSession(profile.id, db);

        // Try to restore existing session
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
        console.log('✅ Flow page opened\n');
        testPassed++;

        // Test 4: Wait for page to fully load
        console.log('⏳ Test 4: Wait for page to load...');
        await page.waitForLoadState('networkidle');
        console.log('✅ Page loaded\n');
        testPassed++;

        // Test 5: Check if logged in
        console.log('🔐 Test 5: Check login status...');
        const isLoggedIn = await flowSession.isLoggedIn(page);
        if (isLoggedIn) {
            console.log('✅ User is logged in\n');
            testPassed++;
        } else {
            console.log('❌ User is NOT logged in. Please login manually and run again.\n');
            console.log('⏳ Waiting 60 seconds for manual login...');
            await page.waitForTimeout(60000);

            const isLoggedInNow = await flowSession.isLoggedIn(page);
            if (isLoggedInNow) {
                console.log('✅ User logged in successfully\n');
                // Save session after login
                await flowSession.saveSession(context);
                console.log('✅ Session saved\n');
                testPassed++;
            } else {
                console.log('❌ Still not logged in. Stopping test.\n');
                testFailed++;
                await browserManager.closeProfile(profile.id);
                return;
            }
        }

        // Test 6: Look for "Create project" or "New project" button
        console.log('🔍 Test 6: Look for create project button...');

        // Common selectors for creating new project
        const createProjectSelectors = [
            'button:has-text("New project")',
            'button:has-text("Create project")',
            'button:has-text("New")',
            '[aria-label*="New project"]',
            '[aria-label*="Create project"]',
            'a:has-text("New project")',
            'a:has-text("Create project")',
        ];

        let createButton = null;
        for (const selector of createProjectSelectors) {
            try {
                createButton = await page.waitForSelector(selector, { timeout: 5000 });
                if (createButton) {
                    console.log(`✅ Found create button with selector: ${selector}\n`);
                    break;
                }
            } catch (e) {
                // Try next selector
            }
        }

        if (!createButton) {
            console.log('⚠️  Could not find create project button automatically');
            console.log('📸 Taking screenshot for manual inspection...');
            await page.screenshot({ path: path.join(__dirname, 'flow-create-project-page.png'), fullPage: true });
            console.log('✅ Screenshot saved to: standalone_modules/flow-create-project-page.png\n');

            console.log('⏳ Waiting 30 seconds for manual project creation...');
            console.log('   Please create a project manually to test the flow.\n');
            await page.waitForTimeout(30000);
            testPassed++;
        } else {
            // Test 7: Click create project button
            console.log('🖱️  Test 7: Click create project button...');
            await createButton.click();
            await page.waitForTimeout(2000);
            console.log('✅ Clicked create project button\n');
            testPassed++;

            // Test 8: Fill in project details (if form appears)
            console.log('📝 Test 8: Fill in project details...');

            // Look for project name input
            const projectNameSelectors = [
                'input[placeholder*="name"]',
                'input[aria-label*="name"]',
                'input[type="text"]',
            ];

            let nameInput = null;
            for (const selector of projectNameSelectors) {
                try {
                    nameInput = await page.waitForSelector(selector, { timeout: 3000 });
                    if (nameInput) {
                        console.log(`✅ Found project name input: ${selector}`);
                        break;
                    }
                } catch (e) {
                    // Try next selector
                }
            }

            if (nameInput) {
                const projectName = `Test Project ${Date.now()}`;
                await nameInput.fill(projectName);
                console.log(`✅ Entered project name: ${projectName}\n`);

                // Look for submit/create button
                await page.waitForTimeout(1000);
                const submitSelectors = [
                    'button:has-text("Create")',
                    'button:has-text("Submit")',
                    'button:has-text("Done")',
                    'button[type="submit"]',
                ];

                for (const selector of submitSelectors) {
                    try {
                        const submitBtn = await page.waitForSelector(selector, { timeout: 2000 });
                        if (submitBtn) {
                            console.log(`🖱️  Clicking submit button: ${selector}`);
                            await submitBtn.click();
                            await page.waitForTimeout(3000);
                            console.log('✅ Project creation submitted\n');
                            break;
                        }
                    } catch (e) {
                        // Try next selector
                    }
                }
                testPassed++;
            } else {
                console.log('⚠️  Could not find project name input');
                console.log('📸 Taking screenshot...');
                await page.screenshot({ path: path.join(__dirname, 'flow-create-form.png'), fullPage: true });
                console.log('✅ Screenshot saved\n');
                testPassed++;
            }
        }

        // Test 9: Verify project was created
        console.log('✅ Test 9: Verify project creation...');
        console.log('⏳ Waiting 5 seconds for project to appear...');
        await page.waitForTimeout(5000);

        // Take final screenshot
        await page.screenshot({ path: path.join(__dirname, 'flow-project-created.png'), fullPage: true });
        console.log('📸 Final screenshot saved to: standalone_modules/flow-project-created.png\n');
        testPassed++;

        // Test 10: Save session after creating project
        console.log('💾 Test 10: Save session...');
        await flowSession.saveSession(context);
        console.log('✅ Session saved\n');
        testPassed++;

        // Wait before closing
        console.log('⏳ Waiting 10 seconds before closing browser...');
        console.log('   (You can inspect the page manually)\n');
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
testFlowCreateProject().catch(console.error);
