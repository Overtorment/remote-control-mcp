/**
 * MCP transport selector: public tunnel vs. local "closed circuit" listener.
 *
 * Adapted from layerzwallet/desktop's `features/mcp/tunnel-desktop.ts`, simplified
 * for this app's share-driven model: there is no separate activate/pause — a single
 * "engaged" flag tracks whether screen sharing (and therefore a transport) is up.
 *
 * Two concepts kept separate, as in the reference:
 *   - PREFERENCE (`getMcpLocalMode` / `setMcpLocalMode`): which transport the user
 *     wants. Toggling while a transport is live switches transports instantly; the
 *     contradicting transport is always torn down first (closed circuit — the public
 *     tunnel is never left running while "local only" is selected).
 *   - ENGAGEMENT (`connectActiveTransport` / `disconnectActiveTransport`): driven by
 *     the screen-share lifecycle. Starts/stops the preferred transport.
 *
 * `getMcpStatus` / `getMcpPublicUrl` follow the transport that is *actually live*
 * (`activeLocal`), not the preference, so the API never claims local-only while the
 * public tunnel is still up.
 */

import {
	connectTunnel,
	disconnectTunnel,
	getTunnelConnectionStatus,
	getTunnelPublicUrl,
	subscribeTunnelConnection,
	type TunnelConnectionStatus,
} from "./tunnel";
import type { IStorage } from "./tunnel-types";

type LocalControls = {
	start: () => Promise<{ url: string; port: number }>;
	stop: () => Promise<void>;
};

/** `'1'` selects the closed-circuit listener; anything else (default) the public tunnel. */
const MODE_KEY = "mcpLocalMode";

let storage: IStorage | null = null;
let local: LocalControls | null = null;

/** Desired transport (the checkbox): flips immediately so the UI reacts at once. */
let localPreference = false;
/** Transport currently authoritative for status/URL: flips only after the switch. */
let activeLocal = false;
/** True while screen sharing is up and a transport should be running. */
let engaged = false;
let localUrl: string | null = null; // non-null iff the local listener is running
const listeners = new Set<() => void>();

function notify(): void {
	listeners.forEach((fn) => fn());
}

/**
 * Serialize transport mutations. The UI fires connect/disconnect/setMcpLocalMode
 * without awaiting, so a queue keeps the last action winning and prevents a stop
 * from racing an in-flight start.
 */
let opChain: Promise<void> = Promise.resolve();
function enqueue(op: () => Promise<void>): Promise<void> {
	const run = opChain.then(op, op);
	opChain = run.catch(() => {});
	return run;
}

export function configureTransport(deps: {
	storage: IStorage;
	local: LocalControls;
}): void {
	storage = deps.storage;
	local = deps.local;
}

/** Load the persisted transport preference (call once after `configureTransport`). */
export async function loadMcpLocalMode(): Promise<void> {
	if (!storage) return;
	localPreference = (await storage.getItem(MODE_KEY)) === "1";
	activeLocal = localPreference;
	notify();
}

export function getMcpLocalMode(): boolean {
	return localPreference;
}

async function startLocal(): Promise<void> {
	if (!local) throw new Error("[mcp] transport not configured");
	const info = await local.start();
	localUrl = info.url;
	activeLocal = true;
	notify();
}

async function stopLocal(): Promise<void> {
	if (!local) return;
	await local.stop();
	localUrl = null;
	notify();
}

/** Connect the preferred transport (called when screen sharing starts). */
export function connectActiveTransport(): Promise<void> {
	return enqueue(async () => {
		engaged = true;
		if (localPreference) {
			await disconnectTunnel(); // closed circuit: ensure the tunnel is down
			activeLocal = true;
			notify();
			await startLocal();
		} else {
			await stopLocal();
			activeLocal = false;
			notify();
			await connectTunnel();
		}
	});
}

/** Disconnect whatever transport is live (called when screen sharing stops). */
export function disconnectActiveTransport(): Promise<void> {
	return enqueue(async () => {
		engaged = false;
		await disconnectTunnel();
		await stopLocal();
		activeLocal = false;
		notify();
	});
}

/**
 * Change the transport preference (the checkbox). If a transport is currently live,
 * switch instantly; otherwise just record the choice for the next time sharing starts.
 * The contradicting transport is always torn down so "local only" can't leave the
 * tunnel exposed.
 */
export async function setMcpLocalMode(localMode: boolean): Promise<void> {
	if (localMode === localPreference) return;
	localPreference = localMode;
	notify();

	await enqueue(async () => {
		if (storage) await storage.setItem(MODE_KEY, localMode ? "1" : "0");
		localPreference = localMode; // re-assert in case a load raced this toggle
		if (!engaged) return; // preference-only change; nothing is running

		if (localMode) {
			await disconnectTunnel(); // tear the tunnel down BEFORE reporting local
			activeLocal = true;
			notify();
			await startLocal();
		} else {
			await stopLocal(); // stop the local listener BEFORE reporting tunnel
			activeLocal = false;
			notify();
			await connectTunnel();
		}
	});
}

export function getMcpStatus(): TunnelConnectionStatus {
	if (activeLocal) {
		if (localUrl) return "connected";
		return engaged ? "connecting" : "disconnected";
	}
	return getTunnelConnectionStatus();
}

export function getMcpPublicUrl(): string | null {
	return activeLocal ? localUrl : getTunnelPublicUrl();
}

/** Subscribe to either transport's changes (status / URL / preference). */
export function subscribeMcp(onChange: () => void): () => void {
	const unsubscribeTunnel = subscribeTunnelConnection(onChange);
	listeners.add(onChange);
	return () => {
		unsubscribeTunnel();
		listeners.delete(onChange);
	};
}
