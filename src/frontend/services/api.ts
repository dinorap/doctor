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
} from '../types';

const API_BASE = '';

class ApiService {
  private async request<T>(url: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${API_BASE}${url}`, {
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
      ...options,
    });

    const result: ApiResponse<T> = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Request failed');
    }

    return result.data as T;
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
  }): Promise<{
    title: string;
    topic: string;
    duration_seconds: number;
    total_scenes: number;
    summary?: string;
    style_notes?: string;
    scenes: {
      scene_id: number;
      scene_title: string;
      description: string;
      image_prompt: string;
      tts_script: string;
      duration_seconds: number;
      suggested_visual?: string;
      transition?: string;
    }[];
  }> {
    return this.request('/api/scripts/generate', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }

  async getGeminiSettings(): Promise<{ apiKeys: string; model: string; updatedAt: string }> {
    return this.request('/api/gemini-settings');
  }

  async saveGeminiSettings(data: { apiKeys: string; model: string }): Promise<{ apiKeys: string; model: string; updatedAt: string }> {
    return this.request('/api/gemini-settings', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  }
}

export const api = new ApiService();
