import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../services/api';
import type { Profile, CloakBrowserStatus, CreateFlowProjectsBatchRequest, GeneratedImageResult } from '../types';

export function useProfiles() {
    const [profiles, setProfiles] = useState<Profile[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [creating, setCreating] = useState(false);

    const loadProfiles = useCallback(async () => {
        try {
            setLoading(true);
            setError(null);
            const data = await api.getProfiles();
            setProfiles(data);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load profiles');
        } finally {
            setLoading(false);
        }
    }, []);

    const createProfile = useCallback(async (name: string, metadata?: Record<string, any>) => {
        setCreating(true);
        try {
            const profile = await api.createProfile({ name, metadata });
            setProfiles(prev => [profile, ...prev]);
            return profile;
        } finally {
            setCreating(false);
        }
    }, []);

    const updateProfile = useCallback(async (id: string, data: { name?: string; metadata?: Record<string, any> }) => {
        const updated = await api.updateProfile(id, data);
        setProfiles(prev => prev.map(p => p.id === id ? { ...p, ...updated } : p));
        return updated;
    }, []);

    const deleteProfile = useCallback(async (id: string) => {
        await api.deleteProfile(id);
        setProfiles(prev => prev.filter(p => p.id !== id));
    }, []);

    const openProfile = useCallback(async (id: string, openFlow?: boolean, useStealth?: boolean) => {
        await api.openProfile({ id, openFlow, useStealth });
        await loadProfiles();
    }, [loadProfiles]);

    const closeProfile = useCallback(async (id: string) => {
        await api.closeProfile(id);
        await loadProfiles();
    }, [loadProfiles]);

    const saveSession = useCallback(async (id: string) => {
        await api.saveSession(id);
        await loadProfiles();
    }, [loadProfiles]);

    const refreshTier = useCallback(async (id: string) => {
        const result = await api.refreshTier(id);
        await loadProfiles();
        return result;
    }, [loadProfiles]);

    const setProxy = useCallback(async (id: string, proxy: string | null) => {
        const result = await api.setProxy(id, proxy);
        await loadProfiles();
        return result;
    }, [loadProfiles]);

    const createFlowProjectsBatch = useCallback(async (data: CreateFlowProjectsBatchRequest) => {
        return api.createFlowProjectsBatch(data);
    }, []);

    const waitForProfileReady = useCallback(async (profileId: string, timeoutMs = 20000) => {
        return api.waitForProfileReady(profileId, timeoutMs);
    }, []);

    // Update specific profile's tier when WebSocket broadcasts tier-updated.
    // We accept any string here and let the badge component decide how to
    // render it — the previous implementation cast to a strict union which
    // would silently keep the old tier if the server sent an unexpected
    // value (e.g. 'UNKNOWN' or an empty string).
    const updateProfileTier = useCallback((profileId: string, tier: string) => {
        setProfiles(prev => prev.map(p =>
            p.id === profileId ? { ...p, tier: (tier || 'UNKNOWN') as any } : p
        ));
    }, []);

    // Update specific profile's extension status (connected, state, credits, ...)
    const updateProfileExtensionStatus = useCallback((profileId: string, status: any) => {
        setProfiles(prev => prev.map(p => {
            if (p.id !== profileId) return p;
            const next: any = { ...p };
            if (status) {
                if (typeof status.connected === 'boolean') next.extensionConnected = status.connected;
                if (status.tier) next.tier = status.tier;
                if (typeof status.credits === 'number') next.credits = status.credits;
                if (status.state) next.extensionState = status.state;
                if (typeof status.flowKeyPresent === 'boolean') next.flowKeyPresent = status.flowKeyPresent;
                if (typeof status.tokenAge === 'number' || status.tokenAge === null) next.tokenAge = status.tokenAge;
                if (status.lastError !== undefined) lastErrorRef.current = status.lastError;
            }
            return next;
        }));
    }, []);

    const lastErrorRef = useRef<string | null>(null);

    // Listen for WebSocket tier-updated events.
    //
    // We do BOTH:
    //   1) Patch the in-memory profile record so the badge flips
    //      immediately (no flash of stale state).
    //   2) Re-fetch the profile list from the server so any field we
    //      didn't explicitly patch (proxy, lastUsedAt, …) stays in
    //      sync. Without this, server-driven tier changes can look
    //      stuck on the dashboard if the in-memory patch is shadowed
    //      by a subsequent loadProfiles() call that re-reads the
    //      pre-broadcast value.
    useEffect(() => {
        const handleProfilesUpdated = () => {
            console.log('[useProfiles] profiles-updated via WebSocket, reloading...');
            loadProfiles();
        };

        const handleTierUpdated = (event: CustomEvent) => {
            const { profileId, tier } = event.detail || {};
            if (profileId && tier) {
                console.log('[useProfiles] Tier updated via WebSocket:', profileId, tier);
                updateProfileTier(profileId, tier);
                // Also refresh from the server — the broadcast tier is
                // already in the DB so a refetch will confirm the
                // value. Debounced to coalesce multiple events for
                // the same profile in the same tick.
                if (refreshTimerRef.current) {
                    clearTimeout(refreshTimerRef.current);
                }
                refreshTimerRef.current = setTimeout(() => {
                    loadProfiles();
                }, 250);
            }
        };

        const handleExtensionStatus = (event: CustomEvent) => {
            const data = event.detail || {};
            if (data.profileId) {
                console.log('[useProfiles] extension-status via WebSocket:', data);
                updateProfileExtensionStatus(data.profileId, data);
            }
        };

        window.addEventListener('profiles-updated', handleProfilesUpdated);
        window.addEventListener('tier-updated', handleTierUpdated as EventListener);
        window.addEventListener('extension-status', handleExtensionStatus as EventListener);
        return () => {
            window.removeEventListener('profiles-updated', handleProfilesUpdated);
            window.removeEventListener('tier-updated', handleTierUpdated as EventListener);
            window.removeEventListener('extension-status', handleExtensionStatus as EventListener);
            if (refreshTimerRef.current) {
                clearTimeout(refreshTimerRef.current);
                refreshTimerRef.current = null;
            }
        };
    }, [updateProfileTier, updateProfileExtensionStatus, loadProfiles]);

    // Debug: log profile changes
    useEffect(() => {
        profiles.forEach(p => {
            const projects = (p.metadata as any)?.flowProjects;
            if (projects?.length > 0) {
                console.log(`[useProfiles] Profile ${p.id} (${p.name}) has ${projects.length} flowProjects`);
            }
        });
    }, [profiles]);

    const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        loadProfiles();
    }, [loadProfiles]);

    return {
        profiles,
        loading,
        error,
        creating,
        loadProfiles,
        createProfile,
        updateProfile,
        deleteProfile,
        openProfile,
        closeProfile,
        saveSession,
        refreshTier,
        setProxy,
        createFlowProjectsBatch,
        waitForProfileReady,
    };
}

