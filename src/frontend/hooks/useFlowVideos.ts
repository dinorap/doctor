import { useState, useCallback } from 'react';
import { api } from '../services/api';
import type {
  VideoGenerationRequest,
  UploadImageRequest,
  UploadImageResult,
  VideoStatusResponse,
  GeneratedVideoResult,
  UpscaleVideoRequest,
} from '../types';

interface UseFlowVideosState {
  generating: boolean;
  uploading: boolean;
  polling: boolean;
  lastResult: GeneratedVideoResult | null;
  uploadResult: UploadImageResult | null;
  videoStatus: VideoStatusResponse | null;
  error: string | null;
}

export function useFlowVideos() {
  const [state, setState] = useState<UseFlowVideosState>({
    generating: false,
    uploading: false,
    polling: false,
    lastResult: null,
    uploadResult: null,
    videoStatus: null,
    error: null,
  });

  const setBusy = useCallback(
    (patch: Partial<UseFlowVideosState>) =>
      setState((prev) => ({ ...prev, ...patch })),
    [],
  );

  const clearError = useCallback(() => setState((prev) => ({ ...prev, error: null })), []);
  const reset = useCallback(
    () =>
      setState({
        generating: false,
        uploading: false,
        polling: false,
        lastResult: null,
        uploadResult: null,
        videoStatus: null,
        error: null,
      }),
    [],
  );

  const uploadReferenceImage = useCallback(
    async (data: UploadImageRequest) => {
      setBusy({ uploading: true, error: null, uploadResult: null });
      try {
        const result = await api.uploadFlowVideoImage(data);
        setBusy({ uploading: false, uploadResult: result as UploadImageResult });
        return result as UploadImageResult;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Upload image failed';
        setBusy({ uploading: false, error: message });
        throw error;
      }
    },
    [setBusy],
  );

  const generateVideo = useCallback(
    async (data: VideoGenerationRequest) => {
      setBusy({ generating: true, error: null, lastResult: null });
      try {
        const result = await api.generateFlowVideo({
          ...data,
          aspectRatio: data.aspectRatio,
          duration: data.duration,
        });
        setBusy({
          generating: false,
          lastResult: {
            profileId: data.profileId,
            projectId: data.projectId,
            sceneId: data.sceneId,
            mode: data.mode,
            aspectRatio: (data.aspectRatio as any) || 'VIDEO_ASPECT_RATIO_PORTRAIT',
            duration: data.duration,
            userPaygateTier: data.userPaygateTier || 'PAYGATE_TIER_TWO',
            operations: result.operations || [],
            requestIds: result.requestIds || [],
            mediaId: result.mediaId || null,
            servingUri: result.servingUri || null,
            downloadUrl: result.downloadUrl || null,
            localPath: result.localPath || null,
            rawResult: result.rawResult || result,
          },
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Generate video failed';
        setBusy({ generating: false, error: message });
        throw error;
      }
    },
    [setBusy],
  );

  const upscaleVideo = useCallback(
    async (data: UpscaleVideoRequest) => {
      setBusy({ generating: true, error: null });
      try {
        const result = await api.upscaleFlowVideo(data);
        setBusy({
          generating: false,
          lastResult: {
            profileId: data.profileId,
            projectId: data.projectId,
            sceneId: data.sceneId,
            mode: 'image_to_video',
            aspectRatio: (data.aspectRatio as any) || 'VIDEO_ASPECT_RATIO_PORTRAIT',
            userPaygateTier: 'PAYGATE_TIER_TWO',
            operations: result.operations || [],
            requestIds: result.requestIds || [],
            mediaId: data.mediaId,
            rawResult: result.rawResult || result,
          },
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Upscale video failed';
        setBusy({ generating: false, error: message });
        throw error;
      }
    },
    [setBusy],
  );

  const pollStatus = useCallback(
    async (profileId: string, operations: string[]) => {
      setBusy({ polling: true, error: null });
      try {
        const result = await api.checkVideoStatus({ profileId, operations });
        setBusy({
          polling: false,
          videoStatus: {
            operations: result.operations || [],
            requestIds: result.requestIds || [],
          },
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Check status failed';
        setBusy({ polling: false, error: message });
        throw error;
      }
    },
    [setBusy],
  );

  const autoGenerateScenes = useCallback(
    async (_profileId: string, _projectId: string, _videoId: string, _numScenes = 5) => {
      // Placeholder for future LLM-backed scene generation endpoint.
      setBusy({ error: 'Auto-generate scenes is not implemented yet' });
      return Promise.resolve({ success: true, count: 0, scenes: [] });
    },
    [setBusy],
  );

  return {
    generating: state.generating,
    uploading: state.uploading,
    polling: state.polling,
    lastResult: state.lastResult,
    uploadResult: state.uploadResult,
    videoStatus: state.videoStatus,
    error: state.error,
    generateVideo,
    upscaleVideo,
    uploadReferenceImage,
    pollStatus,
    autoGenerateScenes,
    reset,
    clearError,
  };
}
