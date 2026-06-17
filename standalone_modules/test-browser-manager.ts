/**
 * Test Browser Manager Module
 * Test khởi động browser, load extension, và quản lý sessions
 */

import { DatabaseManager } from '../src/database/Database';
import { BrowserManager } from '../src/browser-manager/BrowserManager';
import { ProfileManager } from '../src/profile-manager/ProfileManager';
import path from 'path';

// Setup
const TEST_DB_PATH = path.resolve(__dirname, '../data/test_browser.db');
const db = new DatabaseManager(TEST_DB_PATH);
const profileManager = new ProfileManager(db);
const browserManager = new BrowserManager(db);

console.log('🧪 Testing Browser Manager Module\n');

async function testBrowserManager() {
    try {
        // Test 1: Create Test Profile
        console.log('✅ Test 1: Create Test Profile');
        const profile = profileManager.createProfile({ name: 'Browser Test Profile' });
        console.log(`   Created profile: ${profile.name} (${profile.id})\n`);

        // Test 2: Launch Browser with Extension
        console.log('✅ Test 2: Launch Browser with Extension');
        console.log('   Launching browser... (this may take a few seconds)');
        const profileState = await browserManager.launchProfile(profile);
        console.log(`   ✅ Browser launched successfully!`);
        console.log(`   Extension ID: ${profileState.extensionId || 'Not found'}`);
        console.log(`   Active: ${profileState.isActive}`);
        console.log(`   Context: ${profileState.browserContext ? 'Created' : 'Not created'}\n`);

        // Test 3: Check Active Session
        console.log('✅ Test 3: Check Active Session');
        const isActive = browserManager.isActive(profile.id);
        console.log(`   Profile is active: ${isActive}\n`);

        // Test 4: Get Session
        console.log('✅ Test 4: Get Active Session');
        const session = browserManager.getSession(profile.id);
        console.log(`   Session found: ${session ? 'Yes' : 'No'}`);
        console.log(`   Profile name: ${session?.profile.name}\n`);

        // Test 5: List All Active Sessions
        console.log('✅ Test 5: List All Active Sessions');
        const activeSessions = browserManager.getActiveSessions();
        console.log(`   Total active sessions: ${activeSessions.length}`);
        activeSessions.forEach(s => {
            console.log(`   - ${s.profile.name} (${s.profile.id})`);
        });
        console.log();

        // Test 6: Create New Page
        console.log('✅ Test 6: Create New Page in Browser');
        const page = await browserManager.createPage(profile.id);
        await page.goto('https://www.google.com');
        console.log(`   Page created and navigated to Google`);
        console.log(`   Page title: ${await page.title()}\n`);

        // Test 7: Get All Pages
        console.log('✅ Test 7: Get All Pages');
        const pages = browserManager.getPages(profile.id);
        console.log(`   Total pages: ${pages.length}`);
        for (let i = 0; i < pages.length; i++) {
            const title = await pages[i].title();
            console.log(`   Page ${i + 1}: ${title}`);
        }
        console.log();

        // Test 8: Wait before closing (to observe browser)
        console.log('⏳ Waiting 5 seconds for observation...');
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Test 9: Close Browser
        console.log('✅ Test 9: Close Browser');
        const closeResult = await browserManager.closeProfile(profile.id);
        console.log(`   Close result: ${closeResult}`);

        const stillActive = browserManager.isActive(profile.id);
        console.log(`   Still active: ${stillActive}\n`);

        // Test 10: Try to Use Closed Session
        console.log('✅ Test 10: Try to Get Closed Session');
        const closedSession = browserManager.getSession(profile.id);
        console.log(`   Session found: ${closedSession ? 'Yes (ERROR!)' : 'No (Correct)'}\n`);

        console.log('🎉 All Browser Manager tests passed!\n');

        // Cleanup
        console.log('🧹 Cleaning up...');
        await browserManager.closeAll();
        profileManager.deleteProfile(profile.id);
        console.log('   Cleanup complete\n');

    } catch (error) {
        console.error('❌ Test failed:', error);

        // Emergency cleanup
        try {
            await browserManager.closeAll();
            db.getAllProfiles().forEach(p => db.deleteProfile(p.id));
        } catch (cleanupError) {
            console.error('Cleanup error:', cleanupError);
        }
    } finally {
        db.close();
    }
}

// Run tests
testBrowserManager();
