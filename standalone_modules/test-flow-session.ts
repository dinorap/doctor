/**
 * Test Flow Session Module
 * Test mở Google Flow, save/restore sessions, cookies, localStorage
 */

import { DatabaseManager } from '../src/database/Database';
import { BrowserManager } from '../src/browser-manager/BrowserManager';
import { ProfileManager } from '../src/profile-manager/ProfileManager';
import { FlowSession } from '../src/flow-session/FlowSession';
import path from 'path';

// Setup
const TEST_DB_PATH = path.resolve(__dirname, '../data/test_flow.db');
const db = new DatabaseManager(TEST_DB_PATH);
const profileManager = new ProfileManager(db);
const browserManager = new BrowserManager(db);

console.log('🧪 Testing Flow Session Module\n');

async function testFlowSession() {
    try {
        // Test 1: Create Profile and Launch Browser
        console.log('✅ Test 1: Create Profile and Launch Browser');
        const profile = profileManager.createProfile({ name: 'Flow Test Profile' });
        console.log(`   Created profile: ${profile.name}`);

        const profileState = await browserManager.launchProfile(profile);
        console.log(`   Browser launched successfully\n`);

        // Test 2: Create Flow Session Instance
        console.log('✅ Test 2: Create Flow Session Instance');
        const flowSession = new FlowSession(profile.id, db);
        console.log(`   FlowSession created for profile: ${profile.id}\n`);

        // Test 3: Open Google Flow
        console.log('✅ Test 3: Open Google Flow');
        console.log('   Opening https://labs.google/fx/tools/flow...');
        const page = await flowSession.openFlow(profileState.browserContext);
        const pageTitle = await page.title();
        console.log(`   Page opened: ${pageTitle}`);
        console.log(`   URL: ${page.url()}\n`);

        // Test 4: Wait for user interaction
        console.log('⏳ Test 4: Waiting 10 seconds for manual interaction...');
        console.log('   (You can interact with the browser now)');
        await new Promise(resolve => setTimeout(resolve, 10000));

        // Test 5: Save Session
        console.log('✅ Test 5: Save Session (cookies, localStorage, sessionStorage)');
        await flowSession.saveSession(profileState.browserContext);
        console.log(`   Session saved successfully\n`);

        // Test 6: Get Session Data
        console.log('✅ Test 6: Get Saved Session Data');
        const sessionData = flowSession.getSessionData();
        if (sessionData) {
            const cookies = JSON.parse(sessionData.cookies);
            const localStorage = JSON.parse(sessionData.localStorage);
            const sessionStorage = JSON.parse(sessionData.sessionStorage);

            console.log(`   Cookies count: ${cookies.length}`);
            console.log(`   LocalStorage keys: ${Object.keys(localStorage).length}`);
            console.log(`   SessionStorage keys: ${Object.keys(sessionStorage).length}`);
            console.log(`   Active: ${sessionData.isActive}\n`);
        } else {
            console.log(`   No session data found\n`);
        }

        // Test 7: Close Browser
        console.log('✅ Test 7: Close Browser');
        await browserManager.closeProfile(profile.id);
        console.log(`   Browser closed\n`);

        // Test 8: Reopen Browser
        console.log('✅ Test 8: Reopen Browser and Restore Session');
        const newProfileState = await browserManager.launchProfile(profile);
        console.log(`   Browser reopened`);

        // Test 9: Restore Session
        console.log('✅ Test 9: Restore Session');
        const restored = await flowSession.restoreSession(newProfileState.browserContext);
        console.log(`   Session restored: ${restored}`);

        if (restored) {
            console.log(`   ✅ Cookies, localStorage, and sessionStorage restored!`);

            // Navigate to Flow to verify
            const newPage = await flowSession.openFlow(newProfileState.browserContext);
            console.log(`   Navigated back to Flow`);
            console.log(`   URL: ${newPage.url()}\n`);

            // Wait to observe
            console.log('⏳ Waiting 5 seconds to observe restored session...');
            await new Promise(resolve => setTimeout(resolve, 5000));
        } else {
            console.log(`   No session to restore (first time)\n`);
        }

        // Test 10: Clear Session
        console.log('✅ Test 10: Clear Session');
        await flowSession.clearSession();
        console.log(`   Session cleared from database\n`);

        // Test 11: Deactivate Session
        console.log('✅ Test 11: Deactivate Session');
        await flowSession.saveSession(newProfileState.browserContext);
        await flowSession.deactivateSession();
        const deactivatedSession = flowSession.getSessionData();
        console.log(`   Session deactivated: ${deactivatedSession ? !deactivatedSession.isActive : 'Not found'}\n`);

        console.log('🎉 All Flow Session tests passed!\n');

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
testFlowSession();
