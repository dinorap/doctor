import path from 'path';
import fs from 'fs';

const SETTINGS_PATH = path.join(process.cwd(), 'data', 'gemini-settings.json');

export interface GeminiSettings {
    apiKeys: string;      // multi-line string
    model: string;        // short name: "gemini-3.5-flash"
    updatedAt: string;    // ISO date string
}

const DEFAULT_SETTINGS: GeminiSettings = {
    apiKeys: '',
    model: 'gemini-3.5-flash',
    updatedAt: '',
};

function ensureDataDir(): void {
    const dir = path.dirname(SETTINGS_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

export function loadGeminiSettings(): GeminiSettings {
    try {
        if (!fs.existsSync(SETTINGS_PATH)) {
            return { ...DEFAULT_SETTINGS };
        }
        const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
            apiKeys: typeof parsed.apiKeys === 'string' ? parsed.apiKeys : '',
            model: typeof parsed.model === 'string' ? parsed.model : DEFAULT_SETTINGS.model,
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
        };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

export function saveGeminiSettings(settings: Partial<GeminiSettings>): GeminiSettings {
    ensureDataDir();
    const current = loadGeminiSettings();
    const updated: GeminiSettings = {
        ...current,
        ...settings,
        updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(updated, null, 2), 'utf-8');
    return updated;
}
