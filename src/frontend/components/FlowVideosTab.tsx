import React, { useState, useEffect, useRef } from 'react';
import type { Profile, FlowProject, GeneratedVideoResult, LibraryEntity, CompletedVideo } from '../types';
import type { VideoAspectRatio, VideoDuration, VideoUpscaleResolution, SelectedVideoResolution } from '../types';
import { api } from '../services/api';
import LibraryModal from './LibraryModal';

interface FlowVideosTabProps {
  profiles: Profile[];
  onOpenProfile?: (profileId: string) => Promise<void>;
  onWaitForProfileReady?: (profileId: string, timeoutMs?: number) => Promise<void>;
}

type OperationStatus = 'pending' | 'processing' | 'completed' | 'failed';
type VideoFeature = 'text_reference' | 'start_end';

interface QueueItem {
  requestId: string;
  profileId: string;
  projectId: string;
  sceneId: string;
  status: OperationStatus;
  progress: number;
  error?: string;
  result?: GeneratedVideoResult;
  createdAt: string;
  updatedAt: string;
}

// 5 Video Models
interface VideoModel {
  id: string;
  name: string;
  icon: string;
  description: string;
  supportedDurations: VideoDuration[];
  supportsAspectRatio: boolean;
  supportsI2v: boolean;
}

const VIDEO_MODELS: VideoModel[] = [
  {
    id: 'omni_flash',
    name: 'Omni Flash',
    icon: '⚡',
    description: 'Fast, 4-10s',
    supportedDurations: ['4s', '6s', '8s', '10s'],
    supportsAspectRatio: false,
    supportsI2v: true,
  },
  {
    id: 'veo_fast',
    name: 'Veo 3.1 - Fast',
    icon: '🚀',
    description: 'Balanced, 4-8s',
    supportedDurations: ['4s', '6s', '8s'],
    supportsAspectRatio: true,
    supportsI2v: true,
  },
  {
    id: 'veo_quality',
    name: 'Veo 3.1 - Quality',
    icon: '✨',
    description: 'Best quality, 4-8s',
    supportedDurations: ['4s', '6s', '8s'],
    supportsAspectRatio: true,
    supportsI2v: true,
  },
  {
    id: 'veo_lite',
    name: 'Veo 3.1 - Lite',
    icon: '🌟',
    description: 'Lightweight, 4-8s',
    supportedDurations: ['4s', '6s', '8s'],
    supportsAspectRatio: false,
    supportsI2v: true,
  },
  {
    id: 'veo_lite_low',
    name: 'Veo 3.1 - Lite [Low Priority]',
    icon: '💫',
    description: 'Free tier, 4-8s',
    supportedDurations: ['4s', '6s', '8s'],
    supportsAspectRatio: false,
    supportsI2v: true,
  },
];

const ASPECT_RATIOS: { value: VideoAspectRatio; label: string }[] = [
  { value: 'VIDEO_ASPECT_RATIO_LANDSCAPE', label: '16:9 Landscape' },
  { value: 'VIDEO_ASPECT_RATIO_PORTRAIT', label: '9:16 Portrait' },
];

const UPSCALE_RESOLUTIONS: { value: VideoUpscaleResolution; label: string }[] = [
  { value: 'VIDEO_RESOLUTION_1080P', label: '1080p' },
  { value: 'VIDEO_RESOLUTION_4K', label: '4K' },
  { value: 'VIDEO_RESOLUTION_8K', label: '8K' },
];

