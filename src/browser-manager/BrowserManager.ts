import { BrowserContext } from 'playwright';
import { ProfileConfig, ProfileState, BrowserLaunchOptions } from '../types';
import logger from '../utils/logger';
import CONFIG from '../config';
import { DatabaseManager } from '../database/Database';
import path from 'path';
import fs from 'fs';

export class BrowserManager {
    private activeSessions: Map<string, ProfileState>;
    private db: DatabaseManager;
    private cloakBrowser: any = null;
    private isCloakReady: boolean = false;
    private cloackDownloading: boolean = false;

    constructor(db: DatabaseManager) {
        this.activeSessions = new Map();
        this.db = db;
        this.initCloakBrowser();
    }

    private async initCloakBrowser(): Promise<void> {
        try {
            logger.info('Initializing CloakBrowser...');

            // Dynamic import cloackbrowser
            const cloakModule = await import('cloakbrowser');
            this.cloakBrowser = cloakModule;

            // Check if binary is available, if not trigger download
            try {
                const info = await this.cloakBrowser.binaryInfo();
                if (info.installed) {
                    this.isCloakReady = true;
                    logger.info(`CloakBrowser ready - Version: ${info.version}`);
                } else {
                    logger.info('CloakBrowser binary not found, will download on first launch (~200MB)');
                    this.isCloakReady = false;
                }
            } catch {
                logger.info('CloakBrowser binary not found, will download on first launch (~200MB)');
                this.isCloakReady = false;
            }
        } catch (error) {
            logger.error('Failed to load CloakBrowser module:', error);
            this.isCloakReady = false;
        }
    }

    public isCloakBrowserAvailable(): boolean {
        return this.cloakBrowser !== null;
    }

    public isCloakBrowserReady(): boolean {
        return this.isCloakReady;
    }

    public getDownloadStatus(): { downloading: boolean; progress?: number } {
        return {
            downloading: this.cloackDownloading,
        };
    }

    /**
     * Ensure CloakBrowser binary is downloaded
     */
    public async ensureBinary(): Promise<boolean> {
        if (this.isCloakReady) return true;

        if (this.cloackDownloading) {
            logger.info('Binary download already in progress...');
            // Wait for download to complete
            while (this.cloackDownloading) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
            return this.isCloakReady;
        }

        if (!this.cloakBrowser) {
            logger.error('CloakBrowser module not loaded');
            return false;
        }

        try {
            this.cloackDownloading = true;
            logger.info('Downloading CloakBrowser binary (~200MB)...');

            // Use ensureBinary to download
            await this.cloakBrowser.ensureBinary();

            this.isCloakReady = true;
            this.cloackDownloading = false;
            logger.info('CloakBrowser binary downloaded successfully');
            return true;
        } catch (error) {
            this.cloackDownloading = false;
            logger.error('Failed to download CloakBrowser binary:', error);
            return false;
        }
    }

