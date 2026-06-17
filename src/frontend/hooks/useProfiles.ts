import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../services/api';
import type { Profile, CloakBrowserStatus, CreateFlowProjectsBatchRequest } from '../types';

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

        window.addEventListener('tier-updated', handleTierUpdated as EventListener);
        window.addEventListener('extension-status', handleExtensionStatus as EventListener);
        return () => {
            window.removeEventListener('tier-updated', handleTierUpdated as EventListener);
            window.removeEventListener('extension-status', handleExtensionStatus as EventListener);
            if (refreshTimerRef.current) {
                clearTimeout(refreshTimerRef.current);
                refreshTimerRef.current = null;
            }
        };
    }, [updateProfileTier, updateProfileExtensionStatus, loadProfiles]);

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
