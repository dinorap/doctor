export interface ProxyConfig {
    host: string;
    port: number;
    username?: string;
    password?: string;
}

export type PaygateTier = 'PAYGATE_TIER_ONE' | 'PAYGATE_TIER_TWO' | 'UNKNOWN';

export interface ProfileConfig {
    id: string;
    name: string;
    profilePath: string;
    createdAt: string;
    lastUsed?: string;
    metadata?: Record<string, any>;
    proxy?: ProxyConfig;
}

export interface Profile extends ProfileConfig {
    isActive: boolean;
    tier?: PaygateTier;
    hasSavedSession?: boolean;
    lastSaved?: string;
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

export interface ApiResponse<T = any> {
    success: boolean;
    data?: T;
    error?: string;
    message?: string;
}

export interface FlowCreditsResponse {
    credits?: number;
    userPaygateTier?: PaygateTier;
    [key: string]: any;
}

export interface FlowProjectResult {
    profileId: string;
    name: string;
    projectId?: string;
    result?: any;
    error?: string;
    status: 'pending' | 'creating' | 'success' | 'error';
}

export interface CreateFlowProjectRequest {
    profileId: string;
    name: string;
    description?: string;
    toolName?: string;
}

export interface CreateFlowProjectsBatchRequest {
    profileIds: string[];
    name: string;
    description?: string;
    toolName?: string;
}

export interface FlowProject {
    id: string;
    profileId: string;
    name: string;
    description?: string;
    toolName?: string;
    createdAt?: string;
    projectId?: string;
}

export interface CloakBrowserStatus {
    available: boolean;
    ready: boolean;
    downloading?: boolean;
    stealthMode?: boolean;
}

export interface ExtensionStatus {
    connected: boolean;
    agentConnected: boolean;
    flowKeyPresent: boolean;
    tokenAge: number | null;
    state: 'idle' | 'running' | 'off';
    metrics?: {
        requestCount: number;
        successCount: number;
        failedCount: number;
    };
}

export interface Session {
    id: string;
    profileId: string;
    tier: PaygateTier;
    isActive: boolean;
    createdAt: string;
    updatedAt: string;
}