    /**
     * Launch browser with CloakBrowser (default)
     * Handles both manual close and programmatic close
     */
    public async launchProfile(
        profile: ProfileConfig,
        options?: BrowserLaunchOptions & {
            useCloakBrowser?: boolean;
            stealth?: boolean;
            proxy?: string;
            geoip?: boolean;
            humanize?: boolean;
            projectUrl?: string;
        }
    ): Promise<ProfileState> {
        const useCloak = options?.useCloakBrowser || options?.stealth || true; // Default to CloakBrowser

        // Validate profile
        if (!profile) {
            throw new Error('Profile is required');
        }

        // Validate or create profilePath
        let profilePath = profile.profilePath;
        if (!profilePath) {
            logger.warn(`Profile path not found for ${profile.name}, using default path`);
            profilePath = path.join(CONFIG.paths.profiles, profile.id);
        }

        // Ensure profile directory exists
        if (!fs.existsSync(profilePath)) {
            logger.info(`Creating profile directory: ${profilePath}`);
            fs.mkdirSync(profilePath, { recursive: true });
        }

        // Ensure binary is available
        if (!this.isCloakReady) {
            const downloaded = await this.ensureBinary();
            if (!downloaded) {
                throw new Error('CloakBrowser binary not available');
            }
        }

        if (!this.cloakBrowser) {
            throw new Error('CloakBrowser module not loaded');
        }

        try {
            logger.info(`Launching browser for profile: ${profile.name} (CloakBrowser Stealth)`);
            logger.info(`Profile path: ${profilePath}`);

            // Build launch options - CloakBrowser uses userDataDir in options
            const launchOptions: any = {
                userDataDir: profilePath,
                headless: false,
                stealthArgs: true,
                humanize: options?.humanize ?? false,
                humanPreset: 'default',
                viewport: null,

            };

            // Add --start-maximized for full screen on Windows
            if (!launchOptions.args) launchOptions.args = [];
            launchOptions.args.push('--start-maximized');

            // Proxy settings - inject directly as Chromium CLI arg with inline auth
            // This bypasses Playwright's CDP auth interceptor (which can show auth dialog)
            // and bypasses CloakBrowser's inline-auth version check
            if (options?.proxy) {
                const proxyOpt: any = options.proxy;
                let proxyUrl: string | null = null;
                if (typeof proxyOpt === 'string') {
                    proxyUrl = proxyOpt;
                } else if (proxyOpt.server) {
                    const server = proxyOpt.server.replace(/^https?:\/\//, '');
                    if (proxyOpt.username) {
                        proxyUrl = `http://${encodeURIComponent(proxyOpt.username)}:${encodeURIComponent(proxyOpt.password || '')}@${server}`;
                    } else {
                        proxyUrl = `http://${server}`;
                    }
                }
                if (proxyUrl) {
                    launchOptions.args.push(`--proxy-server=${proxyUrl}`);
                    logger.info(`Proxy injected via CLI: ${proxyUrl.replace(/:[^:@]+@/, ':***@')}`);
                }
            }
            if (options?.geoip) {
                launchOptions.geoip = true;
            }

            // Add extension paths from config
            const extensionPath = CONFIG.paths.extension;
            if (extensionPath && fs.existsSync(extensionPath)) {
                launchOptions.extensionPaths = [extensionPath];
            }

            logger.info(`Launch options: ${JSON.stringify({
                userDataDir: profilePath,
                headless: launchOptions.headless,
                stealthArgs: launchOptions.stealthArgs,
                humanize: launchOptions.humanize,
                proxy: launchOptions.proxy ? 'configured' : 'none',
                geoip: launchOptions.geoip || false,
                extensionPaths: launchOptions.extensionPaths || 'none',
            })}`);

            // Launch with CloakBrowser persistent context
            const browserContext = await this.cloakBrowser.launchPersistentContext(launchOptions);

            // Create profile state
            const profileState: ProfileState = {
                profile,
                isActive: true,
                browserContext,
                useCloakBrowser: true,
                launchedAt: new Date(),
            };

            // Store active session
            this.activeSessions.set(profile.id, profileState);

            // Navigate to Google Flow page.
            // Embed profileId in the URL so the extension (background.js
            // latches it from chrome.tabs.onUpdated) knows which agent
            // bridge to bind to. We then strip it via the extension so
            // it never reaches Google's servers.
            try {
                const pages = browserContext.pages();
                const targetPage = pages.length > 0 ? pages[0] : await browserContext.newPage();

                // Use projectUrl if provided, otherwise use default Flow URL
                let launchUrl: string;
                if (options?.projectUrl) {
                    // Add profileId to project URL for extension binding
                    const urlObj = new URL(options.projectUrl);
                    urlObj.searchParams.set('profileId', profile.id);
                    launchUrl = urlObj.toString();
                    logger.info(`Navigating to project URL: ${launchUrl}`);
                } else {
                    launchUrl = `https://labs.google/fx/tools/flow?profileId=${encodeURIComponent(profile.id)}`;
                    logger.info(`Navigating to Google Flow (profileId=${profile.id})...`);
                }

                await targetPage.goto(launchUrl, {
                    waitUntil: 'networkidle',
                    timeout: 30000
                });
                logger.info(`✅ Navigated to Flow page for profile: ${profile.name}`);
            } catch (navError) {
                logger.warn(`⚠️ Could not navigate to Flow page: ${navError}`);
            }

            // IMPORTANT: Listen for browser close event (manual close)
            // This handles when user clicks X on browser window
            browserContext.on('close', () => {
                logger.info(`🔔 Browser closed for profile: ${profile.name} (manual or auto)`);
                this.activeSessions.delete(profile.id);

                // Emit event for dashboard to update
                this.emitBrowserClosed(profile.id);
            });

            // Also listen for disconnect
            browserContext.on('disconnect', () => {
                logger.info(`🔔 Browser disconnected for profile: ${profile.name}`);
                this.activeSessions.delete(profile.id);
                this.emitBrowserClosed(profile.id);
            });

            logger.info(`✅ Browser launched successfully for profile: ${profile.name}`);

            return profileState;
        } catch (error) {
            logger.error(`❌ Error launching browser for profile ${profile.name}:`, error);
            throw error;
        }
    }

    /**
     * Event listeners for browser close
     */
    private closeListeners: Array<(profileId: string) => void> = [];

    public onBrowserClosed(callback: (profileId: string) => void): void {
        this.closeListeners.push(callback);
    }

    private emitBrowserClosed(profileId: string): void {
        this.closeListeners.forEach(cb => {
            try {
                cb(profileId);
            } catch (e) {
                logger.error('Error in browser close callback:', e);
            }
        });
    }

    /**
     * Close browser for a profile
     */
    public async closeProfile(profileId: string): Promise<boolean> {
        const session = this.activeSessions.get(profileId);
        if (!session) {
            logger.warn(`No active session found for profile: ${profileId}`);
            return false;
        }

        try {
            if (session.browserContext) {
                // Close all pages first
                const pages = session.browserContext.pages();
                logger.info(`Closing ${pages.length} pages for profile: ${profileId}`);

                await session.browserContext.close();
                logger.info(`Browser closed for profile: ${session.profile.name}`);
            }

            session.isActive = false;
            this.activeSessions.delete(profileId);
            return true;
        } catch (error) {
            logger.error(`Error closing browser for profile ${profileId}:`, error);
            // Still remove from active sessions
            this.activeSessions.delete(profileId);
            return false;
        }
    }

    /**
     * Get active session for a profile
     */
    public getSession(profileId: string): ProfileState | undefined {
        return this.activeSessions.get(profileId);
    }

    /**
     * Get all active sessions
     */
    public getActiveSessions(): ProfileState[] {
        return Array.from(this.activeSessions.values());
    }

    /**
     * Check if profile has active session
     */
    public isActive(profileId: string): boolean {
        return this.activeSessions.has(profileId);
    }

    /**
     * Get pages count for a profile
     */
    public getPageCount(profileId: string): number {
        const session = this.activeSessions.get(profileId);
        if (!session?.browserContext) return 0;
        return session.browserContext.pages().length;
    }

    /**
     * Close all active sessions
     */
    public async closeAll(): Promise<void> {
        logger.info(`Closing ${this.activeSessions.size} active sessions...`);

        const closePromises = Array.from(this.activeSessions.keys()).map((profileId) =>
            this.closeProfile(profileId)
        );

        await Promise.all(closePromises);
        logger.info('All sessions closed');
    }

    /**
     * Create a new page in the browser context
     */
    public async createPage(profileId: string): Promise<any> {
        const session = this.activeSessions.get(profileId);
        if (!session || !session.browserContext) {
            throw new Error(`No active session for profile: ${profileId}`);
        }

        return await session.browserContext.newPage();
    }

    /**
     * Get all pages for a profile
     */
    public getPages(profileId: string): any[] {
        const session = this.activeSessions.get(profileId);
        if (!session || !session.browserContext) {
            return [];
        }

        return session.browserContext.pages();
    }
}

export default BrowserManager;
