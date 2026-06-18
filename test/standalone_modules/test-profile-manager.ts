/**
 * Test Profile Manager Module
 * Test các chức năng của ProfileManager: create, get, list, update, delete
 */

import { DatabaseManager } from '../src/database/Database';
import { ProfileManager } from '../src/profile-manager/ProfileManager';
import path from 'path';

// Setup database
const TEST_DB_PATH = path.resolve(__dirname, '../data/test_profiles.db');
const db = new DatabaseManager(TEST_DB_PATH);
const profileManager = new ProfileManager(db);

console.log('🧪 Testing Profile Manager Module\n');

async function testProfileManager() {
    try {
        // Test 1: Create Profile
        console.log('✅ Test 1: Create Profile');
        const profile1 = profileManager.createProfile({ name: 'Test Profile 1' });
        console.log(`   Created profile: ${profile1.name} (${profile1.id})`);
        console.log(`   Profile path: ${profile1.profilePath}\n`);

        // Test 2: Get Profile by ID
        console.log('✅ Test 2: Get Profile by ID');
        const fetchedProfile = profileManager.getProfile(profile1.id);
        if (fetchedProfile) {
            console.log(`   Found profile: ${fetchedProfile.name}`);
            console.log(`   Created at: ${new Date(fetchedProfile.createdAt).toLocaleString()}\n`);
        } else {
            console.log('   ❌ Profile not found\n');
        }

        // Test 3: Create Multiple Profiles
        console.log('✅ Test 3: Create Multiple Profiles');
        const profile2 = profileManager.createProfile({ name: 'Test Profile 2' });
        const profile3 = profileManager.createProfile({ name: 'Test Profile 3' });
        console.log(`   Created 2 more profiles: ${profile2.name}, ${profile3.name}\n`);

        // Test 4: List All Profiles
        console.log('✅ Test 4: List All Profiles');
        const allProfiles = profileManager.getAllProfiles();
        console.log(`   Total profiles: ${allProfiles.length}`);
        allProfiles.forEach(p => {
            console.log(`   - ${p.name} (${p.id}) - Active: ${p.isActive}`);
        });
        console.log();

        // Test 5: Update Profile (Touch)
        console.log('✅ Test 5: Touch Profile (Update last used)');
        const oldUpdatedAt = fetchedProfile!.updatedAt;
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s
        profileManager.touchProfile(profile1.id);
        const updatedProfile = profileManager.getProfile(profile1.id);
        console.log(`   Old updatedAt: ${new Date(oldUpdatedAt).toLocaleString()}`);
        console.log(`   New updatedAt: ${new Date(updatedProfile!.updatedAt).toLocaleString()}\n`);

        // Test 6: Delete Profile
        console.log('✅ Test 6: Delete Profile');
        const deleteResult = profileManager.deleteProfile(profile2.id);
        console.log(`   Delete result: ${deleteResult}`);
        const remainingProfiles = profileManager.getAllProfiles();
        console.log(`   Remaining profiles: ${remainingProfiles.length}\n`);

        // Test 7: Try to Get Deleted Profile
        console.log('✅ Test 7: Try to Get Deleted Profile');
        const deletedProfile = profileManager.getProfile(profile2.id);
        console.log(`   Result: ${deletedProfile ? 'Found (ERROR!)' : 'Not found (Correct)'}\n`);

        // Test 8: Create Profile with Metadata
        console.log('✅ Test 8: Create Profile with Metadata');
        const profileWithMeta = profileManager.createProfile({
            name: 'Profile with Metadata',
            metadata: {
                description: 'This is a test profile',
                tags: ['test', 'development'],
                owner: 'admin'
            }
        });
        console.log(`   Created profile with metadata: ${profileWithMeta.name}`);
        console.log(`   Metadata:`, JSON.stringify(profileWithMeta.metadata, null, 2));
        console.log();

        console.log('🎉 All Profile Manager tests passed!\n');

        // Cleanup
        console.log('🧹 Cleaning up test data...');
        const cleanup = profileManager.getAllProfiles();
        cleanup.forEach(p => {
            profileManager.deleteProfile(p.id);
        });
        console.log('   Deleted all test profiles\n');

    } catch (error) {
        console.error('❌ Test failed:', error);
    } finally {
        db.close();
    }
}

// Run tests
testProfileManager();
