import { EventEmitter } from 'events';
import { ExtensionBridge, ExtensionStatus } from './ExtensionBridge';
import logger from '../utils/logger';

type StatusListener = (status: ExtensionStatus) => void;

/**
 * Singleton registry that owns ONE ExtensionBridge per profileId.
 *
 * Why: previously the agent exported a single ExtensionBridge instance,
 * so two profiles racing to `setWebSocket` would silently overwrite each
 * other and one profile would answer API calls meant for the other.
 *
 * Contract:
 *   - getOrCreate(profileId) lazily creates a bridge the first time we
 *     hear about a profile. Returns the SAME instance on every call.
 *   - bindWebSocket(profileId, ws) attaches the extension's socket to
 *     that profile's bridge (and detaches it from any other bridge that
 *     might have been holding it).
 *   - get(profileId) returns undefined if not yet known — never creates.
 *   - forEach iterates known profiles (used to broadcast events).
 *   - remove(profileId) drops the bridge (called on browser close).
 *
 * Emits 'status' whenever any bridge reports a status change. The
 * WebSocket layer subscribes once and forwards to all dashboard clients.
 */
export class ExtensionBridgeRegistry extends EventEmitter {
    private bridges = new Map<string, ExtensionBridge>();

    public getOrCreate(profileId: string): ExtensionBridge {
        let bridge = this.bridges.get(profileId);
        if (!bridge) {
            bridge = new ExtensionBridge(profileId);
            this.bridges.set(profileId, bridge);
            this.wireStatusForwarding(bridge);
            logger.info('[ExtensionBridgeRegistry] Created bridge for profile %s', profileId);
        }
        return bridge;
    }

    public get(profileId: string): ExtensionBridge | undefined {
        return this.bridges.get(profileId);
    }

    public has(profileId: string): boolean {
        return this.bridges.has(profileId);
    }

    /**
     * Bind an extension websocket to a profile. If this socket was
     * previously bound to a different profile, that bridge is detached
     * first so it doesn't keep receiving messages from a stale socket.
     *
     * Idempotent: if `ws` is already the bound socket for `profileId`,
     * no log spam and no extra status broadcasts.
     */
    public bindWebSocket(profileId: string, ws: any): ExtensionBridge {
        const bridge = this.getOrCreate(profileId);

        // Fast path: same socket already on this bridge — nothing to do.
        if (bridge.getWebSocket() === ws) {
            return bridge;
        }

        // Defensive: if this exact socket is already on another bridge,
        // detach it there before re-binding here.
        for (const [otherId, other] of this.bridges) {
            if (otherId !== profileId && other.getWebSocket() === ws) {
                other.setWebSocket(null);
                logger.warn(
                    '[ExtensionBridgeRegistry] Detached socket from profile %s before re-binding to %s',
                    otherId,
                    profileId,
                );
            }
        }

        bridge.setWebSocket(ws);
        bridge.updateStatus({ connected: true });
        logger.info('[ExtensionBridgeRegistry] Bound ws to profile %s', profileId);
        return bridge;
    }

    public unbindWebSocket(profileId: string, ws: any): void {
        const bridge = this.bridges.get(profileId);
        if (!bridge) return;
        if (bridge.getWebSocket() === ws) {
            bridge.setWebSocket(null);
            logger.info('[ExtensionBridgeRegistry] Unbound ws from profile %s', profileId);
        }
    }

    public remove(profileId: string): void {
        const bridge = this.bridges.get(profileId);
        if (!bridge) return;
        bridge.close();
        this.bridges.delete(profileId);
        logger.info('[ExtensionBridgeRegistry] Removed bridge for profile %s', profileId);
        this.emit('removed', { profileId });
    }

    public forEach(fn: (profileId: string, bridge: ExtensionBridge) => void): void {
        for (const [profileId, bridge] of this.bridges) {
            fn(profileId, bridge);
        }
    }

    public list(): ExtensionStatus[] {
        const out: ExtensionStatus[] = [];
        for (const bridge of this.bridges.values()) {
            out.push(bridge.getStatus());
        }
        return out;
    }

    public onStatus(listener: StatusListener): () => void {
        this.on('status', listener);
        return () => this.off('status', listener);
    }

    private wireStatusForwarding(bridge: ExtensionBridge): void {
        bridge.on('status', (status: ExtensionStatus) => {
            this.emit('status', status);
        });
    }
}
