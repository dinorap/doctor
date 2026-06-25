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
    flowProjects?: FlowProject[];
    status?: 'running' | 'idle' | 'off';
}

export interface CreateProfileRequest {
    name: string;
    metadata?: Record<string, any>;
}

export interface OpenProfileRequest {
    id: string;
    openFlow?: boolean;
    useStealth?: boolean;
    projectUrl?: string;
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
    profileName?: string; // Extended field from metadata
    name: string;
    description?: string;
    toolName?: string;
    createdAt?: string;
    projectId?: string;
}

export interface GeneratedImageResult {
    profileId: string;
    projectId: string;
    modelKey: string;
    aspectRatio: string;
    userPaygateTier: 'PAYGATE_TIER_ONE' | 'PAYGATE_TIER_TWO';
    mediaId: string | null;
    servingUri: string | null;
    downloadUrl: string | null;
    localPath: string | null;
    rawResult: any;
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

export type VideoAspectRatio =
    | 'VIDEO_ASPECT_RATIO_LANDSCAPE'
    | 'VIDEO_ASPECT_RATIO_PORTRAIT'
    | 'VIDEO_ASPECT_RATIO_SQUARE';

export type VideoDuration = '4s' | '6s' | '8s' | '10s';

export type VideoUpscaleResolution = 'VIDEO_RESOLUTION_1080P' | 'VIDEO_RESOLUTION_4K' | 'VIDEO_RESOLUTION_8K';

export type SelectedVideoResolution = 'original' | VideoUpscaleResolution;

export type VideoGenerationMode = 'start_image' | 'references' | 'start_end';

export interface FlowVideoModel {
    key: string;
    label: string;
    tier: PaygateTier;
    aspectRatios: VideoAspectRatio[];
    durations?: VideoDuration[];
}

export interface VideoOperation {
    name?: string;
    id?: string;
    done?: boolean;
    error?: string;
    response?: any;
}

export interface VideoGenerationRequest {
    profileId: string;
    projectId: string;
    sceneId: string;
    prompt: string;
    mode: VideoGenerationMode;
    aspectRatio?: VideoAspectRatio;
    duration?: VideoDuration;
    modelKey?: string;
    userPaygateTier?: PaygateTier;
    startImageMediaId?: string;
    referenceMediaIds?: string[];
    endImageMediaId?: string;
    negativePrompt?: string;
    seed?: number;
    guidanceScale?: number;
    referenceAudio?: { mediaId: string }[];
}

export interface UploadImageRequest {
    profileId: string;
    filePath: string;
    projectId?: string;
    fileName?: string;
}

export interface UploadImageResult {
    profileId: string;
    projectId: string;
    mediaId: string;
    fileName: string;
    mimeType: string;
    rawResult: any;
}

export interface VideoStatusData {
    profileId: string;
    projectId?: string;
    operations: any[];
    mediaIds: string[];
    status: any;
    media: any[];
    completedVideos: CompletedVideo[];
    isComplete: boolean;
    hasActiveMedia?: boolean;
    hasSuccessfulMedia?: boolean;
    shouldStopPolling?: boolean;
    stopReason?: string;
    autoDownloadResult?: any;
    message?: string;
}

export interface VideoStatusResponse {
    success: boolean;
    data?: VideoStatusData;
    error?: string;
}

export interface CompletedVideo {
    mediaId: string;
    videoUrl: string;
    thumbnailUrl?: string;
    status: string;
}

export interface GeneratedVideoResult {
    profileId: string;
    projectId: string;
    sceneId: string;
    mode: VideoGenerationMode;
    aspectRatio: VideoAspectRatio;
    duration?: VideoDuration;
    modelKey?: string;
    videoModelKey?: string;
    userPaygateTier: PaygateTier;
    operations: VideoOperation[];
    requestIds: string[];
    mediaIds: string[];
    workflows: any[];
    completedVideos?: CompletedVideo[];
    videoUrl?: string;
    media?: any[];
    mediaId?: string;
    servingUri?: string;
    downloadUrl?: string;
    localPath?: string;
    rawResult: any;
}

export interface UpscaleVideoRequest {
    profileId: string;
    projectId: string;
    sceneId: string;
    mediaId: string;
    aspectRatio?: VideoAspectRatio;
    resolution?: VideoUpscaleResolution;
}

export interface AutoGenerateScenesRequest {
    profileId: string;
    projectId: string;
    videoId: string;
    numScenes?: number;
}

export interface AutoGenerateScenesResponse {
    success: boolean;
    count: number;
    scenes: any[];
}

export interface VideoGenerationQueueItem {
    requestId: string;
    profileId: string;
    projectId: string;
    sceneId: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress: number;
    error?: string;
    result?: GeneratedVideoResult;
    createdAt: string;
    updatedAt: string;
}

// Entity types for Library
export type EntityType = 'character' | 'location' | 'creature' | 'visual_asset' | 'generic_troop' | 'faction';

export interface LibraryEntity {
    id: string;
    name: string;
    slug: string;
    entity_type: EntityType;
    description?: string;
    image_prompt?: string;
    reference_image_url?: string;
    media_id?: string;
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

export interface CreatePipelineRequest {
    name: string;
    projectId?: string;
    scriptId: string;
    selectedProfileIds: string[];
    outputFolder: string;
    scenes: Array<{
        sceneIndex: number;
        name?: string;
        description?: string;
        imagePrompt?: string;
        entityId?: string;
    }>;
}

export interface RetryPipelineRequest {
    taskIds?: string[];
}

export interface ClaimSceneRequest {
    profileId: string;
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

// Video Project types for Scene Grid UI
export interface SceneAsset {
    id: string;
    type: 'image' | 'video';
    url: string;
    name: string;
}

export interface SceneData {
    sceneIndex: number;
    prompt: string;
    negativePrompt?: string;
    duration?: string;
    characters?: string[];
    assets: SceneAsset[];
    status: 'pending' | 'generating' | 'completed' | 'failed';
    progress?: number;
    videoUrl?: string;
    imageUrl?: string;
    error?: string;
    assignedProfileId?: string;
}

export interface VideoProject {
    id: string;
    name: string;
    scriptId: string;
    profileIds: string[];
    scenes: SceneData[];
    globalReferences: SceneAsset[];
    createdAt: string;
    updatedAt: string;
}

export interface CharacterRef {
    id: string;
    name: string;
    images: SceneAsset[];
}

