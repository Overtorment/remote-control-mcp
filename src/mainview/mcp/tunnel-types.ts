/**
 * Tunnel wire types — duplicated on the tunnel server side
 * (`mcp-websocket-tunnel/server.ts`); keep both in sync.
 *
 * Borrowed from layerzwallet/desktop.
 */

export type TunnelHttpRequest = {
	type: "http_request";
	requestId: string;
	method: string;
	path: string;
	headers: Record<string, string>;
	bodyBase64: string;
};

export type TunnelHttpResponse = {
	type: "http_response";
	requestId: string;
	status: number;
	headers: Record<string, string>;
	bodyBase64: string;
};

export type RequestHandler = (
	req: TunnelHttpRequest,
) => Promise<TunnelHttpResponse>;

/** Minimal persistent key/value store (webview: localStorage adapter). */
export interface IStorage {
	getItem(key: string): Promise<string>;
	setItem(key: string, value: string): Promise<void>;
}

/** Optional platform-lifecycle hook for waking the tunnel when the app foregrounds. */
export type AppLifecycle = {
	/** Subscribe to "app foregrounded" events. Returns an unsubscribe fn. */
	onForeground(callback: () => void): () => void;
};
