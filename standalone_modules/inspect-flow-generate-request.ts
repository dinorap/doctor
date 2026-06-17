/**
 * Network Inspector — Google Flow Image Generation
 *
 * Opens Google Flow in an existing Chromium profile, intercepts the
 * batchGenerateImages API call, and prints the exact URL, headers, and
 * request body so we can fix ExtensionBridge.ts / routes.ts.
 *
 * Usage:
 *   npx tsx standalone_modules/inspect-flow-generate-request.ts <profileId>
 *   npx tsx standalone_modules/inspect-flow-generate-request.ts --list    (show available profiles)
 *
 * The script will:
 *   1. Launch the browser with the chosen profile (must already be logged into Flow)
 *   2. Intercept ALL requests matching flowMedia:batchGenerateImages
 *   3. Wait up to 5 minutes for you to trigger an image generation in the Flow UI
 *   4. Print the captured request and exit
 */

import * as path from 'path';
import * as fs from 'fs';
import Database from 'better-sqlite3';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const DB_PATH = path.join(DATA_DIR, 'profiles.db');

// ── Database helpers ──────────────────────────────────────────────

function getDb() {
    return new Database(DB_PATH);
}

interface DbProfile {
    id: string;
    name: string;
    profilePath: string;
    metadata: string;
}

function listProfilesFromDb() {
    const db = getDb();
    const profiles = db.prepare('SELECT id, name, profilePath, metadata FROM profiles').all() as DbProfile[];
    db.close();
    return profiles;
}

function getProfilePathFromDb(profileId: string): string | null {
    const db = getDb();
    const row = db.prepare('SELECT profilePath FROM profiles WHERE id = ?').get(profileId) as { profilePath: string } | undefined;
    db.close();
    return row?.profilePath ?? null;
}

async function listProfiles(profiles: DbProfile[]) {
    if (profiles.length === 0) {
        console.log('No profiles found in database.');
        return;
    }
    console.log('\nAvailable profiles:\n');
    for (const p of profiles) {
        const exists = fs.existsSync(p.profilePath) ? '✅' : '❌';
        console.log(`  ${exists}  ${p.id}  "${p.name}"`);
        console.log(`      ${p.profilePath}`);
    }
    console.log('\nPass the profile ID as argument, e.g.:');
    console.log(`  npx tsx standalone_modules/inspect-flow-generate-request.ts ${profiles[0].id}`);
}