function FlowVideosTab({ profiles, onOpenProfile, onWaitForProfileReady }: FlowVideosTabProps) {
  const [selectedProjectName, setSelectedProjectName] = useState<string>('');
  const [selectedProfileIdx, setSelectedProfileIdx] = useState<number>(0);

  // Feature selection: text_reference | start_end
  const [feature, setFeature] = useState<VideoFeature>('text_reference');

  // Model selection
  const [selectedModel, setSelectedModel] = useState<VideoModel>(VIDEO_MODELS[1]);
  const [aspectRatio, setAspectRatio] = useState<VideoAspectRatio>('VIDEO_ASPECT_RATIO_LANDSCAPE');
  const [duration, setDuration] = useState<VideoDuration>('8s');

  // Prompt & Media
  const [prompt, setPrompt] = useState('');
  const [negativePrompt, setNegativePrompt] = useState('');
  const [seed, setSeed] = useState<string>('');
  const [guidanceScale, setGuidanceScale] = useState<string>('7.5');

  // Images for text_reference (multiple allowed)
  const [referenceFiles, setReferenceFiles] = useState<File[]>([]);
  const [referencePreviews, setReferencePreviews] = useState<string[]>([]);
  const [libraryMediaIds, setLibraryMediaIds] = useState<string[]>([]);
  const [uploadedMediaIds, setUploadedMediaIds] = useState<string[]>([]);
  const [uploadingImage, setUploadingImage] = useState(false);

  // Images for start_end
  const [startImageFile, setStartImageFile] = useState<File | null>(null);
  const [startImagePreview, setStartImagePreview] = useState<string | null>(null);
  const [endImageFile, setEndImageFile] = useState<File | null>(null);
  const [endImagePreview, setEndImagePreview] = useState<string | null>(null);
  const [startMediaId, setStartMediaId] = useState<string | null>(null);
  const [endMediaId, setEndMediaId] = useState<string | null>(null);

  // State
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [generating, setGenerating] = useState(false);
  const [lastResult, setLastResult] = useState<GeneratedVideoResult | null>(null);
  const lastResultRef = useRef<GeneratedVideoResult | null>(null);
  useEffect(() => { lastResultRef.current = lastResult; }, [lastResult]);
  
  // Track download completion to stop polling
  const downloadCompleteRef = useRef(false);
  
  const [error, setError] = useState<string | null>(null);
  const [showLibrary, setShowLibrary] = useState(false);
  const [libraryTarget, setLibraryTarget] = useState<'start' | 'end' | 'reference'>('start');
  const pollTimerRef = useRef<number | null>(null);

  // Upscale state - reused for both manual upscale and auto-upscale flow
  const [upscaleState, setUpscaleState] = useState<{
    active: boolean;
    resolution: SelectedVideoResolution;
    sourceMediaId: string | null;
    requestIds: string[];
    mediaIds: string[];
    status: 'idle' | 'generating' | 'polling' | 'downloading' | 'done' | 'error';
    finalVideoUrl: string | null;
    error: string | null;
  }>({ active: false, resolution: 'original', sourceMediaId: null, requestIds: [], mediaIds: [], status: 'idle', finalVideoUrl: null, error: null });
  const upscalePollTimerRef = useRef<number | null>(null);

  // MARKER: identifies this build as the "stop-on-complete" version
  console.info('[FlowVideosTab] v2.0 mounted - stop-on-complete build (2026-06-19)');

  // Filter models theo feature
  const getAvailableModels = () => {
    if (feature === 'start_end') {
      return VIDEO_MODELS.filter(m => m.supportsI2v);
    }
    return VIDEO_MODELS;
  };

  const availableModels = getAvailableModels();

  // Reset model khi đổi feature
  useEffect(() => {
    const validModel = availableModels.find(m => m.id === selectedModel.id);
    if (!validModel) {
      setSelectedModel(availableModels[0]);
    }
  }, [feature, availableModels]);

  // Reset images khi đổi feature
  useEffect(() => {
    if (feature === 'text_reference') {
      // Keep referenceFiles and libraryMediaIds for text_reference
    } else {
      // Clear reference images when switching to start_end
      setReferenceFiles([]);
      setReferencePreviews([]);
      setLibraryMediaIds([]);
    }
  }, [feature]);

  // Reset duration khi đổi model
  useEffect(() => {
    if (!selectedModel.supportedDurations.includes(duration)) {
      setDuration(selectedModel.supportedDurations[selectedModel.supportedDurations.length - 1]);
    }
  }, [selectedModel]);

  // Project selection logic
  const projectGroups: Record<string, { profile: Profile; projectIdx: number }[]> = {};
  profiles.forEach((profile) => {
    const flowProjects: FlowProject[] = (profile.metadata as any)?.flowProjects || [];
    flowProjects.forEach((proj, idx) => {
      const name = proj.name || `Project ${idx + 1}`;
      if (!projectGroups[name]) projectGroups[name] = [];
      projectGroups[name].push({ profile, projectIdx: idx });
    });
  });

  const projectNames = Object.keys(projectGroups).sort();
  const selectedEntries = projectGroups[selectedProjectName] || [];
  const selectedEntry = selectedEntries[selectedProfileIdx];
  const selectedProfile = selectedEntry?.profile;
  const selectedProjectIdx = selectedEntry?.projectIdx ?? 0;
  const selectedProjectObj = selectedProfile
    ? (selectedProfile.metadata as any)?.flowProjects?.[selectedProjectIdx]
    : null;
  const tier = selectedProfile?.tier || 'PAYGATE_TIER_TWO';

  useEffect(() => {
    if (!selectedProjectName && projectNames.length > 0) {
      setSelectedProjectName(projectNames[0]);
      setSelectedProfileIdx(0);
    }
  }, [projectNames, selectedProjectName]);

  // Text & Reference handlers
  const handleReferenceFilesChange = (files: FileList | null) => {
    const next = Array.from(files || []);
    setReferenceFiles(next);
    setUploadedMediaIds([]);
    setReferencePreviews(next.map(file => {
      const reader = new FileReader();
      return ''; // placeholder
    }));

    // Create previews
    const newPreviews: string[] = [];
    next.forEach((file, i) => {
      const reader = new FileReader();
      reader.onload = () => {
        setReferencePreviews(prev => {
          const updated = [...prev];
          updated[i] = reader.result as string;
          return updated;
        });
      };
      reader.readAsDataURL(file);
    });
  };

  // Start/End handlers
  const handleImageChange = (type: 'start' | 'end') => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    if (type === 'start') {
      setStartImageFile(file);
      setStartMediaId(null);
      if (file) {
        const reader = new FileReader();
        reader.onload = () => setStartImagePreview(reader.result as string);
        reader.readAsDataURL(file);
      } else {
        setStartImagePreview(null);
      }
    } else {
      setEndImageFile(file);
      setEndMediaId(null);
      if (file) {
        const reader = new FileReader();
        reader.onload = () => setEndImagePreview(reader.result as string);
        reader.readAsDataURL(file);
      } else {
        setEndImagePreview(null);
      }
    }
  };

  const openLibrary = (target: 'start' | 'end' | 'reference') => {
    setLibraryTarget(target);
    setShowLibrary(true);
  };

  const handleSelectFromLibrary = (entity: LibraryEntity) => {
    if (entity.reference_image_url) {
      const imageUrl = entity.reference_image_url.startsWith('http')
        ? entity.reference_image_url
        : `${window.location.origin}${entity.reference_image_url}`;

      if (libraryTarget === 'start') {
        setStartImagePreview(imageUrl);
        setStartImageFile(null);
        setStartMediaId(entity.media_id || entity.id);
      } else if (libraryTarget === 'end') {
        setEndImagePreview(imageUrl);
        setEndImageFile(null);
        setEndMediaId(entity.media_id || entity.id);
      } else if (libraryTarget === 'reference') {
        setLibraryMediaIds(prev => [...prev, entity.media_id || entity.id]);
        setReferencePreviews(prev => [...prev, imageUrl]);
      }
    }
  };

  // Helper: Read file as base64
  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const base64 = result.split(',')[1] || result;
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const uploadImages = async (): Promise<string[]> => {
    if (!selectedProfile || !selectedProjectObj?.projectId) return [];

    setUploadingImage(true);
    setError(null);

    try {
      const ids: string[] = [];

      if (feature === 'start_end') {
        // Upload start image
        if (startImageFile) {
          const fileData = await fileToBase64(startImageFile);
          const res = await fetch('/api/flow/videos/upload-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              profileId: selectedProfile.id,
              projectId: selectedProjectObj.projectId,
              fileName: startImageFile.name,
              fileData,
            }),
          });
          const result = await res.json();
          if (!result.success) throw new Error(result.error || 'Upload failed');
          console.info('[Upload] Start image mediaId:', result.data.mediaId);
          ids[0] = result.data.mediaId;
        }
        // Upload end image
        if (endImageFile) {
          const fileData = await fileToBase64(endImageFile);
          const res = await fetch('/api/flow/videos/upload-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              profileId: selectedProfile.id,
              projectId: selectedProjectObj.projectId,
              fileName: endImageFile.name,
              fileData,
            }),
          });
          const result = await res.json();
          if (!result.success) throw new Error(result.error || 'Upload failed');
          console.info('[Upload] End image mediaId:', result.data.mediaId);
          ids[1] = result.data.mediaId;
        }
      } else {
        // Upload reference images
        for (const file of referenceFiles) {
          const fileData = await fileToBase64(file);
          const res = await fetch('/api/flow/videos/upload-image', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              profileId: selectedProfile.id,
              projectId: selectedProjectObj.projectId,
              fileName: file.name,
              fileData,
            }),
          });
          const result = await res.json();
          if (!result.success) throw new Error(result.error || 'Upload failed');
          console.info('[Upload] Reference image mediaId:', result.data.mediaId);
          ids.push(result.data.mediaId);
        }
      }

      const validIds = ids.filter(Boolean);
      setUploadedMediaIds(validIds);
      return validIds;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      return [];
    } finally {
      setUploadingImage(false);
    }
  };

  const ensureProfileReady = async () => {
    if (!selectedProfile) return;
    if ((selectedProfile as any).status === 'running' || !onWaitForProfileReady) return;
    try {
      await onWaitForProfileReady(selectedProfile.id, 30000);
    } catch (err) {
      console.warn('Profile may not be ready:', err);
    }
  };

  // Map model ID -> backend model label
  const getModelLabel = (modelId: string, currentMode: string): string => {
    if (modelId === 'omni_flash') {
      return 'omni flash';
    }

    const prefix = currentMode === 'i2v' ? 'image ' : currentMode === 'r2v' ? 'reference ' : '';

    const labelMap: Record<string, string> = {
      'veo_fast': `${prefix}veo 3.1 - fast`,
      'veo_quality': `${prefix}veo 3.1 - quality`,
      'veo_lite': `${prefix}veo 3.1 - lite`,
      'veo_lite_low': `${prefix}veo 3.1 - lite [lower priority]`,
    };
    return labelMap[modelId] || `${prefix}veo 3.1 - fast`;
  };

  const handleGenerate = async () => {
    if (!selectedProfile || !selectedProjectObj?.projectId) return;
    if (!prompt.trim()) {
      setError('Prompt is required');
      return;
    }

    setGenerating(true);
    setError(null);
    setLastResult(null);
    // Reset upscale state (keep resolution selection for auto-upscale after download)
    if (upscalePollTimerRef.current) {
      window.clearInterval(upscalePollTimerRef.current);
    }
    setUpscaleState(prev => ({ 
      ...prev,
      active: false, 
      sourceMediaId: null, 
      requestIds: [], 
      mediaIds: [], 
      status: 'idle', 
      finalVideoUrl: null, 
      error: null 
    }));

    try {
      await ensureProfileReady();

      // Upload images first if files are selected
      const hasFileUploads = feature === 'start_end'
        ? (startImageFile || endImageFile)
        : referenceFiles.length > 0;

      let fileMediaIds: string[] = [];
      if (hasFileUploads) {
        fileMediaIds = await uploadImages();
      }

      const sceneId = `scene-${Date.now()}`;

      // Determine API mode
      let apiMode: string;
      let resolvedModel: string;

      if (feature === 'start_end') {
        apiMode = 'start_end';
        resolvedModel = getModelLabel(selectedModel.id, 'i2v');
      } else if (referenceFiles.length > 0 || uploadedMediaIds.length > 0 || libraryMediaIds.length > 0) {
        apiMode = 'references';
        resolvedModel = getModelLabel(selectedModel.id, 'r2v');
      } else {
        apiMode = 'start_image';
        resolvedModel = getModelLabel(selectedModel.id, 't2v');
      }

      const payload: any = {
        profileId: selectedProfile.id,
        projectId: selectedProjectObj.projectId,
        sceneId,
        prompt: prompt.trim(),
        mode: apiMode,
        model: resolvedModel,
        aspectRatio,
        userPaygateTier: tier,
        duration,
        negativePrompt,
        seed: seed ? Number(seed) : undefined,
        guidanceScale: guidanceScale ? Number(guidanceScale) : undefined,
      };

      // Add media IDs based on mode
      if (feature === 'start_end') {
        // Only use uploaded mediaIds if we just uploaded (feature + files selected)
        // Otherwise use provided startMediaId/endMediaId from library
        payload.startImageMediaId = startImageFile ? fileMediaIds[0] : startMediaId;
        payload.endImageMediaId = endImageFile ? fileMediaIds[1] : endMediaId;
      } else if (referenceFiles.length > 0) {
        // Reference mode with files: use uploaded mediaIds
        payload.referenceMediaIds = fileMediaIds;
      } else if (libraryMediaIds.length > 0) {
        // Reference mode with library: use library mediaIds directly
        payload.referenceMediaIds = libraryMediaIds;
      }

      const queueItem: QueueItem = {
        requestId: sceneId,
        profileId: selectedProfile.id,
        projectId: selectedProjectObj.projectId,
        sceneId,
        status: 'processing',
        progress: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      setQueue((prev) => [queueItem, ...prev]);

      const result = await api.generateFlowVideo(payload);

      // Extract mediaIds and workflows from response
      const mediaIds = result.mediaIds || [];
      const workflows = result.workflows || [];
      const requestIds = result.requestIds || [];

      const generated: GeneratedVideoResult = {
        profileId: selectedProfile.id,
        projectId: selectedProjectObj.projectId,
        sceneId,
        mode: apiMode as any,
        aspectRatio,
        duration,
        userPaygateTier: tier,
        operations: result.operations || [],
        requestIds,
        mediaIds,
        workflows,
        rawResult: result,
      };
      setLastResult(generated);
      
      // Set queue item to processing (waiting for video to complete)
      setQueue((prev) =>
        prev.map((item) =>
          item.requestId === sceneId
            ? { ...item, status: 'processing', progress: 0 }
            : item,
        ),
      );
      
      console.info(`[Video Generate] Queued - mediaIds: ${mediaIds.length}, workflows: ${workflows.length}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Generate failed';
      setError(message);
      setQueue((prev) =>
        prev.map((item) =>
          item.status === 'processing'
            ? { ...item, status: 'failed', error: message, updatedAt: new Date().toISOString() }
            : item,
        ),
      );
    } finally {
      setGenerating(false);
    }
  };

  const handleUpscale = async (resolution: SelectedVideoResolution, sourceMediaId?: string) => {
    const sourceId = sourceMediaId || lastResult?.mediaId;
    if (!sourceId) {
      setError('Generate a video first before upscaling');
      return;
    }
    if (resolution === 'original') {
      // Just show the original video
      return;
    }

    // Clear any existing upscale poll
    if (upscalePollTimerRef.current) {
      window.clearInterval(upscalePollTimerRef.current);
    }

    setGenerating(true);
    setError(null);
    setUpscaleState({
      active: true,
      resolution,
      sourceMediaId: sourceId,
      requestIds: [],
      mediaIds: [],
      status: 'polling',
      finalVideoUrl: null,
      error: null,
    });

    try {
      await ensureProfileReady();
      const result = await api.upscaleFlowVideo({
        profileId: lastResult!.profileId,
        projectId: lastResult!.projectId,
        sceneId: lastResult!.sceneId,
        mediaId: sourceId,
        aspectRatio,
        resolution: resolution as VideoUpscaleResolution,
      });

      const newRequestIds = result.requestIds || [];
      const newMediaIds = result.mediaIds || [];

      console.info('[Upscale] Started - resolution:', resolution, 'requestIds:', newRequestIds, 'mediaIds:', newMediaIds);

      setUpscaleState(prev => ({
        ...prev,
        requestIds: newRequestIds,
        mediaIds: newMediaIds,
        status: newRequestIds.length > 0 || newMediaIds.length > 0 ? 'polling' : 'error',
      }));

      // Start polling for upscale completion
      if (newRequestIds.length > 0 || newMediaIds.length > 0) {
        startUpscalePolling(resolution, newRequestIds, newMediaIds);
      } else {
        setUpscaleState(prev => ({ ...prev, status: 'error', error: 'No operations returned from upscale API' }));
      }
    } catch (err) {
      console.error('[Upscale] Error:', err);
      setUpscaleState(prev => ({ ...prev, status: 'error', error: err instanceof Error ? err.message : 'Upscale failed' }));
    } finally {
      setGenerating(false);
    }
  };

  // Polling for video completion
  useEffect(() => {
    // === If videoUrl is already set, we don't need to poll anymore. ===
    if (lastResult?.videoUrl) {
      console.info('[Video Poll] useEffect: videoUrl already set, no polling needed');
      return;
    }

    console.info('[Video Poll] useEffect triggered. lastResult:', {
      profileId: lastResult?.profileId,
      sceneId: lastResult?.sceneId,
      requestIds: lastResult?.requestIds,
      mediaIds: lastResult?.mediaIds,
      mediaIdsLength: lastResult?.mediaIds?.length,
    });
    // Check if there's something to poll (operations or mediaIds)
    const requestIds = lastResult?.requestIds || [];
    const mediaIds = lastResult?.mediaIds || [];
    const hasOperations = requestIds.length > 0;
    const hasMediaIds = mediaIds.length > 0;

    if (!hasOperations && !hasMediaIds) {
      console.info('[Video Poll] useEffect: no requestIds or mediaIds, skipping');
      return;
    }
    if (!onOpenProfile) {
      console.info('[Video Poll] useEffect: no onOpenProfile, skipping');
      return;
    }

    const timer = window.setInterval(async () => {
      try {
        // === STOP POLLING if download is complete ===
        if (downloadCompleteRef.current) {
          console.info('[Video Poll] Download complete ref set, stopping poll');
          window.clearInterval(timer);
          return;
        }
        
        // === STOP POLLING if we already have a videoUrl for the current mediaId ===
        const currentRef = lastResultRef.current;
        if (currentRef?.completedVideos?.length && currentRef.completedVideos[0].videoUrl) {
          console.info('[Video Poll] Already have videoUrl in ref, stopping poll');
          window.clearInterval(timer);
          return;
        }

        // === STOP POLLING if we just set videoUrl (download complete) ===
        if (currentRef?.videoUrl) {
          console.info('[Video Poll] videoUrl set in ref, stopping poll');
          window.clearInterval(timer);
          return;
        }

        const status = await api.checkVideoStatus({
          profileId: lastResult!.profileId,
          projectId: lastResult!.projectId,
          operations: requestIds,
          mediaIds: mediaIds,
        });
        
        if (!status || !status.isComplete) {
          console.warn('[Video Poll] API call failed or returned incomplete status:', status);
          window.clearInterval(timer);
          return;
        }

        console.info('[Video Poll] Raw API response:', JSON.stringify(status).substring(0, 1000));

        // Destructure from status directly (api.request already unwraps {success, data} → returns data)
        const statusData = (status || {}) as {
          completedVideos?: CompletedVideo[];
          isComplete?: boolean;
          media?: any[];
          hasActiveMedia?: boolean;
          hasSuccessfulMedia?: boolean;
          shouldStopPolling?: boolean;
          autoDownloadResult?: any;
        };
        const { 
          completedVideos = [], 
          isComplete = false, 
          media = [], 
          hasActiveMedia = false, 
          hasSuccessfulMedia = false,
          shouldStopPolling = false,
          autoDownloadResult,
        } = statusData;
        console.info('[Video Poll] Status response:', {
          isComplete,
          hasSuccessfulMedia,
          hasActiveMedia,
          completedVideosCount: completedVideos?.length,
          completedVideosFirst: completedVideos?.[0],
          mediaIdsCount: mediaIds?.length,
          mediaIdsFirst: mediaIds?.[0],
          shouldStopPolling,
          statusDataKeys: Object.keys(statusData),
        });
        
        // Update queue progress
        if (media?.length) {
          const total = media.length;
          // Estimate progress based on completed videos
          const progress = isComplete ? 100 : Math.min(95, Math.round((completedVideos?.length || 0) / total * 100));
          
          setQueue((prev) =>
            prev.map((item) =>
              item.requestId === lastResult!.sceneId
                ? { ...item, progress, status: isComplete ? 'completed' : 'processing' }
                : item,
            ),
          );
        }
        
        // Check if media has SUCCESSFUL status and needs download
        // Use mediaIds from lastResult as the source of truth (backend returns this on generate)
        const mediaIdFromStatus = mediaIds?.[0] || completedVideos?.[0]?.mediaId;

        console.info('[Video Poll] Decision check:', {
          isComplete,
          hasSuccessfulMedia,
          mediaIdFromStatus,
          completedVideosFirstMediaId: completedVideos?.[0]?.mediaId,
          mediaIdsFirst: mediaIds?.[0],
          mediaCount: media?.length,
        });

        if (isComplete && mediaIdFromStatus) {
          console.info('[Video Poll] SUCCESSFUL! mediaId=', mediaIdFromStatus, 'isComplete=', isComplete, 'hasSuccessfulMedia=', hasSuccessfulMedia);
          window.clearInterval(timer);

          try {
            // Retry download 3 times with 2s delay between attempts
            let videoUrl: string | null = null;
            for (let attempt = 1; attempt <= 3; attempt++) {
              console.info('[Video Poll] Download attempt', attempt, '/ 3 for mediaId:', mediaIdFromStatus);
              const downloadResult = await fetch(`/api/flow/videos/download?profileId=${lastResult?.profileId}&mediaId=${mediaIdFromStatus}`);
              const downloadData = await downloadResult.json();
              console.info('[Video Poll] Download response:', JSON.stringify(downloadData).substring(0, 500));

              if (downloadData.success && downloadData.data) {
                const encodedVideo = downloadData.data.encodedVideo;
                const directUrl = downloadData.data.videoUrl;
                const alreadySaved = downloadData.data.alreadySaved;
                const savedPath = downloadData.data.savedPath;

                if (encodedVideo) {
                  console.info('[Video Poll] Got encodedVideo (attempt', attempt, '), converting to blob URL...');
                  console.info('[Video Poll] Server saved to:', downloadData.data.savedPath);
                  const blob = await fetch(`data:video/mp4;base64,${encodedVideo}`).then(r => r.blob());
                  videoUrl = URL.createObjectURL(blob);
                  break;
                } else if (directUrl) {
                  videoUrl = directUrl;
                  break;
                } else if (alreadySaved && savedPath) {
                  // Backend already saved the file - fetch it directly
                  console.info('[Video Poll] Video already saved by backend, fetching from:', savedPath);
                  const fileResponse = await fetch(`/api/flow/videos/file?mediaId=${mediaIdFromStatus}`);
                  if (fileResponse.ok) {
                    const blob = await fileResponse.blob();
                    videoUrl = URL.createObjectURL(blob);
                    console.info('[Video Poll] Loaded saved video from backend, size:', blob.size);
                    break;
                  }
                }
              }

              if (attempt < 3) {
                console.info('[Video Poll] Attempt', attempt, 'no data, waiting 2s before retry...');
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }

            if (videoUrl) {
              console.info('[Video Poll] Video ready! URL length:', videoUrl.length);
              
              // Set ref FIRST to stop polling on next tick
              downloadCompleteRef.current = true;
              
              // Update state
              setLastResult((prev) => (prev ? {
                ...prev,
                completedVideos: [{ mediaId: mediaIdFromStatus, videoUrl, status: 'SUCCESSFUL' }],
                videoUrl,
                media: media || [],
                operations: status.operations || [],
              } : prev));

              setQueue((prev) =>
                prev.map((item) =>
                  item.requestId === lastResult!.sceneId
                    ? { ...item, status: 'completed', progress: 100 }
                    : item,
                ),
              );

              console.info('[Video Poll] Done! Download complete, stopping polling.');

              // === AUTO-UPSCALE: Trigger immediately after download ===
              const currentResolution = upscaleState.resolution;
              // Use mediaIdFromStatus (which is the actual mediaId from the status response)
              const upscaleMediaId = mediaIdFromStatus;
              console.info('[Video Poll] Auto-upscale check:', {
                resolution: currentResolution,
                upscaleMediaId,
                upscaleActive: upscaleState.active,
                lastResultProfileId: lastResult?.profileId,
                lastResultProjectId: lastResult?.projectId,
              });
              if (currentResolution !== 'original' && upscaleMediaId && !upscaleState.active) {
                console.info('[Video Poll] Triggering auto-upscale to', currentResolution, 'for mediaId:', upscaleMediaId);
                // Call handleUpscale directly (it's async but we don't need to await)
                handleUpscale(currentResolution, upscaleMediaId);
              }
              
              // Stop polling
              window.clearInterval(timer);
              return;
            } else {
              console.warn('[Video Poll] Download failed after 3 attempts. Will retry on next poll.');
              // Don't stop polling - will retry on next interval
            }
          } catch (downloadErr) {
            console.warn('[Video Poll] Download error:', downloadErr);
          }
          return; // Stop this poll iteration
        }

        // Keep polling if not yet complete
        console.info('[Video Poll] Still processing... isComplete=', isComplete, 'hasSuccessfulMedia=', hasSuccessfulMedia, 'active=', hasActiveMedia);
      } catch (err) {
        console.warn('[Video Poll] Error:', err);
      }
    }, 5000);
    
    return () => window.clearInterval(timer);
  }, [lastResult?.videoUrl, lastResult?.requestIds?.length, lastResult?.mediaIds?.length, lastResult?.profileId, lastResult?.sceneId, onOpenProfile, upscaleState.resolution]);

  // Upscale polling - separate from main video polling
  const startUpscalePolling = (resolution: VideoUpscaleResolution, requestIds: string[], mediaIds: string[]) => {
    if (upscalePollTimerRef.current) {
      window.clearInterval(upscalePollTimerRef.current);
    }

    console.info('[Upscale Poll] Starting - resolution:', resolution, 'requestIds:', requestIds, 'mediaIds:', mediaIds);

    upscalePollTimerRef.current = window.setInterval(async () => {
      try {
        // Check if we already have the upscaled video URL
        if (upscaleState.finalVideoUrl) {
          console.info('[Upscale Poll] Already have upscaled video URL, stopping');
          window.clearInterval(upscalePollTimerRef.current!);
          return;
        }

        const status = await api.checkVideoStatus({
          profileId: lastResult!.profileId,
          projectId: lastResult!.projectId,
          operations: requestIds,
          mediaIds: mediaIds,
        });

        if (!status || !status.isComplete) {
          console.warn('[Upscale Poll] Status check failed:', status);
          window.clearInterval(upscalePollTimerRef.current!);
          return;
        }

        console.info('[Upscale Poll] Status response:', {
          isComplete: status.isComplete,
          completedVideos: status.completedVideos?.length,
        });

        const { isComplete, completedVideos } = status;

        if (isComplete && completedVideos?.length) {
          window.clearInterval(upscalePollTimerRef.current!);
          console.info('[Upscale Poll] COMPLETE! Downloading upscaled video...');

          setUpscaleState(prev => ({ ...prev, status: 'downloading' }));

          // Download the upscaled video
          const upscaledMediaId = completedVideos[0].mediaId || mediaIds[0];
          let upscaledVideoUrl: string | null = null;

          // Try up to 3 times
          for (let attempt = 1; attempt <= 3; attempt++) {
            console.info('[Upscale Poll] Download attempt', attempt, '/ 3 for mediaId:', upscaledMediaId);

            const downloadResult = await fetch(`/api/flow/videos/download?profileId=${lastResult?.profileId}&mediaId=${upscaledMediaId}`);
            const downloadData = await downloadResult.json();

            if (downloadData.success && downloadData.data) {
              const encodedVideo = downloadData.data.encodedVideo;
              const directUrl = downloadData.data.videoUrl;

              if (encodedVideo) {
                const blob = await fetch(`data:video/mp4;base64,${encodedVideo}`).then(r => r.blob());
                upscaledVideoUrl = URL.createObjectURL(blob);
                console.info('[Upscale Poll] Downloaded upscaled video, size:', blob.size);
                break;
              } else if (directUrl) {
                upscaledVideoUrl = directUrl;
                break;
              }
            }

            if (attempt < 3) {
              await new Promise(resolve => setTimeout(resolve, 2000));
            }
          }

          if (upscaledVideoUrl) {
            console.info('[Upscale Poll] Done! Setting as main video result');
            // Set as main video result
            setLastResult(prev => prev ? {
              ...prev,
              videoUrl: upscaledVideoUrl,
              completedVideos: [{ mediaId: upscaledMediaId, videoUrl: upscaledVideoUrl, status: 'SUCCESSFUL' }],
            } : prev);
            setUpscaleState(prev => ({
              ...prev,
              status: 'done',
              finalVideoUrl: upscaledVideoUrl,
            }));
          } else {
            setUpscaleState(prev => ({ ...prev, status: 'error', error: 'Failed to download upscaled video after 3 attempts' }));
          }
          return;
        }

        console.info('[Upscale Poll] Still processing... isComplete:', isComplete);
      } catch (err) {
        console.warn('[Upscale Poll] Error:', err);
      }
    }, 5000);
  };

  // Determine current mode for display
  const getCurrentModeLabel = () => {
    if (feature === 'start_end') {
      return { icon: '🎬', label: 'Start to End', desc: 'Generate video from start to end image' };
    }
    if (referenceFiles.length > 0 || uploadedMediaIds.length > 0) {
      return { icon: '🖼️', label: 'Reference', desc: 'Use reference image(s) for video' };
    }
    return { icon: '📝', label: 'Text', desc: 'Generate from prompt only' };
  };

  const currentMode = getCurrentModeLabel();

  return (
    <div className="flow-videos-tab">
      <div className="flow-videos-grid">
        {/* Left Column */}
        <div className="flow-videos-left">
          {/* Project Selection */}
          <div className="profile-card">
            <div className="profile-header">
              <div className="profile-title">
                <div className="profile-avatar">🎬</div>
                <div>
                  <div className="profile-name">Flow Project</div>
                  <div className="profile-id">Select project to use</div>
                </div>
              </div>
            </div>
            <div className="profile-content">
              <select
                className="form-input"
                value={selectedProjectName}
                onChange={(e) => {
                  setSelectedProjectName(e.target.value);
                  setSelectedProfileIdx(0);
                }}
              >
                {projectNames.map((name) => (
                  <option key={name} value={name}>{name}</option>
                ))}
              </select>
              {selectedEntries.length > 1 && (
                <select
                  className="form-input"
                  value={selectedProfileIdx}
                  onChange={(e) => setSelectedProfileIdx(Number(e.target.value))}
                >
                  {selectedEntries.map((entry, idx) => (
                    <option key={idx} value={idx}>
                      {entry.profile.name}
                    </option>
                  ))}
                </select>
              )}
              <div className="project-info">
                <span className="project-tier">Tier: {tier}</span>
              </div>
            </div>
          </div>

          {/* Feature Selection */}
          <div className="profile-card">
            <div className="profile-header">
              <div className="profile-title">
                <div className="profile-avatar">🎯</div>
                <div>
                  <div className="profile-name">Feature</div>
                </div>
              </div>
            </div>
            <div className="feature-selector">
              <button
                className={`feature-btn ${feature === 'text_reference' ? 'active' : ''}`}
                onClick={() => setFeature('text_reference')}
              >
                <span className="feature-icon">📝🖼️</span>
                <span className="feature-name">Text & Reference</span>
                <span className="feature-desc">0 = Text, 1+ = Reference</span>
              </button>
              <button
                className={`feature-btn ${feature === 'start_end' ? 'active' : ''}`}
                onClick={() => setFeature('start_end')}
              >
                <span className="feature-icon">🎬</span>
                <span className="feature-name">Start to End</span>
                <span className="feature-desc">Start + End images</span>
              </button>
            </div>
          </div>

          {/* Current Mode Indicator */}
          <div className={`mode-indicator mode-${feature}`}>
            <span className="mode-icon">{currentMode.icon}</span>
            <div className="mode-info">
              <span className="mode-label">{currentMode.label}</span>
              <span className="mode-desc">{currentMode.desc}</span>
            </div>
          </div>

          {/* Model Selection */}
          <div className="profile-card">
            <div className="profile-header">
              <div className="profile-title">
                <div className="profile-avatar">🤖</div>
                <div>
                  <div className="profile-name">Model</div>
                </div>
              </div>
            </div>
            <div className="model-grid">
              {availableModels.map((model) => (
                <button
                  key={model.id}
                  className={`model-btn ${selectedModel.id === model.id ? 'active' : ''}`}
                  onClick={() => setSelectedModel(model)}
                  title={model.description}
                >
                  <span className="model-icon">{model.icon}</span>
                  <span className="model-name">{model.name}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Settings */}
          <div className="profile-card">
            <div className="profile-header">
              <div className="profile-title">
                <div className="profile-avatar">⚙️</div>
                <div>
                  <div className="profile-name">Settings</div>
                </div>
              </div>
            </div>
            <div className="profile-content settings-content">
              {/* Duration */}
              <div className="form-group">
                <label className="form-label">Duration</label>
                <div className="duration-btns">
                  {selectedModel.supportedDurations.map((d) => (
                    <button
                      key={d}
                      className={`duration-btn ${duration === d ? 'active' : ''}`}
                      onClick={() => setDuration(d)}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>

              {/* Aspect Ratio */}
              {selectedModel.supportsAspectRatio && (
                <div className="form-group">
                  <label className="form-label">Aspect Ratio</label>
                  <select
                    className="form-input"
                    value={aspectRatio}
                    onChange={(e) => setAspectRatio(e.target.value as VideoAspectRatio)}
                  >
                    {ASPECT_RATIOS.map((item) => (
                      <option key={item.value} value={item.value}>{item.label}</option>
                    ))}
                  </select>
                </div>
              )}

              {/* Output Resolution */}
              <div className="form-group">
                <label className="form-label">Output Resolution</label>
                <div className="resolution-btns">
                  <button
                    className={`resolution-btn ${upscaleState.resolution === 'original' ? 'active' : ''}`}
                    onClick={() => setUpscaleState(prev => ({ ...prev, resolution: 'original' }))}
                  >
                    📹 Original
                  </button>
                  <button
                    className={`resolution-btn ${upscaleState.resolution === 'VIDEO_RESOLUTION_1080P' ? 'active' : ''}`}
                    onClick={() => setUpscaleState(prev => ({ ...prev, resolution: 'VIDEO_RESOLUTION_1080P' }))}
                  >
                    📺 1080p
                  </button>
                  <button
                    className={`resolution-btn ${upscaleState.resolution === 'VIDEO_RESOLUTION_4K' ? 'active' : ''}`}
                    onClick={() => setUpscaleState(prev => ({ ...prev, resolution: 'VIDEO_RESOLUTION_4K' }))}
                  >
                    🖥️ 4K
                  </button>
                </div>
                {upscaleState.resolution !== 'original' && (
                  <div className="resolution-hint">
                    Will auto-generate + upscale to {upscaleState.resolution === 'VIDEO_RESOLUTION_1080P' ? '1080p' : '4K'}
                  </div>
                )}
              </div>

              {/* START END MODE: Two images */}
              {feature === 'start_end' && (
                <div className="images-section start-end-mode">
                  <div className="form-group">
                    <label className="form-label">Start Image *</label>
                    <div className="image-row">
                      <input
                        type="file"
                        accept="image/*"
                        className="form-input"
                        onChange={handleImageChange('start')}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => openLibrary('start')}
                      >
                        📚
                      </button>
                    </div>
                    {startImagePreview && (
                      <div className="image-preview">
                        <img src={startImagePreview} alt="Start" />
                        <span className="image-label">START</span>
                      </div>
                    )}
                  </div>

                  <div className="form-group">
                    <label className="form-label">End Image *</label>
                    <div className="image-row">
                      <input
                        type="file"
                        accept="image/*"
                        className="form-input"
                        onChange={handleImageChange('end')}
                      />
                      <button
                        type="button"
                        className="btn btn-secondary"
                        onClick={() => openLibrary('end')}
                      >
                        📚
                      </button>
                    </div>
                    {endImagePreview && (
                      <div className="image-preview">
                        <img src={endImagePreview} alt="End" />
                        <span className="image-label">END</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* TEXT & REFERENCE MODE: Multiple images */}
              {feature === 'text_reference' && (
                <div className="form-group">
                  <label className="form-label">
                    Reference Image {referenceFiles.length === 0 && <span className="optional-tag">Optional</span>}
                  </label>
                  <div className="image-row">
                    <input
                      type="file"
                      accept="image/*"
                      className="form-input"
                      onChange={(e) => handleReferenceFilesChange(e.target.files)}
                    />
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={() => openLibrary('reference')}
                    >
                      📚
                    </button>
                    {(referenceFiles.length > 0 || libraryMediaIds.length > 0) && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-danger"
                        onClick={() => {
                          setReferenceFiles([]);
                          setReferencePreviews([]);
                          setLibraryMediaIds([]);
                        }}
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                  {referencePreviews.length > 0 && (
                    <div className="reference-previews">
                      {referencePreviews.map((preview, i) => preview && (
                        <div key={i} className="reference-thumb">
                          <img src={preview} alt={`Ref ${i + 1}`} />
                          <button
                            type="button"
                            className="ref-remove-btn"
                            onClick={() => {
                              setReferencePreviews(prev => prev.filter((_, idx) => idx !== i));
                              if (i < referenceFiles.length) {
                                setReferenceFiles(prev => prev.filter((_, idx) => idx !== i));
                              } else {
                                setLibraryMediaIds(prev => prev.filter((_, idx) => idx !== (i - referenceFiles.length)));
                              }
                            }}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Prompt */}
              <div className="form-group">
                <label className="form-label">Prompt</label>
                <textarea
                  className="form-input"
                  rows={4}
                  placeholder="Describe the video scene..."
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
              </div>

              {/* Advanced */}
              <details className="advanced-settings">
                <summary>Advanced Options</summary>
                <div className="form-group">
                  <label className="form-label">Negative Prompt</label>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="What to avoid..."
                    value={negativePrompt}
                    onChange={(e) => setNegativePrompt(e.target.value)}
                  />
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Seed</label>
                    <input
                      type="number"
                      className="form-input"
                      placeholder="Random"
                      value={seed}
                      onChange={(e) => setSeed(e.target.value)}
                    />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Guidance Scale</label>
                    <input
                      type="number"
                      className="form-input"
                      placeholder="7.5"
                      value={guidanceScale}
                      onChange={(e) => setGuidanceScale(e.target.value)}
                    />
                  </div>
                </div>
              </details>
            </div>
          </div>

          {/* Generate Button */}
          <button
            className="btn btn-primary btn-generate"
            onClick={handleGenerate}
            disabled={
              generating ||
              uploadingImage ||
              !selectedProfile ||
              !selectedProjectObj?.projectId ||
              !prompt.trim() ||
              (feature === 'start_end' && !startImagePreview && !startMediaId && !endImagePreview && !endMediaId)
            }
          >
            {generating ? '⏳ Generating...' : `🎬 Generate ${currentMode.label} Video`}
          </button>

          {error && (
            <div className="error-message">
              ⚠️ {error}
            </div>
          )}
        </div>

        {/* Right Column */}
        <div className="flow-videos-right">
          {/* Model Info */}
          <div className="model-info-card">
            <div className="model-info-header">
              <span className="model-info-icon">{selectedModel.icon}</span>
              <span className="model-info-name">{selectedModel.name}</span>
            </div>
            <div className="model-info-details">
              <div className="model-info-row">
                <span>Duration:</span>
                <span>{selectedModel.supportedDurations.join(', ')}</span>
              </div>
              <div className="model-info-row">
                <span>Aspect:</span>
                <span>{selectedModel.supportsAspectRatio ? '16:9 / 9:16' : 'Auto'}</span>
              </div>
            </div>
          </div>

          {/* Result */}
          {lastResult && (
            <div className="profile-card result-card">
              <div className="profile-header">
                <div className="profile-title">
                  <div className="profile-avatar">✅</div>
                  <div>
                    <div className="profile-name">Video Generated</div>
                    <div className="profile-id">Scene: {lastResult.sceneId}</div>
                  </div>
                </div>
              </div>
              <div className="profile-content">
                <div className="result-info">
                  <div><strong>Mode:</strong> {lastResult.mode}</div>
                  <div><strong>Request IDs:</strong> {(lastResult.requestIds || []).slice(0, 3).join(', ')}</div>
                </div>
                
                {/* Video Player - Show when videoUrl is available */}
                {lastResult.videoUrl && (
                  <div className="video-player-container">
                    <video 
                      key={lastResult.videoUrl}
                      controls 
                      autoPlay 
                      src={lastResult.videoUrl}
                      style={{ 
                        width: '100%', 
                        maxHeight: '400px',
                        borderRadius: '8px',
                        backgroundColor: '#000'
                      }}
                    />
                    <div className="video-url-info">
                      <small>Video ready! URL: {lastResult.videoUrl.substring(0, 50)}...</small>
                    </div>
                  </div>
                )}
                
                {/* Upscaled Video Player - Show when upscale is complete */}
                {upscaleState.finalVideoUrl && upscaleState.resolution !== 'original' && (
                  <div className="upscale-result-container">
                    <div className="upscale-result-header">
                      <span className="upscale-badge">✨ {upscaleState.resolution === 'VIDEO_RESOLUTION_1080P' ? '1080p' : '4K'} Upscale</span>
                    </div>
                    <video
                      key={upscaleState.finalVideoUrl}
                      controls
                      autoPlay
                      src={upscaleState.finalVideoUrl}
                      style={{
                        width: '100%',
                        maxHeight: '400px',
                        borderRadius: '8px',
                        backgroundColor: '#000'
                      }}
                    />
                    <div className="video-url-info">
                      <small>Upscaled video ready!</small>
                    </div>
                  </div>
                )}

                {/* Upscale Progress */}
                {upscaleState.active && upscaleState.status === 'polling' && (
                  <div className="upscale-progress">
                    <div className="loading-spinner" />
                    <span>✨ Upscaling to {upscaleState.resolution === 'VIDEO_RESOLUTION_1080P' ? '1080p' : '4K'}...</span>
                    <span className="upscale-hint">This may take a few minutes</span>
                  </div>
                )}

                {/* Upscale Downloading */}
                {upscaleState.active && upscaleState.status === 'downloading' && (
                  <div className="upscale-progress">
                    <div className="loading-spinner" />
                    <span>✨ Downloading upscaled video...</span>
                  </div>
                )}

                {/* Upscale Done - Show confirmation */}
                {upscaleState.status === 'done' && upscaleState.finalVideoUrl && (
                  <div className="upscale-done">
                    <span>✨ Upscale complete!</span>
                    <span className="upscale-hint">Video ready at {upscaleState.resolution === 'VIDEO_RESOLUTION_1080P' ? '1080p' : '4K'}</span>
                  </div>
                )}

                {/* Upscale Error */}
                {upscaleState.error && (
                  <div className="error-message">
                    {upscaleState.error}
                  </div>
                )}

                {/* Reset button after upscale done */}
                {upscaleState.status === 'done' && (
                  <button
                    className="btn btn-secondary"
                    onClick={() => setUpscaleState({ active: false, resolution: 'original', sourceMediaId: null, requestIds: [], mediaIds: [], status: 'idle', finalVideoUrl: null, error: null })}
                    style={{ marginTop: '8px' }}
                  >
                    🔄 New Video
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Queue */}
          <div className="profile-card">
            <div className="profile-header">
              <div className="profile-title">
                <div className="profile-avatar">📋</div>
                <div>
                  <div className="profile-name">Queue</div>
                  <div className="profile-id">{queue.length} request(s)</div>
                </div>
              </div>
            </div>
            <div className="queue-list">
              {queue.length === 0 ? (
                <div className="queue-empty">No requests yet</div>
              ) : (
                queue.map((item) => (
                  <div key={item.requestId} className={`queue-item ${item.status}`}>
                    <div className="queue-item-header">
                      <span className="queue-status">
                        {item.status === 'completed' ? '✅' :
                          item.status === 'failed' ? '❌' :
                            item.status === 'processing' ? '⏳' : '⏸️'}
                      </span>
                      <span className="queue-scene">{item.sceneId.slice(0, 12)}...</span>
                    </div>
                    {item.error && (
                      <div className="queue-error">{item.error}</div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>

      <LibraryModal
        isOpen={showLibrary}
        onClose={() => setShowLibrary(false)}
        onSelect={handleSelectFromLibrary}
        projectId={selectedProjectObj?.projectId}
      />

      <style>{`
        .flow-videos-tab {
          padding: 20px;
          height: 100%;
          overflow-y: auto;
          background: #0f0f1a;
        }

        .flow-videos-grid {
          display: grid;
          grid-template-columns: 400px 1fr;
          gap: 20px;
          max-width: 1400px;
          margin: 0 auto;
        }

        .flow-videos-left,
        .flow-videos-right {
          display: flex;
          flex-direction: column;
          gap: 16px;
        }

        .profile-card {
          background: #1a1a2e;
          border-radius: 12px;
          overflow: hidden;
          border: 1px solid #333355;
        }

        .profile-header {
          padding: 12px 16px;
          border-bottom: 1px solid #333355;
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: #16162a;
        }

        .profile-title {
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .profile-avatar {
          width: 40px;
          height: 40px;
          background: linear-gradient(135deg, #667eea, #764ba2);
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 1.2rem;
        }

        .profile-name {
          font-weight: 600;
          font-size: 0.95rem;
          color: #ffffff;
        }

        .profile-id {
          font-size: 0.8rem;
          color: #a0a0b0;
        }

        .profile-content {
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        /* Feature Selector */
        .feature-selector {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          padding: 12px;
        }

        .feature-btn {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          padding: 16px 12px;
          border: 2px solid #333355;
          background: #1e1e3f;
          border-radius: 10px;
          cursor: pointer;
          transition: all 0.2s;
          text-align: center;
          color: #ffffff;
        }

        .feature-btn:hover {
          background: #2a2a4a;
          border-color: #667eea;
        }

        .feature-btn.active {
          border-color: #667eea;
          background: linear-gradient(135deg, rgba(102, 126, 234, 0.3), rgba(118, 75, 162, 0.3));
          box-shadow: 0 0 15px rgba(102, 126, 234, 0.3);
        }

        .feature-icon {
          font-size: 1.5rem;
        }

        .feature-name {
          font-weight: 600;
          font-size: 0.85rem;
          color: #ffffff;
        }

        .feature-desc {
          font-size: 0.7rem;
          color: #a0a0b0;
        }

        /* Mode Indicator */
        .mode-indicator {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          border-radius: 10px;
          background: #0f0f1a;
        }

        .mode-indicator.mode-text_reference {
          background: linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(139, 92, 246, 0.1));
          border: 1px solid rgba(99, 102, 241, 0.3);
        }

        .mode-indicator.mode-start_end {
          background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(217, 119, 6, 0.1));
          border: 1px solid rgba(245, 158, 11, 0.3);
        }

        .mode-icon {
          font-size: 1.5rem;
        }

        .mode-info {
          display: flex;
          flex-direction: column;
        }

        .mode-label {
          font-weight: 600;
          font-size: 0.9rem;
        }

        .mode-desc {
          font-size: 0.75rem;
          color: #a0a0b0;
        }

        /* Mode Indicator */
        .mode-indicator {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 12px 16px;
          border-radius: 10px;
          background: linear-gradient(135deg, #1a1a2e, #16213e);
          border: 1px solid #333355;
        }

        .mode-indicator.mode-text_reference {
          background: linear-gradient(135deg, rgba(102, 126, 234, 0.2), rgba(118, 75, 162, 0.15));
          border-color: rgba(102, 126, 234, 0.4);
        }

        .mode-indicator.mode-start_end {
          background: linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(217, 119, 6, 0.15));
          border-color: rgba(245, 158, 11, 0.4);
        }

        .mode-icon {
          font-size: 1.5rem;
        }

        .mode-info {
          display: flex;
          flex-direction: column;
        }

        .mode-label {
          font-weight: 600;
          font-size: 0.9rem;
          color: #ffffff;
        }

        .mode-desc {
          font-size: 0.75rem;
          color: #a0a0b0;
        }

        /* Model Grid */
        .model-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 8px;
          padding: 12px;
        }

        .model-btn {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          padding: 14px 10px;
          border: 2px solid #333355;
          background: #1e1e3f;
          border-radius: 10px;
          cursor: pointer;
          transition: all 0.2s;
          text-align: center;
          color: #ffffff;
        }

        .model-btn:hover {
          background: #2a2a4a;
          border-color: #667eea;
        }

        .model-btn.active {
          border-color: #667eea;
          background: linear-gradient(135deg, rgba(102, 126, 234, 0.3), rgba(118, 75, 162, 0.3));
          box-shadow: 0 0 15px rgba(102, 126, 234, 0.3);
        }

        .model-icon {
          font-size: 1.5rem;
        }

        .model-name {
          font-size: 0.75rem;
          font-weight: 500;
          line-height: 1.2;
          color: #ffffff;
        }

        /* Duration Buttons */
        .duration-btns {
          display: flex;
          gap: 6px;
        }

        .duration-btn {
          flex: 1;
          padding: 10px;
          border: 2px solid #333355;
          background: #1e1e3f;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 500;
          transition: all 0.2s;
          color: #ffffff;
        }

        .duration-btn:hover {
          background: #2a2a4a;
          border-color: #667eea;
        }

        .duration-btn.active {
          border-color: #667eea;
          background: linear-gradient(135deg, rgba(102, 126, 234, 0.3), rgba(118, 75, 162, 0.3));
          color: #ffffff;
          box-shadow: 0 0 10px rgba(102, 126, 234, 0.3);
        }

        /* Resolution Buttons */
        .resolution-btns {
          display: flex;
          gap: 6px;
        }

        .resolution-btn {
          flex: 1;
          padding: 8px 6px;
          border: 2px solid #333355;
          background: #1e1e3f;
          border-radius: 8px;
          cursor: pointer;
          font-weight: 500;
          font-size: 0.85rem;
          transition: all 0.2s;
          color: #a0a0c0;
        }

        .resolution-btn:hover {
          background: #2a2a4a;
          border-color: #667eea;
          color: #ffffff;
        }

        .resolution-btn.active {
          border-color: #22c55e;
          background: linear-gradient(135deg, rgba(34, 197, 94, 0.3), rgba(34, 197, 94, 0.1));
          color: #ffffff;
          box-shadow: 0 0 10px rgba(34, 197, 94, 0.3);
        }

        .resolution-hint {
          font-size: 0.75rem;
          color: #22c55e;
          margin-top: 4px;
        }

        /* Images Section */
        .images-section {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .images-section.start-end-mode {
          background: rgba(245, 158, 11, 0.08);
          padding: 12px;
          border-radius: 8px;
          border: 1px solid rgba(245, 158, 11, 0.3);
        }

        .image-row {
          display: flex;
          gap: 8px;
        }

        .image-row input {
          flex: 1;
        }

        .image-preview {
          position: relative;
          margin-top: 10px;
          border-radius: 10px;
          overflow: hidden;
          background: #1e1e3f;
          border: 1px solid #333355;
        }

        .image-preview img {
          width: 100%;
          max-height: 100px;
          object-fit: contain;
        }

        .image-label {
          position: absolute;
          bottom: 6px;
          left: 6px;
          background: rgba(0, 0, 0, 0.8);
          color: white;
          padding: 3px 8px;
          border-radius: 4px;
          font-size: 0.7rem;
          font-weight: 600;
        }

        /* Reference Previews */
        .reference-previews {
          display: flex;
          gap: 8px;
          margin-top: 10px;
          flex-wrap: wrap;
        }

        .reference-thumb {
          position: relative;
          width: 60px;
          height: 60px;
          border-radius: 8px;
          overflow: hidden;
          background: #1e1e3f;
          border: 1px solid #333355;
        }

        .reference-thumb img {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }

        .ref-remove-btn {
          position: absolute;
          top: 2px;
          right: 2px;
          width: 18px;
          height: 18px;
          border-radius: 50%;
          background: rgba(239, 68, 68, 0.9);
          border: none;
          color: white;
          font-size: 10px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          opacity: 0;
          transition: opacity 0.2s;
        }

        .reference-thumb:hover .ref-remove-btn {
          opacity: 1;
        }

        .ref-remove-btn:hover {
          background: #ef4444;
        }

        .optional-tag {
          font-size: 0.7rem;
          color: #a0a0b0;
          font-weight: normal;
          margin-left: 6px;
        }

        /* Form inputs */
        .form-input {
          background: #1e1e3f;
          border: 1px solid #333355;
          color: #ffffff;
          border-radius: 8px;
          padding: 10px 12px;
          font-size: 0.9rem;
          transition: all 0.2s;
        }

        .form-input:focus {
          outline: none;
          border-color: #667eea;
          box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.2);
        }

        .form-input::placeholder {
          color: #606080;
        }

        textarea.form-input {
          resize: vertical;
          min-height: 80px;
        }

        .form-label {
          color: #ffffff;
          font-size: 0.85rem;
          font-weight: 500;
          margin-bottom: 6px;
          display: block;
        }

        select.form-input {
          cursor: pointer;
        }

        /* Advanced Settings */
        .advanced-settings {
          margin-top: 8px;
        }

        .advanced-settings summary {
          cursor: pointer;
          padding: 8px 0;
          color: #a0a0b0;
          font-size: 0.85rem;
        }

        .advanced-settings summary:hover {
          color: #667eea;
        }

        .form-row {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }

        /* Buttons */
        .btn {
          padding: 10px 16px;
          border-radius: 8px;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.2s;
          border: none;
          font-size: 0.9rem;
        }

        .btn-primary {
          background: linear-gradient(135deg, #667eea, #764ba2);
          color: white;
        }

        .btn-primary:hover:not(:disabled) {
          box-shadow: 0 4px 15px rgba(102, 126, 234, 0.4);
          transform: translateY(-1px);
        }

        .btn-primary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .btn-secondary {
          background: #1e1e3f;
          border: 1px solid #333355;
          color: #ffffff;
        }

        .btn-secondary:hover:not(:disabled) {
          background: #2a2a4a;
          border-color: #667eea;
        }

        .btn-secondary:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .btn-danger {
          background: rgba(239, 68, 68, 0.2) !important;
          border-color: rgba(239, 68, 68, 0.4) !important;
        }

        .btn-danger:hover {
          background: rgba(239, 68, 68, 0.3) !important;
          border-color: #ef4444 !important;
        }

        /* Generate Button */
        .btn-generate {
          width: 100%;
          padding: 16px;
          font-size: 1.1rem;
          border-radius: 12px;
          background: linear-gradient(135deg, #667eea, #764ba2);
          color: white;
          font-weight: 600;
        }

        .btn-generate:hover:not(:disabled) {
          box-shadow: 0 4px 20px rgba(102, 126, 234, 0.5);
          transform: translateY(-2px);
        }

        .error-message {
          padding: 12px;
          background: rgba(239, 68, 68, 0.15);
          border: 1px solid rgba(239, 68, 68, 0.4);
          border-radius: 8px;
          color: #ff6b6b;
          font-size: 0.85rem;
        }

        /* Model Info Card */
        .model-info-card {
          background: linear-gradient(135deg, rgba(102, 126, 234, 0.15), rgba(118, 75, 162, 0.1));
          border: 1px solid rgba(102, 126, 234, 0.3);
          border-radius: 12px;
          padding: 16px;
        }

        .model-info-header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 12px;
        }

        .model-info-icon {
          font-size: 1.5rem;
        }

        .model-info-name {
          font-weight: 600;
          font-size: 1.1rem;
          color: #ffffff;
        }

        .model-info-details {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }

        .model-info-row {
          display: flex;
          justify-content: space-between;
          font-size: 0.85rem;
          color: #ffffff;
        }

        .model-info-row span:first-child {
          color: #a0a0b0;
        }

        /* Result Card */
        .result-card {
          border: 1px solid #22c55e;
          background: linear-gradient(135deg, rgba(34, 197, 94, 0.1), rgba(34, 197, 94, 0.05));
        }

        .video-player-container {
          margin: 12px 0;
          border-radius: 8px;
          overflow: hidden;
          background: #000;
        }

        .video-url-info {
          padding: 8px;
          font-size: 0.75rem;
          color: #a0a0b0;
          word-break: break-all;
        }

        .video-loading-info {
          padding: 12px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          margin: 12px 0;
          text-align: center;
          color: #ffffff;
        }

        .result-info {
          font-size: 0.85rem;
          display: flex;
          flex-direction: column;
          gap: 4px;
          color: #ffffff;
        }

        .upscale-btns {
          display: flex;
          gap: 8px;
          margin-top: 12px;
          flex-wrap: wrap;
        }

        .upscale-progress {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          padding: 16px;
          background: rgba(255, 255, 255, 0.1);
          border-radius: 8px;
          margin: 12px 0;
          color: #ffffff;
        }

        .upscale-hint {
          font-size: 0.8rem;
          color: #a0a0c0;
        }

        .upscale-badge {
          display: inline-block;
          padding: 4px 12px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          border-radius: 20px;
          font-size: 0.85rem;
          font-weight: 600;
          color: #ffffff;
        }

        .upscale-done {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          padding: 12px;
          background: rgba(34, 197, 94, 0.2);
          border: 1px solid rgba(34, 197, 94, 0.4);
          border-radius: 8px;
          margin: 12px 0;
          color: #22c55e;
          font-weight: 600;
        }

        .upscale-result-container {
          margin: 12px 0;
          padding: 12px;
          background: rgba(102, 126, 234, 0.2);
          border-radius: 12px;
          border: 1px solid rgba(102, 126, 234, 0.4);
        }

        .upscale-result-header {
          margin-bottom: 8px;
        }

        .loading-spinner {
          width: 24px;
          height: 24px;
          border: 3px solid rgba(255, 255, 255, 0.3);
          border-top-color: #667eea;
          border-radius: 50%;
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        /* Queue */
        .queue-list {
          padding: 12px;
          max-height: 200px;
          overflow-y: auto;
        }

        .queue-empty {
          text-align: center;
          color: #606080;
          padding: 20px;
        }

        .queue-item {
          padding: 10px;
          border-radius: 8px;
          margin-bottom: 8px;
          background: #1e1e3f;
          border-left: 3px solid #333355;
        }

        .queue-item.processing {
          border-left-color: #f59e0b;
        }

        .queue-item.completed {
          border-left-color: #22c55e;
        }

        .queue-item.failed {
          border-left-color: #ef4444;
        }

        .queue-item-header {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .queue-scene {
          font-size: 0.8rem;
          font-family: monospace;
          color: #a0a0b0;
        }

        .queue-error {
          font-size: 0.75rem;
          color: #ff6b6b;
          margin-top: 4px;
        }

        .project-info {
          padding-top: 8px;
          border-top: 1px solid #333355;
          background: var(--bg-secondary);
        }

        .project-tier {
          font-size: 0.8rem;
          color: #a0a0b0;
        }

        /* Scrollbar */
        .queue-list::-webkit-scrollbar,
        .flow-videos-tab::-webkit-scrollbar {
          width: 8px;
        }

        .queue-list::-webkit-scrollbar-track,
        .flow-videos-tab::-webkit-scrollbar-track {
          background: #1a1a2e;
        }

        .queue-list::-webkit-scrollbar-thumb,
        .flow-videos-tab::-webkit-scrollbar-thumb {
          background: #333355;
          border-radius: 4px;
        }

        .queue-list::-webkit-scrollbar-thumb:hover,
        .flow-videos-tab::-webkit-scrollbar-thumb:hover {
          background: #444477;
        }

        @media (max-width: 900px) {
          .flow-videos-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}

export default FlowVideosTab;
