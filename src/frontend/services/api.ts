import type {
  Profile,
  ApiResponse,
  CloakBrowserStatus,
  CreateProfileRequest,
  OpenProfileRequest,
  FlowCreditsResponse,
  PaygateTier,
  CreateFlowProjectsBatchRequest,
  FlowProject,
  GeneratedImageResult,
  VideoOperation,
  VideoGenerationRequest,
  GeneratedVideoResult,
  UploadImageRequest,
  UploadImageResult,
  VideoStatusData,
  UpscaleVideoRequest,
  VideoPipeline,
  PipelineStatusResponse,
  SceneTask,
  VideoProjectSettings,
  CreatePipelineRequest,
  RetryPipelineRequest,
  ClaimSceneRequest,
} from '../types';

const API_BASE = '';

class ApiService {
  private async request<T>(url: string, options?: RequestInit): Promise<T> {
    try {
      const response = await fetch(`${API_BASE}${url}`, {
        headers: {
          'Content-Type': 'application/json',
          ...options?.headers,
        },
        ...options,
      });

      // Check if response is ok before parsing JSON
      let result: ApiResponse<T>;
      try {
        result = await response.json();
      } catch (jsonError) {
        // Response is not valid JSON
        const text = await response.text().catch(() => 'Unable to read response');
        throw new Error(`Invalid JSON response (${response.status}): ${text.slice(0, 200)}`);
      }

      if (!response.ok || !result.success) {
        throw new Error(result.error || `Request failed with status ${response.status}`);
      }

      return result.data as T;
    } catch (error) {
      // Network error or other issues
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new Error('Network error: Unable to connect to server');
      }
      throw error;
    }
  }

  // Profiles
  async getProfiles(): Promise<Profile[]> {
    return this.request<Profile[]>('/api/profiles');
  }

  async createProfile(data: CreateProfileRequest): Promise<Profile> {
    return this.request<Profile>('/api/profiles/create', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateProfile(id: string, data: { name?: string; metadata?: Record<string, any> }): Promise<Profile> {
    return this.request<Profile>(`/api/profiles/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  }

  async deleteProfile(id: string): Promise<void> {
    await this.request<void>(`/api/profiles/${id}`, {
      method: 'DELETE',
    });
  }

  async openProfile(data: OpenProfileRequest): Promise<{ profileId: string; extensionId?: string }> {
    return this.request<{ profileId: string; extensionId?: string }>('/api/profiles/open', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async closeProfile(id: string): Promise<void> {
    await this.request<void>(`/api/profiles/${id}/close`, {
      method: 'POST',
    });
  }

  async saveSession(id: string): Promise<void> {
    await this.request<void>(`/api/sessions/${id}/save`, {
      method: 'POST',
    });
  }

  async refreshTier(id: string): Promise<{ tier: string }> {
    return this.request<{ tier: string }>(`/api/profiles/${id}/tier/refresh`, {
      method: 'POST',
    });
  }

  async setProxy(id: string, proxy: string | null): Promise<Profile> {
    return this.request<Profile>(`/api/profiles/${id}/proxy`, {
      method: 'POST',
      body: JSON.stringify({ proxy }),
    });
  }

  async updateProfileMetadata(id: string, metadata: Record<string, any>): Promise<{ id: string; metadata: Record<string, any> }> {
    return this.request<{ id: string; metadata: Record<string, any> }>('/api/profiles/update-metadata', {
      method: 'POST',
      body: JSON.stringify({ id, metadata }),
    });
  }

  // CloakBrowser
  async getCloakBrowserStatus(): Promise<CloakBrowserStatus> {
    return this.request<CloakBrowserStatus>('/api/cloakbrowser/status');
  }

  // Flow API
  async createFlowProject(profileId: string, name: string, description?: string, toolName?: string): Promise<any> {
    return this.request<any>('/api/flow/projects/create', {
      method: 'POST',
      body: JSON.stringify({ profileId, name, description, toolName }),
    });
  }

  async generateFlowImage(data: {
    profileId: string;
    prompt: string;
    projectId?: string;
    modelKey?: string;
    aspectRatio?: string;
    userPaygateTier?: 'PAYGATE_TIER_ONE' | 'PAYGATE_TIER_TWO';
    upscaleResolution?: string;
  }): Promise<GeneratedImageResult> {
    return this.request<GeneratedImageResult>('/api/flow/images/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getFlowCredits(profileId: string): Promise<FlowCreditsResponse & { profileId: string; source: string }> {
    return this.request<FlowCreditsResponse & { profileId: string; source: string }>(
      `/api/flow/credits?profileId=${encodeURIComponent(profileId)}`,
    );
  }

  async getExtensionTier(profileId: string): Promise<{
    profileId: string;
    tier: PaygateTier;
    connected: boolean;
    source: string;
    credits?: number;
  }> {
    return this.request(`/api/extension/tier?profileId=${encodeURIComponent(profileId)}`);
  }

  async getExtensionStatus(profileId: string): Promise<any> {
    return this.request(`/api/extension/status?profileId=${encodeURIComponent(profileId)}`);
  }

  async waitForProfileReady(profileId: string, timeoutMs = 20000): Promise<any> {
    return this.request(`/api/flow/projects/prepare-profile`, {
      method: 'POST',
      body: JSON.stringify({ profileId, timeoutMs }),
    });
  }

  // Flow Projects (batch)
  async createFlowProjectsBatch(data: CreateFlowProjectsBatchRequest): Promise<any> {
    return this.request<any>('/api/flow/projects/create-batch', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Flow Videos
  async uploadFlowVideoImage(data: UploadImageRequest): Promise<UploadImageResult> {
    return this.request<UploadImageResult>('/api/flow/videos/upload-image', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async uploadLibraryEntityImage(entityId: string, profileId: string, projectId: string): Promise<{ entityId: string; originalMediaId: string; newMediaId: string; fileName: string }> {
    return this.request<{ entityId: string; originalMediaId: string; newMediaId: string; fileName: string }>('/api/library/entities/' + entityId + '/upload', {
      method: 'POST',
      body: JSON.stringify({ profileId, projectId }),
    });
  }

  async generateFlowVideo(data: VideoGenerationRequest): Promise<GeneratedVideoResult> {
    return this.request<GeneratedVideoResult>('/api/flow/videos/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async upscaleFlowVideo(data: UpscaleVideoRequest): Promise<GeneratedVideoResult> {
    return this.request<GeneratedVideoResult>('/api/flow/videos/upscale', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async checkVideoStatus(data: {
    profileId: string;
    projectId?: string;
    operations?: string[];
    mediaIds?: string[];
  }): Promise<VideoStatusData> {
    return this.request<VideoStatusData>('/api/flow/videos/status', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getEntities(profileId?: string): Promise<any[]> {
    const qs = profileId ? `?profileId=${encodeURIComponent(profileId)}` : '';
    return this.request<any[]>('/api/entities' + qs);
  }

  // Script Generation
  async generateScript(data: {
    profileId?: string;
    projectId?: string;
    input_type: 'youtube_url' | 'topic' | 'upload_files';
    youtube_url?: string;
    topic?: string;
    upload_files?: string[];
    language?: string;
    duration_minutes?: number;
    copy_ratio?: number;
    additional_description?: string;
    gemini_api_keys?: string;
    gemini_model?: string;
    temperature?: number;
    no_voice?: boolean;
    no_music?: boolean;
    material_id?: string;
    storytelling_mode?: 'auto' | 'narration' | 'dialogue' | 'mixed';
  }): Promise<{
    title: string;
    topic: string;
    duration_seconds: number;
    total_scenes: number;
    storytelling_mode?: string;
    summary?: string;
    style_notes?: string;
    characters?: {
      name: string;
      role?: string;
      description?: string;
    }[];
    scenes: {
      scene_id: number;
      scene_title: string;
      characters?: string[];
      visual_prompt: string;
      tts_script: string;
      duration_seconds: number;
      suggested_visual?: string;
      transition?: string;
      material_id?: string;
    }[];
    script_id?: string;
    script_version?: number;
  }> {
    return this.request('/api/scripts/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getGeminiSettings(): Promise<{ apiKeys: string; model: string; updatedAt: string }> {
    return this.request('/api/gemini-settings');
  }

  // Scripts
  async getScripts(profileId?: string, projectId?: string): Promise<any[]> {
    const params = new URLSearchParams();
    if (profileId) params.append('profileId', profileId);
    if (projectId) params.append('projectId', projectId);
    const qs = params.toString() ? `?${params.toString()}` : '';
    return this.request<any[]>('/api/scripts' + qs);
  }

  async getScript(id: string): Promise<any> {
    return this.request<any>(`/api/scripts/${id}`);
  }

  async deleteScript(id: string): Promise<void> {
    return this.request('/api/scripts/' + id, { method: 'DELETE' });
  }

  async saveScript(data: {
    projectId: string;
    profileId?: string;
    content: string;
    metadata?: Record<string, any>;
  }): Promise<any> {
    return this.request('/api/scripts', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Update script with character descriptions injected into scene prompts
  async updateScriptWithCharacters(data: {
    scriptId: string;
    characters: Array<{
      name: string;
      description: string;
      imagePrompt?: string;
      entityId?: string;
    }>;
  }): Promise<any> {
    return this.request('/api/scripts/update-characters', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async updateScriptScene(data: {
    scriptId: string;
    scenes: Array<{
      scene_id: number;
      scene_title?: string;
      description?: string;
      tts_script?: string;
      visual_prompt?: string;
      image_prompt?: string;
      duration_seconds?: number;
      transition?: string;
      suggested_visual?: string;
      characters?: string[];
    }>;
  }): Promise<{ id: string; updatedSceneIds: number[]; content: any }> {
    return this.request('/api/scripts/update-scenes', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async saveGeminiSettings(data: { apiKeys: string; model: string }): Promise<{ apiKeys: string; model: string; updatedAt: string }> {
    return this.request('/api/gemini-settings', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  // Pipelines
  async getPipelines(): Promise<VideoPipeline[]> {
    return this.request<VideoPipeline[]>('/api/pipelines');
  }

  async getPipeline(id: string): Promise<VideoPipeline> {
    return this.request<VideoPipeline>(`/api/pipelines/${id}`);
  }

  async createPipeline(data: CreatePipelineRequest): Promise<VideoPipeline> {
    return this.request<VideoPipeline>('/api/pipelines', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async startPipeline(id: string, profileCredits?: Array<{ profileId: string; credits: number }>): Promise<void> {
    await this.request(`/api/pipelines/${id}/start`, {
      method: 'POST',
      body: JSON.stringify({ profileCredits }),
    });
  }

  async retryCaptchaErrors(id: string): Promise<{ retriedCount: number }> {
    return this.request<{ retriedCount: number }>(`/api/pipelines/${id}/retry-captcha`, { method: 'POST' });
  }

  async getPipelineProgress(id: string): Promise<{ completed: number; failed: number; total: number; processing: number }> {
    return this.request<{ completed: number; failed: number; total: number; processing: number }>(`/api/pipelines/${id}/progress`);
  }

  async pausePipeline(id: string): Promise<void> {
    await this.request(`/api/pipelines/${id}/pause`, { method: 'POST' });
  }

  async stopPipeline(id: string): Promise<void> {
    await this.request(`/api/pipelines/${id}/stop`, { method: 'POST' });
  }

  async retryPipeline(id: string, taskIds?: string[]): Promise<{ retriedCount: number }> {
    return this.request<{ retriedCount: number }>(`/api/pipelines/${id}/retry`, {
      method: 'POST',
      body: JSON.stringify({ taskIds }),
    });
  }

  async deletePipeline(id: string): Promise<void> {
    await this.request(`/api/pipelines/${id}`, { method: 'DELETE' });
  }

  async getPipelineStatus(id: string): Promise<PipelineStatusResponse> {
    return this.request<PipelineStatusResponse>(`/api/pipelines/${id}/status`);
  }

  async getPipelineScenes(id: string): Promise<SceneTask[]> {
    return this.request<SceneTask[]>(`/api/pipelines/${id}/scenes`);
  }

  async claimScene(pipelineId: string, sceneIndex: number, profileId: string): Promise<SceneTask> {
    return this.request<SceneTask>(`/api/pipelines/${pipelineId}/scene/${sceneIndex}/claim`, {
      method: 'POST',
      body: JSON.stringify({ profileId }),
    });
  }

  async updateScene(pipelineId: string, sceneIndex: number, data: Partial<SceneTask>): Promise<void> {
    await this.request(`/api/pipelines/${pipelineId}/scene/${sceneIndex}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  }

  async getProjectVideoSettings(projectId: string): Promise<VideoProjectSettings | null> {
    const result = await this.request<{ data: VideoProjectSettings | null }>(`/api/pipelines/settings/project/${projectId}`);
    return result.data || null;
  }

  async saveProjectVideoSettings(data: {
    projectId: string;
    selectedProfileIds: string[];
    defaultModel?: string;
    defaultDuration?: string;
    defaultAspectRatio?: string;
  }): Promise<VideoProjectSettings> {
    return this.request<VideoProjectSettings>(`/api/pipelines/settings/project/${data.projectId}`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async uploadReferenceImages(pipelineId: string): Promise<{
    totalImages: number;
    totalProfiles: number;
    successfulUploads: string[];
    failedImages: string[];
    mediaMapPath: string;
  }> {
    return this.request(`/api/pipelines/${pipelineId}/upload-refs`, { method: 'POST' });
  }

  async finalAssemblePipeline(pipelineId: string, data?: {
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
  }): Promise<{
    pipelineId: string;
    finalVideoPath: string;
    finalVideoFileName: string;
    completedScenes: number;
    failedScenes: number;
    totalScenes: number;
  }> {
    return this.request(`/api/pipelines/${pipelineId}/final-assemble`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
    });
  }

  async getFinalOutput(pipelineId: string): Promise<{
    pipelineId: string;
    status: string;
    finalVideoPath: string | null;
    localFinalVideoPath: string | null;
    finalize: any;
  }> {
    return this.request(`/api/pipelines/${pipelineId}/final-output`);
  }
}

export const api = new ApiService();
