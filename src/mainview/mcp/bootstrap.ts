/**
 * MCP bootstrap wiring for the webview.
 *
 * Condensed equivalent of the reference's `mcp-platform.ts` + `tunnel-desktop.ts`.
 * Wires MCP deps, starts the tunnel client (transport selection — public tunnel
 * vs. local listener — lives in `transport.ts`), and never connects until screen
 * share begins.
 */

import { configureMcp, handleMcpRequest, resetMcpSessions } from "./mcp";
import type { RemoteControlDeps } from "./tools";
import { startTunnel } from "./tunnel";
import type { AppLifecycle, IStorage } from "./tunnel-types";

/** Reconnect the tunnel when the desktop window becomes visible again. */
const desktopAppLifecycle: AppLifecycle = {
	onForeground(callback) {
		const onVisibility = () => {
			if (document.visibilityState === "visible") callback();
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	},
};

let bootstrapped = false;

export async function bootstrapMcp(
	deps: RemoteControlDeps,
	storage: IStorage,
): Promise<void> {
	if (bootstrapped) return;
	bootstrapped = true;

	configureMcp(deps);

	await startTunnel({
		handleRequest: handleMcpRequest,
		storage,
		appLifecycle: desktopAppLifecycle,
		onSessionChange: ({ publicUrl, idChanged }) => {
			console.log("[mcp] PUBLIC URL:", publicUrl);
			if (idChanged) resetMcpSessions();
		},
	});
}

export {
	connectTunnel,
	disconnectTunnel,
	getTunnelConnectionStatus,
	getTunnelPublicUrl,
	subscribeTunnelConnection,
	type TunnelConnectionStatus,
} from "./tunnel";
