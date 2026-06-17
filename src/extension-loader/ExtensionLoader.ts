import fs from 'fs';
import path from 'path';
import { BrowserContext } from 'playwright';
import { ExtensionInfo } from '../types';
import logger from '../utils/logger';
import CONFIG from '../config';

export class ExtensionLoader {
    private extensionPath: string;

    constructor(extensionPath?: string) {
        this.extensionPath = extensionPath || CONFIG.paths.extension;
    }

    /**
     * Validate that the extension directory exists and has required files
     */
    public validateExtension(): boolean {
        if (!fs.existsSync(this.extensionPath)) {
            logger.error(`Extension path not found: ${this.extensionPath}`);
            return false;
        }

        const manifestPath = path.join(this.extensionPath, 'manifest.json');
        if (!fs.existsSync(manifestPath)) {
            logger.error(`Extension manifest not found: ${manifestPath}`);
            return false;
        }

        try {
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
            logger.info(`Extension validated: ${manifest.name} v${manifest.version}`);
            return true;
        } catch (error) {
            logger.error('Error parsing extension manifest:', error);
            return false;
        }
    }

    /**
     * Get extension information from manifest
     */
    public getExtensionInfo(): ExtensionInfo | null {
        try {
            const manifestPath = path.join(this.extensionPath, 'manifest.json');
            const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

            return {
                id: '', // Will be populated after loading
                name: manifest.name,
                version: manifest.version,
                path: this.extensionPath,
            };
        } catch (error) {
            logger.error('Error reading extension info:', error);
            return null;
        }
    }

    /**
     * Extract extension ID from the browser context
     */
    public async getExtensionId(context: BrowserContext): Promise<string | null> {
        try {
            // Wait for extension to load
            await this.waitForExtension(context);

            // Get background pages (extension service workers)
            const backgroundPages = context.serviceWorkers();

            for (const worker of backgroundPages) {
                const url = worker.url();
                if (url.startsWith('chrome-extension://')) {
                    const extensionId = url.split('/')[2];
                    logger.info(`Extension ID found: ${extensionId}`);
                    return extensionId;
                }
            }

            logger.warn('Could not find extension ID from service workers');
            return null;
        } catch (error) {
            logger.error('Error getting extension ID:', error);
            return null;
        }
    }

    /**
     * Wait for extension to be fully loaded and active
     */
    public async waitForExtension(
        context: BrowserContext,
        timeout: number = 30000
    ): Promise<boolean> {
        const startTime = Date.now();
        const checkInterval = CONFIG.extension.checkInterval;

        logger.info('Waiting for extension to load...');

        while (Date.now() - startTime < timeout) {
            const serviceWorkers = context.serviceWorkers();

            // Check if any service worker is from a chrome-extension
            for (const worker of serviceWorkers) {
                if (worker.url().startsWith('chrome-extension://')) {
                    logger.info('Extension loaded successfully');
                    return true;
                }
            }

            // Wait before next check
            await new Promise((resolve) => setTimeout(resolve, checkInterval));
        }

        logger.warn('Extension did not load within timeout period');
        return false;
    }

    /**
     * Verify extension is active by checking for expected behavior
     */
    public async verifyExtensionActive(
        context: BrowserContext,
        extensionId: string
    ): Promise<boolean> {
        try {
            // Open extension popup or side panel to verify it's working
            const page = await context.newPage();
            const extensionUrl = `chrome-extension://${extensionId}/popup.html`;

            await page.goto(extensionUrl, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1000);

            const isLoaded = await page.evaluate(() => {
                return document.readyState === 'complete';
            });

            await page.close();

            if (isLoaded) {
                logger.info('Extension is active and functional');
            } else {
                logger.warn('Extension may not be fully functional');
            }

            return isLoaded;
        } catch (error) {
            logger.error('Error verifying extension:', error);
            return false;
        }
    }

    /**
     * Get the extension path for browser launch
     */
    public getExtensionPath(): string {
        return this.extensionPath;
    }
}

export default ExtensionLoader;
