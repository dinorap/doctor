import { BrowserContext } from 'playwright';
import { ProfileConfig } from '../types';
import logger from '../utils/logger';
import CONFIG from '../config';

interface CloakBrowserLaunchOptions {
    profile: ProfileConfig;
    headless?: boolean;
    proxy?: string;
    geoip?: boolean;
    humanize?: boolean;
    humanPreset?: 'default' | 'careful';
    stealthArgs?: boolean;
    args?: string[];
}

interface LaunchResult {
    browserContext: BrowserContext;
    extensionId?: string;
    cloaked: boolean;
}

export class CloakBrowserManager {
    private cloakBrowserModule: any = null;
    private isAvailable: boolean = false;

    constructor() {
        this.initCloakBrowser();
    }

    private async initCloakBrowser(): Promise<void> {
        try {
            this.cloakBrowserModule = await import('cloakbrowser');
            this.isAvailable = true;
            logger.info('CloakBrowser loaded successfully');
        } catch (error) {
            logger.warn('CloakBrowser not available, using standard Playwright');
            this.isAvailable = false;
        }
    }

    public async isCloakBrowserAvailable(): Promise<boolean> {
        return this.isAvailable;
    }

    public async launchProfile(options: CloakBrowserLaunchOptions): Promise<LaunchResult> {
        const { profile, headless = false, stealthArgs = true } = options;

        if (!this.isAvailable || !this.cloakBrowserModule) {
            logger.warn('CloakBrowser not available, falling back to standard browser');
            return this.launchStandardBrowser(profile, headless);
        }

        try {
            logger.info(`Launching CloakBrowser for profile: ${profile.name}`);

            const launchOptions: any = {
                headless,
                stealthArgs,
            };

            // Add extension paths if available
            const extensionPath = CONFIG.paths.extension;
            if (extensionPath) {
                launchOptions.extensionPaths = [extensionPath];
            }

            // Launch using CloakBrowser's persistent context
            const browserContext = await this.cloakBrowserModule.launchPersistentContext(
                profile.profilePath,
                launchOptions
            );

            logger.info(`CloakBrowser launched successfully for: ${profile.name}`);

            return {
                browserContext,
                cloaked: true,
            };
        } catch (error) {
            logger.error(`CloakBrowser launch failed, falling back to standard browser:`, error);
            return this.launchStandardBrowser(profile, headless);
        }
    }

    private async launchStandardBrowser(profile: ProfileConfig, headless: boolean): Promise<LaunchResult> {
        logger.info(`Launching standard Chromium for profile: ${profile.name}`);

        const { chromium } = await import('playwright');

        const extensionPath = CONFIG.paths.extension;
        const args = [
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-site-isolation-trials',
        ];

        if (extensionPath) {
            args.push(`--disable-extensions-except=${extensionPath}`);
            args.push(`--load-extension=${extensionPath}`);
        }

        const browserContext = await chromium.launchPersistentContext(
            profile.profilePath,
            {
                headless,
                args,
                acceptDownloads: true,
                viewport: null,
            }
        );

        return {
            browserContext,
            cloaked: false,
        };
    }

    public async launchWithStealth(
        profile: ProfileConfig,
        options: {
            headless?: boolean;
            proxy?: string;
            geoip?: boolean;
            humanize?: boolean;
            humanPreset?: 'default' | 'careful';
        } = {}
    ): Promise<LaunchResult> {
        const { headless = false, proxy, geoip = false, humanize = false, humanPreset = 'default' } = options;

        if (!this.isAvailable || !this.cloakBrowserModule) {
            logger.warn('CloakBrowser not available');
            return this.launchStandardBrowser(profile, headless);
        }

        try {
            logger.info(`Launching stealth browser for: ${profile.name}`);

            const launchOptions: any = {
                headless,
                geoip,
                humanize,
                humanPreset,
                stealthArgs: true,
            };

            if (proxy) {
                launchOptions.proxy = proxy;
            }

            const extensionPath = CONFIG.paths.extension;
            if (extensionPath) {
                launchOptions.extensionPaths = [extensionPath];
            }

            const browserContext = await this.cloakBrowserModule.launchPersistentContext(
                profile.profilePath,
                launchOptions
            );

            return {
                browserContext,
                cloaked: true,
            };
        } catch (error) {
            logger.error(`Stealth launch failed:`, error);
            return this.launchStandardBrowser(profile, headless);
        }
    }
}

export default new CloakBrowserManager();
