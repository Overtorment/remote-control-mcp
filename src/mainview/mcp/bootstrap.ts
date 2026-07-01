/**
 * MCP bootstrap wiring for the webview.
 *
 * Condensed equivalent of the reference's `mcp-platform.ts` + `tunnel-desktop.ts`
 * (public-tunnel path only — no local listener mode). Wires the MCP deps and
 * starts the tunnel client.
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

	configureMcp(deps, { name: "remote-control-mcp", version: "0.0.1" });

	await startTunnel({
		handleRequest: handleMcpRequest,
		storage,
		appLifecycle: desktopAppLifecycle,
		// Never open the tunnel on launch — it only connects when the user grants
		// screen-share consent via the unified "Select Screen" action.
		allowAutoConnect: false,
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