export function useCloakBrowser() {
    const [status, setStatus] = useState<CloakBrowserStatus>({
        available: false,
        ready: false,
        downloading: false,
    });
    const [loading, setLoading] = useState(true);

    const checkStatus = useCallback(async () => {
        try {
            const data = await api.getCloakBrowserStatus();
            setStatus(data);
        } catch {
            // Ignore errors
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        checkStatus();
        const interval = setInterval(checkStatus, 30000);
        return () => clearInterval(interval);
    }, [checkStatus]);

    return { status, loading, checkStatus };
}

export function useFlowImages() {
    const [generating, setGenerating] = useState(false);
    const [lastResult, setLastResult] = useState<GeneratedImageResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    const generateImage = useCallback(async (data: {
        profileId: string;
        prompt: string;
        projectId?: string;
        modelKey?: string;
        aspectRatio?: string;
        userPaygateTier?: 'PAYGATE_TIER_ONE' | 'PAYGATE_TIER_TWO';
    }) => {
        setGenerating(true);
        setError(null);
        try {
            const result = await api.generateFlowImage({
                profileId: data.profileId,
                prompt: data.prompt,
                projectId: data.projectId,
                modelKey: data.modelKey,
                aspectRatio: data.aspectRatio,
                userPaygateTier: data.userPaygateTier,
            });
            setLastResult(result);
            return result;
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Lỗi khi tạo ảnh';
            setError(message);
            throw err;
        } finally {
            setGenerating(false);
        }
    }, []);

    const reset = useCallback(() => {
        setLastResult(null);
        setError(null);
    }, []);

    return {
        generating,
        lastResult,
        error,
        generateImage,
        reset,
    };
}

export interface GeneratedEntityResult {
    id: string;
    name: string;
    description: string;
    entityType: string;
    materialId: string;
    profileId: string;
    projectId: string;
    mediaId?: string;
    localPath?: string;
    remoteUrl?: string;
    aspectRatio?: string;
    metadata?: string;
    success: boolean;
}

export function useEntities() {
    const [generating, setGenerating] = useState(false);
    const [lastResult, setLastResult] = useState<GeneratedEntityResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    const generateEntity = useCallback(async (data: {
        name: string;
        description: string;
        entityType: string;
        materialId: string;
        profileId: string;
        projectId?: string;
        materialStyle?: any;
        modelKey?: string;
        aspectRatio?: string;
        upscaleResolution?: string;
    }) => {
        setGenerating(true);
        setError(null);
        try {
            const res = await fetch('/api/entities/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: data.name,
                    description: data.description,
                    entityType: data.entityType,
                    materialId: data.materialId,
                    profileId: data.profileId,
                    projectId: data.projectId,
                    materialStyle: data.materialStyle,
                    modelKey: data.modelKey,
                    aspectRatio: data.aspectRatio,
                    upscaleResolution: data.upscaleResolution,
                }),
            });
            const response = await res.json();
            if (response.success) {
                setLastResult(response.data);
                return response.data;
            } else {
                const errMsg = response.error || 'Lỗi khi tạo entity';
                setError(errMsg);
                throw new Error(errMsg);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Lỗi khi tạo entity';
            setError(message);
            throw err;
        } finally {
            setGenerating(false);
        }
    }, []);

    const reset = useCallback(() => {
        setLastResult(null);
        setError(null);
    }, []);

    const upscaleEntity = useCallback(async (entityId: string, upscaleResolution: string) => {
        try {
            const res = await fetch(`/api/entities/${entityId}/upscale`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ upscaleResolution }),
            });
            const response = await res.json();
            if (response.success) {
                return response.data;
            } else {
                throw new Error(response.error || 'Lỗi khi upscale entity');
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Lỗi khi upscale entity';
            throw new Error(message);
        }
    }, []);

    return {
        generating,
        lastResult,
        error,
        generateEntity,
        upscaleEntity,
        reset,
    };
}
