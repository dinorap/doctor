/**
 * Profile configuration and state types
 */

export interface ProfileConfig {
    id: string;
    name: string;
    profilePath: string;
    createdAt: Date;
    lastUsed?: Date;
    metadata?: Record<string, any>;
}

export interface ProfileState {
    profile: ProfileConfig;
    isActive: boolean;
    browserContext?: any;
    extensionId?: string;
    useCloakBrowser?: boolean;
    launchedAt?: Date;
}

export interface CreateProfileRequest {
    name: string;
    metadata?: Record<string, any>;
}

export interface OpenProfileRequest {
    id: string;
    openFlow?: boolean;
    useStealth?: boolean;
}

export interface BrowserLaunchOptions {
    headless?: boolean;
    devtools?: boolean;
    slowMo?: number;
}

export interface ExtensionInfo {
    id: string;
    name: string;
    version: string;
    path: string;
}

export type PaygateTier = 'PAYGATE_TIER_ONE' | 'PAYGATE_TIER_TWO' | 'UNKNOWN';

export interface FlowCreditsResponse {
    credits?: number;
    userPaygateTier?: PaygateTier;
    [key: string]: any;
}

export interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    error?: string;
    message?: string;
}