async function main() {
    // ── Argument parsing ────────────────────────────────────────
    const args = process.argv.slice(2);
    if (args[0] === '--list') {
        const profiles = listProfilesFromDb();
        await listProfiles(profiles);
        return;
    }

    const profileId = args[0];
    if (!profileId) {
        const profiles = listProfilesFromDb();
        console.error('Usage: tsx inspect-flow-generate-request.ts <profileId>');
        console.error('       tsx inspect-flow-generate-request.ts --list');
        await listProfiles(profiles);
        process.exit(1);
    }

    const profilePath = getProfilePathFromDb(profileId);
    if (!profilePath) {
        console.error(`Profile not found in database: ${profileId}`);
        process.exit(1);
    }
    if (!fs.existsSync(profilePath)) {
        console.error(`Profile directory does not exist: ${profilePath}`);
        console.error('(The database entry exists but the Chromium userDataDir is missing.)');
        process.exit(1);
    }

    console.log('\n╔══════════════════════════════════════════════════════╗');
    console.log('║   Google Flow — Network Request Inspector           ║');
    console.log('╠══════════════════════════════════════════════════════╣');
    console.log(`║  Profile : ${profileId.padEnd(43)}║`);
    console.log(`║  Path    : ${profilePath.slice(0, 43).padEnd(43)}║`);
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log('\nLaunching browser...');

    // ── Lazy-import Playwright so the script stays usable even if
    //    playwright isn't globally installed for ts-node/tsx.       ──
    let playwright: typeof import('playwright');
    try {
        playwright = await import('playwright');
    } catch (e) {
        console.error('Playwright not found. Install it first: npm i -D playwright');
        process.exit(1);
    }

    // ── Track captured requests ──────────────────────────────────
    const captured: CapturedRequest[] = [];
    let done = false;

    // ── Try to connect to an existing browser first (if the main app has one open).
    //    Fall back to launching a fresh browser if none is found.          ──
    let browser: import('playwright').Browser;
    let connectedToExisting = false;

    try {
        // Default CDP endpoint used by BrowserManager + Playwright
        const cdpUrl = 'http://localhost:9222';
        const cdpBrowser = await playwright.chromium.connectOverCDP(cdpUrl);
        const targets = await cdpBrowser.newBrowserContext().newPage();
        // Quick sanity check — if we get here without error, we connected
        await targets.close();
        browser = cdpBrowser;
        connectedToExisting = true;
        console.log('✅ Connected to existing Chromium via CDP (port 9222)');
    } catch {
        // No existing browser — launch fresh
        console.log('No existing browser found on port 9222. Launching fresh browser...');
        try {
            browser = await playwright.chromium.launchPersistentContext(
                profilePath,
                {
                    headless: false,
                    args: [
                        '--disable-blink-features=AutomationControlled',
                        '--disable-features=IsolateOrigins,site-per-process',
                        '--disable-site-isolation-trials',
                        '--start-maximized',
                    ],
                    viewport: null,
                },
            );
        } catch (launchErr: any) {
            if (launchErr?.message?.includes('existing browser session')) {
                console.error('\n⚠️  Profile is already open in another Chromium instance.');
                console.error('    Please close the existing browser for this profile before running this script.');
                console.error('    Or run the inspector from a different machine/port by starting the');
                console.error('    main app with BROWSER_CDP_PORT env var set to a different value.');
                process.exit(1);
            }
            throw launchErr;
        }
    }

    // ── Get or create a page ──────────────────────────────────────
    // When connected to existing browser, create a fresh incognito-ish context
    // (we still need the real Flow cookies so we just use a new page in the
    // default context — the existing browser already has Flow cookies).
    let page: import('playwright').Page;
    if (connectedToExisting) {
        const ctx = await browser.newContext();
        page = await ctx.newPage();
    } else {
        page = browser.pages()[0] || (await browser.newPage());
    }

    // ── Intercept batchGenerateImages requests ───────────────────
    await page.route(
        'https://aisandbox-pa.googleapis.com/**/flowMedia:batchGenerateImages',
        async (route, request) => {
            if (done) {
                await route.continue();
                return;
            }

            try {
                const url = request.url();
                const method = request.method();
                const headers: Record<string, string> = {};
                for (const { name, value } of request.headers()) {
                    headers[name] = value;
                }

                let body: any = undefined;
                const postData = request.postDataBuffer();
                if (postData) {
                    try {
                        body = JSON.parse(postData.toString('utf-8'));
                    } catch {
                        body = postData.toString('utf-8');
                    }
                }

                const capturedReq: CapturedRequest = {
                    url,
                    method,
                    headers,
                    body,
                    timestamp: new Date().toISOString(),
                };

                captured.push(capturedReq);

                // Pretty-print immediately so user can see it while the browser stays open
                console.log('\n\n🎯 CAPTURED IMAGE GENERATION REQUEST\n');
                console.log('═══════════════════════════════════════════════════════');
                console.log(`URL     : ${url}`);
                console.log(`Method  : ${method}`);
                console.log(`Time    : ${capturedReq.timestamp}`);
                console.log('───────────────────────────────────────────────────────');
                console.log('Headers :');
                for (const [k, v] of Object.entries(headers)) {
                    const displayVal = k.toLowerCase() === 'authorization'
                        ? `Bearer ya29.***[TRUNCATED ${v.length} chars]***`
                        : v;
                    console.log(`  ${k}: ${displayVal}`);
                }
                console.log('───────────────────────────────────────────────────────');
                console.log('Body (JSON):');
                console.log(JSON.stringify(body, null, 2));
                console.log('═══════════════════════════════════════════════════════\n');

                // Continue the real request
                await route.continue({ headers });
            } catch (err) {
                console.error('Route handler error:', err);
                await route.continue();
            }
        },
    );

    // Also intercept any tRPC calls to project.createProject so we can grab projectId
    await page.route(
        'https://labs.google/fx/api/trpc/**',
        async (route, request) => {
            if (done) return;
            try {
                const url = request.url();
                const method = request.method();
                const postData = request.postDataBuffer();
                let body: any = undefined;
                if (postData) {
                    try { body = JSON.parse(postData.toString('utf-8')); } catch { body = postData.toString('utf-8'); }
                }
                if (body && typeof body === 'object' && !done) {
                    const bodyStr = JSON.stringify(body);
                    if (bodyStr.includes('createProject') || url.includes('createProject')) {
                        console.log('\n📋 CAPTURED trpc createProject\n');
                        console.log(`URL    : ${url}`);
                        console.log(`Method : ${method}`);
                        console.log(`Body   : ${bodyStr.slice(0, 500)}`);
                        console.log('');
                    }
                }
            } catch {}
            await route.continue();
        },
    );

    // ── Navigate to Flow ────────────────────────────────────────
    console.log('\nNavigating to https://labs.google/fx/tools/flow ...\n');
    await page.goto('https://labs.google/fx/tools/flow', { waitUntil: 'networkidle', timeout: 30_000 });

    console.log('\n✅ Browser opened. Flow UI should be visible.\n');
    console.log('───────────────────────────────────────────────────────');
    console.log('  ⚠️  IMPORTANT — Do the following in the browser window:');
    console.log('  1. Make sure you are logged into Google Flow');
    console.log('  2. Navigate to or create a project with image generation');
    console.log('  3. Enter a prompt and click "Generate" or "Create image"');
    console.log('  4. The script will capture and print the API request');
    console.log('');
    console.log('  ⏱  Waiting indefinitely until you trigger generation...');
    console.log('  (Timeout can be set via FLOW_INSPECT_TIMEOUT_MS env var,');
    console.log('   default is 30 minutes. Set to 0 for no timeout.)');
    console.log('  Press Ctrl+C to abort early.');
    console.log('───────────────────────────────────────────────────────\n');

    // ── Wait for capture or timeout ──────────────────────────────
    // Default: wait up to 30 minutes. Override with FLOW_INSPECT_TIMEOUT_MS env var.
    const TIMEOUT_MS = parseInt(process.env.FLOW_INSPECT_TIMEOUT_MS ?? String(30 * 60 * 1000), 10);
    const POLL_MS = 2000;
    const deadline = TIMEOUT_MS > 0 ? Date.now() + TIMEOUT_MS : Infinity;
    const indefinite = !isFinite(deadline);

    while (indefinite || Date.now() < deadline) {
        if (captured.length > 0) {
            done = true;
            break;
        }
        await new Promise(r => setTimeout(r, POLL_MS));
        if (!indefinite) {
            const remaining = Math.ceil((deadline - Date.now()) / 1000);
            if (remaining > 0 && remaining % 30 === 0) {
                console.log(`  ⏳ Still waiting... (${Math.floor(remaining / 60)}m ${remaining % 60}s remaining)`);
            }
        }
    }

    // ── Summary ─────────────────────────────────────────────────
    console.log('\n\n═══════════════════════════════════════════════════════');
    console.log('                   CAPTURE SUMMARY');
    console.log('═══════════════════════════════════════════════════════');

    if (captured.length === 0) {
        console.log('⚠️  No batchGenerateImages requests were captured.');
        console.log('    Make sure the profile is logged in and you triggered');
        console.log('    an image generation in the Flow UI.');
    } else {
        // Save to file for reference
        const outputFile = path.join(PROJECT_ROOT, 'data', `flow-request-capture-${Date.now()}.json`);
        fs.mkdirSync(path.dirname(outputFile), { recursive: true });
        fs.writeFileSync(outputFile, JSON.stringify(captured, null, 2));
        console.log(`✅ Captured ${captured.length} request(s)`);
        console.log(`💾 Full capture saved to: ${outputFile}`);

        // Print the most recent one
        const req = captured[captured.length - 1];
        console.log('\n── Request URL ─────────────────────────────────────────');
        console.log(req.url);
        console.log('\n── Request Body Keys ───────────────────────────────────');
        if (req.body && typeof req.body === 'object') {
            const keys = Object.keys(req.body);
            for (const key of keys) {
                const val = req.body[key];
                if (key === 'requests' && Array.isArray(val)) {
                    console.log(`  ${key}: [array with ${val.length} item(s)]`);
                    if (val[0]) {
                        console.log('    First request keys:', Object.keys(val[0]).join(', '));
                    }
                } else if (typeof val === 'object') {
                    console.log(`  ${key}: ${JSON.stringify(val).slice(0, 80)}`);
                } else {
                    const display = String(val).slice(0, 100);
                    console.log(`  ${key}: ${display}`);
                }
            }
        }
        console.log('\n── Auth Header Present ────────────────────────────────');
        const authHeader = Object.entries(req.headers).find(([k]) => k.toLowerCase() === 'authorization');
        if (authHeader) {
            console.log(`  ✅ Authorization header found: ${String(authHeader[1]).slice(0, 60)}...`);
        } else {
            console.log('  ❌ No Authorization header found!');
        }
        console.log('\n── All Request Headers ────────────────────────────────');
        for (const [k, v] of Object.entries(req.headers)) {
            console.log(`  ${k}: ${v}`);
        }
    }

    console.log('\n═══════════════════════════════════════════════════════');
    console.log('Browser will stay open for 30 seconds. Press Ctrl+C to close now.');
    console.log('═══════════════════════════════════════════════════════\n');

    await new Promise(r => setTimeout(r, 30_000));

    if (connectedToExisting) {
        // Only close what we opened; leave the main app's browser alone
        const ctx = page.context();
        await ctx.close();
        await browser.disconnect();
    } else {
        await browser.close();
    }
    console.log('Done.');
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
