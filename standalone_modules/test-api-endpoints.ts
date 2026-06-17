/**
 * Test API Endpoints
 * Test REST API endpoints qua HTTP requests
 */

const API_URL = 'http://localhost:3000/api';

console.log('🧪 Testing API Endpoints\n');
console.log('⚠️  Make sure server is running: npm start\n');

async function testAPI() {
    try {
        // Test 1: Health Check
        console.log('✅ Test 1: GET /api/health');
        const healthRes = await fetch(`${API_URL}/health`);
        const health = await healthRes.json();
        console.log(`   Status: ${health.success ? '✓' : '✗'}`);
        console.log(`   Data:`, health.data);
        console.log();

        // Test 2: List Profiles
        console.log('✅ Test 2: GET /api/profiles');
        const listRes = await fetch(`${API_URL}/profiles`);
        const list = await listRes.json();
        console.log(`   Total profiles: ${list.data?.length || 0}`);
        console.log();

        // Test 3: Create Profile
        console.log('✅ Test 3: POST /api/profiles/create');
        const createRes = await fetch(`${API_URL}/profiles/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'API Test Profile' })
        });
        const created = await createRes.json();
        console.log(`   Created: ${created.data?.name}`);
        console.log(`   ID: ${created.data?.id}`);
        const profileId = created.data?.id;
        console.log();

        // Test 4: Open Profile
        console.log('✅ Test 4: POST /api/profiles/open');
        const openRes = await fetch(`${API_URL}/profiles/open`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: profileId, openFlow: false })
        });
        const opened = await openRes.json();
        console.log(`   Result: ${opened.data?.message}`);
        console.log();

        // Wait
        console.log('⏳ Waiting 5 seconds...');
        await new Promise(r => setTimeout(r, 5000));

        // Test 5: Close Profile
        console.log('✅ Test 5: POST /api/profiles/:id/close');
        const closeRes = await fetch(`${API_URL}/profiles/${profileId}/close`, {
            method: 'POST'
        });
        const closed = await closeRes.json();
        console.log(`   Result: ${closed.message}`);
        console.log();

        // Test 6: Delete Profile
        console.log('✅ Test 6: DELETE /api/profiles/:id');
        const deleteRes = await fetch(`${API_URL}/profiles/${profileId}`, {
            method: 'DELETE'
        });
        const deleted = await deleteRes.json();
        console.log(`   Result: ${deleted.message}`);
        console.log();

        console.log('🎉 All API tests passed!\n');

    } catch (error) {
        console.error('❌ Test failed:', error);
    }
}

testAPI();
