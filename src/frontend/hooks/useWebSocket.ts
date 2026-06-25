import { useState, useEffect, useCallback, useRef } from 'react';

interface WebSocketMessage {
    event: string;
    data: any;
    timestamp?: string;
}

export function useWebSocket() {
    const [connected, setConnected] = useState(false);
    const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
    const wsRef = useRef<WebSocket | null>(null);
    const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

    const connect = useCallback(() => {
        if (wsRef.current?.readyState === WebSocket.OPEN) return;

        // In dev mode, connect directly to backend WebSocket to avoid proxy issues
        // In production, use relative path
        const wsUrl = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

        const ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
            console.log('WebSocket connected');
            setConnected(true);
        };

        ws.onmessage = (event) => {
            try {
                const message: WebSocketMessage = JSON.parse(event.data);
                console.log('[WebSocket] Received:', message.event, message.data);
                setLastMessage(message);

                // Handle specific events
                if (message.event === 'profiles-updated') {
                    window.dispatchEvent(new CustomEvent('profiles-updated'));
                }

                // Handle tier-updated events from extension (per-profile)
                if (message.event === 'tier-updated') {
                    console.log('[WebSocket] tier-updated:', message.data);
                    window.dispatchEvent(new CustomEvent('tier-updated', {
                        detail: message.data,
                    }));
                }

                // Handle per-profile extension-status (connected/state/tier/credits)
                if (message.event === 'extension-status') {
                    console.log('[WebSocket] extension-status:', message.data);
                    window.dispatchEvent(new CustomEvent('extension-status', {
                        detail: message.data,
                    }));
                }

                // Handle media-urls-refresh (per profile)
                if (message.event === 'media-urls-refresh') {
                    window.dispatchEvent(new CustomEvent('media-urls-refresh', {
                        detail: message.data,
                    }));
                }

                // Handle profile-opened (so dashboards know to refresh without
                // waiting for the user to hit refresh)
                if (message.event === 'profile-opened') {
                    window.dispatchEvent(new CustomEvent('profiles-updated', { detail: message.data }));
                }

                // Handle browser-closed event (when profile browser is closed)
                if (message.event === 'browser-closed') {
                    console.log('[WebSocket] browser-closed:', message.data);
                    window.dispatchEvent(new CustomEvent('browser-closed', {
                        detail: message.data,
                    }));
                }
            } catch (e) {
                console.error('Error parsing WebSocket message:', e);
            }
        };

        ws.onclose = () => {
            console.log('WebSocket disconnected, reconnecting in 3s...');
            setConnected(false);
            // Clear any existing reconnect timeout first
            if (reconnectTimeoutRef.current) {
                clearTimeout(reconnectTimeoutRef.current);
            }
            reconnectTimeoutRef.current = setTimeout(connect, 3000);
        };

        ws.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }, []);

    const disconnect = useCallback(() => {
        if (reconnectTimeoutRef.current) {
            clearTimeout(reconnectTimeoutRef.current);
        }
        if (wsRef.current) {
            wsRef.current.close();
            wsRef.current = null;
        }
    }, []);

    useEffect(() => {
        connect();
        return () => disconnect();
    }, [connect, disconnect]);

    return {
        connected,
        lastMessage,
        reconnect: connect,
    };
}
