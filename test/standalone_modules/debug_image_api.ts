/**
 * Debug script: Test image generation by calling Flow API directly
 * via Playwright to see exact request/response and captcha token behavior.
 */
import { chromium, Browser, Page } from 'playwright';
import * as https from 'https';
import * as http from 'http';

const PROFILE_PATH = 'D:\\FreeLand\\chromium-profile-manager\\profiles\\2f97f3b0-ade6-4f65-8aae-ef3fc3b95d57';

async function testDirectApiCall() {
    console.log('🔍 Starting direct API test...\n');

    let browser: Browser | null = null;
    let page: Page | null = null;

    try {
        console.log('1️⃣ Launching Chromium with existing profile...');
        browser = await chromium.launchPersistentContext(PROFILE_PATH, {
            headless: false,
            args: [
                '--disable-extensions-except=E:\\project\\doctor\\extension',
                '--load-extension=E:\\project\\doctor\\extension',
                '--no-sandbox',
            ],
        });
        console.log('✅ Browser launched');

        // Get or create a Flow tab
        const existingTabs = await browser.pages();
        let flowPage: Page | null = null;

        for (const p of existingTabs) {
            const url = p.url();
            if (url.includes('labs.google')) {
                flowPage = p;
                console.log('✅ Found existing Flow tab:', url);
                break;
            }
        }

        if (!flowPage) {
            console.log('⚠️ No Flow tab found, navigating...');
            flowPage = await browser.newPage();
            await flowPage.goto('https://labs.google/fx/tools/flow', { waitUntil: 'networkidle', timeout: 30000 });
            console.log('✅ Navigated to Flow');
        }

        // Wait for Flow to fully load
        await flowPage.waitForTimeout(5000);

        // Check if grecaptcha is available
        console.log('\n2️⃣ Checking grecaptcha availability...');
        const grecaCheck = await flowPage.evaluate(() => {
            if (typeof window.grecaptcha !== 'undefined') {
                return {
                    available: true,
                    enterprise: typeof (window as any).grecaptcha.enterprise !== 'undefined',
                    siteKey: (window as any).__SITE_KEY || null,
                };
            }
            return { available: false };
        });
        console.log('grecaptcha check:', JSON.stringify(grecaCheck));

        // Get cookies/auth from Flow page
        console.log('\n3️⃣ Getting auth from Flow page...');
        const cookies = await flowPage.context().cookies('https://labs.google');
        console.log(`Found ${cookies.length} cookies`);

        const authHeader = cookies.find(c => c.name === 'AUTHUSER') ||
            cookies.find(c => c.name.includes('SSID')) ||
            cookies[0];
        console.log('Auth cookie:', authHeader?.name);

        // Navigate to Flow and capture the API request directly
        console.log('\n4️⃣ Setting up request interception...');

        let capturedRequest: any = null;
        let capturedResponse: any = null;

        // Intercept ALL requests to the API endpoint
        await flowPage.route('**/aisandbox-pa.googleapis.com/**', async (route, request) => {
            const url = request.url();
            if (url.includes('batchGenerateImages')) {
                console.log('\n📡 Intercepted batchGenerateImages request!');
                console.log('URL:', url);
                console.log('Headers:', JSON.stringify(request.headers(), null, 2));
                try {
                    const postData = request.postData();
                    console.log('Body:', JSON.stringify(JSON.parse(postData || '{}'), null, 2));
                    capturedRequest = { url, headers: request.headers(), body: postData };
                } catch (e) {
                    console.log('Body (raw):', request.postData());
                }
            }
            await route.continue();
        });

        // Try to trigger an image generation via the Flow UI
        console.log('\n5️⃣ Attempting to trigger image generation via UI...');

        // Wait for Flow UI to load
        await flowPage.waitForTimeout(2000);

        // Try to find and click the create/generate button
        try {
            // Look for Create button or generate section
            const createBtn = await flowPage.$('button:has-text("Create"), button:has-text("Generate"), button:has-text("New")');
            if (createBtn) {
                console.log('Found create button, clicking...');
                await createBtn.click();
                await flowPage.waitForTimeout(3000);
            } else {
                console.log('No create button found, trying direct prompt input...');
            }

            // Try to find prompt input
            const promptInput = await flowPage.$('textarea, input[type="text"]');
            if (promptInput) {
                console.log('Found prompt input, typing...');
                await (promptInput as any).fill('A beautiful sunset over mountains');
                await flowPage.waitForTimeout(1000);

                // Find and click generate
                const generateBtn = await flowPage.$('button:has-text("Generate"), button:has-text("Create")');
                if (generateBtn) {
                    console.log('Found generate button, clicking...');
                    await generateBtn.click();
                    await flowPage.waitForTimeout(5000);
                }
            }
        } catch (e) {
            console.log('UI interaction error:', (e as Error).message);
        }

        // Print captured request details
        if (capturedRequest) {
            console.log('\n✅ Captured API request!');
            console.log('URL:', capturedRequest.url);
            console.log('Headers:', JSON.stringify(capturedRequest.headers, null, 2));
            try {
                const body = JSON.parse(capturedRequest.body || '{}');
                console.log('Body keys:', Object.keys(body));
                if (body.clientContext) {
                    console.log('clientContext keys:', Object.keys(body.clientContext));
                    if (body.clientContext.recaptchaContext) {
                        console.log('recaptchaContext:', JSON.stringify(body.clientContext.recaptchaContext));
                    }
                }
                if (body.requests) {
                    console.log('Number of requests:', body.requests.length);
                    if (body.requests[0]) {
                        console.log('First request keys:', Object.keys(body.requests[0]));
                    }
                }
            } catch (e) {
                console.log('Could not parse body');
            }
        } else {
            console.log('\n❌ No batchGenerateImages request captured - UI might need manual interaction');
        }

    } catch (error) {
        console.error('❌ Error:', error);
    } finally {
        if (browser) {
            console.log('\n🧹 Closing browser...');
            await browser.close();
        }
    }
}

testDirectApiCall().catch(console.error);
