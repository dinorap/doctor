import { EventEmitter } from 'events';
import { FlowApiClient, FlowApiClientOptions } from './FlowApiClient';
import logger from '../utils/logger';

export interface FlowApiRegistryOptions {
    wsUrl: string;
    defaultFlowKey?: string;
    timeoutMs?: number;
}

/**
 * Singleton registry that owns ONE FlowApiClient per profileId.
 *
 * Mirrors ExtensionBridgeRegistry: each profile gets its own client
 * with its own flowKey, websocket, and pending-request map. No more
 * "setFlowKey(B) overwrites setFlowKey(A)".
 */
export class FlowApiRegistry extends EventEmitter {
    private options: FlowApiRegistryOptions;
    private clients = new Map<string, FlowApiClient>();

    constructor(options: FlowApiRegistryOptions) {
        super();
        this.options = options;
    }

    public getOrCreate(profileId: string): FlowApiClient {
        let client = this.clients.get(profileId);
        if (!client) {
            const clientOptions: FlowApiClientOptions = {
                wsUrl: this.options.wsUrl,
                timeoutMs: this.options.timeoutMs,
                profileId,
            };

            // Seed with default key only if no specific one is set later
            if (this.options.defaultFlowKey) {
                clientOptions.flowKey = this.options.defaultFlowKey;
            }

            client = new FlowApiClient(clientOptions);
            this.clients.set(profileId, client);
            this.wireForwarding(profileId, client);
            logger.info('[FlowApiRegistry] Created client for profile %s', profileId);
        }
        return client;
    }

    public get(profileId: string): FlowApiClient | undefined {
        return this.clients.get(profileId);
    }

    public has(profileId: string): boolean {
        return this.clients.has(profileId);
    }

    /**
     * Apply a freshly captured flowKey to a specific profile only.
     * Does not touch other profiles' clients.
     *
     * Idempotent: if the same key is already set on this client, no
     * log line is emitted. The extension's background.js occasionally
     * sends token_captured several times in quick succession (page
     * reload, retry, etc.) and we used to spam "setFlowKey for profile"
     * for every duplicate.
     */
    public setFlowKey(profileId: string, flowKey: string): FlowApiClient {
        const client = this.getOrCreate(profileId);
        // setFlowKey is idempotent on the client side too — we just skip
        // the log line here when the value hasn't actually changed.
        if (client.getFlowKey() === flowKey) {
            return client;
        }
        client.setFlowKey(flowKey);
        logger.info('[FlowApiRegistry] setFlowKey for profile %s', profileId);
        return client;
    }

    public remove(profileId: string): void {
        const client = this.clients.get(profileId);
        if (!client) return;
        client.disconnect();
        client.removeAllListeners();
        this.clients.delete(profileId);
        logger.info('[FlowApiRegistry] Removed client for profile %s', profileId);
        this.emit('removed', { profileId });
    }

    public forEach(fn: (profileId: string, client: FlowApiClient) => void): void {
        for (const [profileId, client] of this.clients) {
            fn(profileId, client);
        }
    }

    public dispose(): void {
        for (const profileId of Array.from(this.clients.keys())) {
            this.remove(profileId);
        }
    }

    private wireForwarding(profileId: string, client: FlowApiClient): void {
        client.on('connected', () => this.emit('client-connected', { profileId }));
        client.on('disconnected', (info: any) => this.emit('client-disconnected', { profileId, ...info }));
        client.on('error', (err: Error) => this.emit('client-error', { profileId, error: err }));
    }
}
