import path from 'path';

export interface FlowConfig {
    url: string;
    waitForLogin: boolean;
    sessionTimeout: number;
    apiKey: string;
    wsUrl: string;
}

export const CONFIG = {
    // Server configuration
    server: {
        port: process.env.PORT || 3000,
        host: process.env.HOST || 'localhost',
    },

    // Paths
    paths: {
        profiles: path.resolve(process.cwd(), 'profiles'),
        extension: process.env.EXTENSION_PATH || path.resolve(process.cwd(), 'extension'),
        logs: path.resolve(process.cwd(), 'logs'),
        database: path.resolve(process.cwd(), 'data', 'profiles.db'),
    },

    // Browser configuration
    browser: {
        headless: process.env.HEADLESS === 'true',
        devtools: process.env.DEVTOOLS === 'true',
        slowMo: parseInt(process.env.SLOW_MO || '0', 10),
        args: [
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials',
            '--disable-web-security',
            '--disable-features=BlockInsecurePrivateNetworkRequests',
        ],
    },

    // Flow configuration
    flow: {
        url: 'https://labs.google/fx/tools/flow',
        waitForLogin: true,
        sessionTimeout: 30 * 60 * 1000, // 30 minutes
        apiKey: process.env.FLOW_API_KEY || '',
        wsUrl: process.env.FLOW_WS_URL || 'wss://flow.googleapis.com',
    } satisfies FlowConfig,

    // Extension configuration
    extension: {
        checkInterval: 1000, // Check every 1 second
        maxRetries: 30, // Max 30 seconds to wait for extension
        wsPort: parseInt(process.env.EXTENSION_WS_PORT || '9222', 10),
    },
};

export default CONFIG;
