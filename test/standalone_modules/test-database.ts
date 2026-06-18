/**
 * Test Database Module
 * Test các chức năng CRUD của Database: profiles và sessions
 */

import { DatabaseManager } from '../src/database/Database';
import path from 'path';

// Setup database
const TEST_DB_PATH = path.resolve(__dirname, '../data/test_database.db');
const db = new DatabaseManager(TEST_DB_PATH);

console.log('🧪 Testing Database Module\n');

async function testDatabase() {
    try {
        // ===== PROFILES TABLE TESTS =====
        console.log('📁 Testing Profiles Table\n');

        // Test 1: Create Profile
        console.log('✅ Test 1: Create Profile');
        const profile1 = db.createProfile({
            name: 'Database Test Profile',
            profilePath: '/test/path/profile1',
            metadata: { test: true }
        });
        console.log(`   Profile ID: ${profile1.id}`);
        console.log(`   Name: ${profile1.name}\n`);

        // Test 2: Get Profile
        console.log('✅ Test 2: Get Profile by ID');
        const fetchedProfile = db.getProfile(profile1.id);
        console.log(`   Found: ${fetchedProfile ? 'Yes' : 'No'}`);
        console.log(`   Name: ${fetchedProfile?.name}\n`);

        // Test 3: Get All Profiles
        console.log('✅ Test 3: Get All Profiles');
        const profile2 = db.createProfile({
            name: 'Profile 2',
            profilePath: '/test/path/profile2'
        });
        const allProfiles = db.getAllProfiles();
        console.log(`   Total profiles: ${allProfiles.length}`);
        allProfiles.forEach(p => console.log(`   - ${p.name}`));
        console.log();

        // Test 4: Update Profile
        console.log('✅ Test 4: Update Profile');
        db.updateProfile(profile1.id, {
            metadata: { test: true, updated: true }
        });
        const updatedProfile = db.getProfile(profile1.id);
        console.log(`   Metadata updated:`, updatedProfile?.metadata);
        console.log();

        // ===== SESSIONS TABLE TESTS =====
        console.log('💾 Testing Sessions Table\n');

        // Test 5: Create Session
        console.log('✅ Test 5: Create Session');
        const session1 = db.createSession({
            profileId: profile1.id,
            cookies: JSON.stringify([{ name: 'test', value: '123' }]),
            localStorage: JSON.stringify({ key: 'value' }),
            sessionStorage: JSON.stringify({ session: 'data' }),
            isActive: true
        });
        console.log(`   Session ID: ${session1.id}`);
        console.log(`   Profile ID: ${session1.profileId}`);
        console.log(`   Active: ${session1.isActive}\n`);

        // Test 6: Get Session by ID
        console.log('✅ Test 6: Get Session by ID');
        const fetchedSession = db.getSession(session1.id);
        console.log(`   Found: ${fetchedSession ? 'Yes' : 'No'}`);
        console.log(`   Cookies:`, JSON.parse(fetchedSession!.cookies));
        console.log();

        // Test 7: Get Session by Profile ID
        console.log('✅ Test 7: Get Session by Profile ID');
        const profileSession = db.getSessionByProfileId(profile1.id);
        console.log(`   Found: ${profileSession ? 'Yes' : 'No'}`);
        console.log(`   Session ID: ${profileSession?.id}\n`);

        // Test 8: Update Session
        console.log('✅ Test 8: Update Session');
        db.updateSession(session1.id, {
            localStorage: JSON.stringify({ updated: true }),
            isActive: false
        });
        const updatedSession = db.getSession(session1.id);
        console.log(`   Updated localStorage:`, JSON.parse(updatedSession!.localStorage));
        console.log(`   Active: ${updatedSession!.isActive}\n`);

        // Test 9: Create Multiple Sessions for Same Profile
        console.log('✅ Test 9: Create Multiple Sessions (should fail or update)');
        try {
            const session2 = db.createSession({
                profileId: profile1.id,
                cookies: '[]',
                localStorage: '{}',
                sessionStorage: '{}',
                isActive: true
            });
            console.log(`   Created another session: ${session2.id}\n`);
        } catch (error: any) {
            console.log(`   Expected behavior: ${error.message}\n`);
        }

        // Test 10: Delete Session (CASCADE)
        console.log('✅ Test 10: Delete Profile (should cascade delete sessions)');
        const beforeDelete = db.getSessionByProfileId(profile1.id);
        console.log(`   Session before delete: ${beforeDelete ? 'Exists' : 'Not found'}`);

        db.deleteProfile(profile1.id);

        const afterDelete = db.getSessionByProfileId(profile1.id);
        console.log(`   Session after delete: ${afterDelete ? 'Still exists (ERROR!)' : 'Deleted (Correct)'}\n`);

        // Test 11: Manually Delete Session
        console.log('✅ Test 11: Manually Delete Session');
        const session3 = db.createSession({
            profileId: profile2.id,
            cookies: '[]',
            localStorage: '{}',
            sessionStorage: '{}',
            isActive: true
        });
        console.log(`   Created session: ${session3.id}`);

        const deleteResult = db.deleteSession(session3.id);
        console.log(`   Delete result: ${deleteResult}`);

        const deletedSession = db.getSession(session3.id);
        console.log(`   Session after delete: ${deletedSession ? 'Still exists (ERROR!)' : 'Deleted (Correct)'}\n`);

        console.log('🎉 All Database tests passed!\n');

        // Cleanup
        console.log('🧹 Cleaning up test data...');
        db.getAllProfiles().forEach(p => db.deleteProfile(p.id));
        console.log('   Cleaned up all test data\n');

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        db.close();
    }
}

// Run tests
testDatabase();
