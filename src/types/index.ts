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
    tier?: string; // PaygateTier - stored in session, but kept here for convenience
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

// Pipeline types
export type PipelineStatus = 'pending' | 'processing' | 'paused' | 'completed' | 'failed';

export interface SceneTask {
    id: string;
    pipelineId: string;
    sceneIndex: number;
    sceneData: any;
    status: 'pending' | 'assigned' | 'generating' | 'completed' | 'failed';
    assignedProfileId: string;
    imageUrl: string;
    videoUrl: string;
    characterRefs: Record<string, string>;
    progress: number;
    error: string;
    startedAt?: string;
    completedAt?: string;
}

export interface PipelineStatusResponse {
    pipelineId: string;
    status: PipelineStatus;
    totalScenes: number;
    completedScenes: number;
    failedScenes: number;
    progress: number;
    scenes: Array<{
        sceneIndex: number;
        status: string;
        imageUrl?: string;
        videoUrl?: string;
        error?: string;
        assignedProfileId?: string;
    }>;
}

export interface VideoPipeline {
    id: string;
    name: string;
    projectId?: string;
    scriptId: string;
    profileIds: string;
    status: PipelineStatus;
    config: Record<string, any>;
    totalScenes: number;
    completedScenes: number;
    failedScenes: number;
    outputFolder: string;
    errorMessage?: string;
    createdAt: string;
    updatedAt: string;
}

export interface VideoProjectSettings {
    id: string;
    projectId: string;
    selectedProfileIds: string;
    defaultModel?: string;
    defaultDuration?: string;
    defaultAspectRatio?: string;
    createdAt: string;
    updatedAt: string;
}

export interface CreatePipelineRequest {
    name: string;
    projectId?: string;
    scriptId: string;
    selectedProfileIds: string[];
    outputFolder: string;
    config?: Record<string, any>;
    scenes: Array<Record<string, any>>;
}

export interface RetryPipelineRequest {
    taskIds?: string[];
}

export interface ClaimSceneRequest {
    profileId: string;
}

export interface FinalizeConfig {
    mode?: 'concat' | 'xfade';
    transition?: string;
    transitionDurationSeconds?: number;
    originalAudioVolumePercent?: number;
    musicPath?: string;
    musicVolume?: number;
    logoPath?: string;
    logoWidth?: number;
    logoHeight?: number;
    logoPosition?: string;
    logoXPercent?: number;
    logoYPercent?: number;
    logoZoomPercent?: number;
    textOverlay?: string;
    textBgOpacityPercent?: number;
}

export interface VideoPipelineFinalOutput {
    pipelineId: string;
    finalVideoPath?: string;
    finalVideoFileName?: string;
    status: string;
    completedScenes: number;
    failedScenes: number;
    totalScenes: number;
}
