import { BrowserWindow, BrowserView, type RPCSchema } from "electrobun/bun";
import { mkdirSync } from "node:fs";
import { hostname, release } from "node:os";
import {
	VirtualMouse,
	VirtualKeyboard,
	ensureUinputAccess,
	uinputWritable,
	type MouseButton,
} from "./uinput";
import {
	configureLocalMcpServer,
	startLocalMcpServer,
	stopLocalMcpServer,
} from "./local-mcp-server";
import type {
	TunnelHttpRequest,
	TunnelHttpResponse,
} from "../mainview/mcp/tunnel-types";
import type { SystemInfo } from "../mainview/mcp/tools";

// Persistent key/value store backed by a JSON file in the user's config dir.
// The webview's localStorage is not reliably persisted across app restarts in
// the Electrobun webview, so the MCP tunnel session id (which keeps the public
// URL stable) is persisted here instead, via RPC.
const KV_DIR = `${Bun.env["XDG_CONFIG_HOME"] || `${Bun.env["HOME"] || "."}/.config`}/remote-control-mcp`;
const KV_PATH = `${KV_DIR}/storage.json`;
let kvData: Record<string, string> = {};
try {
	kvData = JSON.parse(await Bun.file(KV_PATH).text());
} catch {
	kvData = {};
}
async function kvPersist(): Promise<void> {
	try {
		mkdirSync(KV_DIR, { recursive: true });
		await Bun.write(KV_PATH, JSON.stringify(kvData));
	} catch (error) {
		console.error("Error persisting kv store:", error);
	}
}

// Detect the primary display resolution so absolute click coordinates map to
// real pixels. Tries xrandr (works via XWayland too); falls back to 1920x1080.
async function detectScreenSize(): Promise<{ width: number; height: number }> {
	try {
		const proc = Bun.spawn(["xrandr", "--current"], {
			env: { ...Bun.env, DISPLAY: Bun.env["DISPLAY"] || ":0" },
			stdout: "pipe",
			stderr: "ignore",
		});
		const out = await new Response(proc.stdout).text();
		await proc.exited;

		// Prefer the line marked "primary", else the first connected mode.
		const primary = out
			.split("\n")
			.find((line) => line.includes(" connected primary"));
		const source = primary
			? [primary]
			: out.split("\n").filter((line) => line.includes(" connected"));
		for (const line of source) {
			const match = line.match(/(\d+)x(\d+)\+\d+\+\d+/);
			if (match) {
				return {
					width: Number.parseInt(match[1]!, 10),
					height: Number.parseInt(match[2]!, 10),
				};
			}
		}
	} catch {
		// ignore and use fallback
	}
	return { width: 1920, height: 1080 };
}

// Parse /etc/os-release for a human-readable distro name + version.
async function readOsRelease(): Promise<{ distro: string; version: string }> {
	try {
		const text = await Bun.file("/etc/os-release").text();
		const map: Record<string, string> = {};
		for (const line of text.split("\n")) {
			const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
			if (match?.[1]) map[match[1]] = match[2]!.replace(/^"|"$/g, "");
		}
		return {
			distro: map["PRETTY_NAME"] || map["NAME"] || "",
			version: map["VERSION"] || map["VERSION_ID"] || "",
		};
	} catch {
		return { distro: "", version: "" };
	}
}

// Gather host details useful to a remote-control agent.
async function gatherSystemInfo(): Promise<SystemInfo> {
	const { distro, version } = await readOsRelease();
	return {
		screen: virtualMouse.resolution,
		os: {
			platform: process.platform,
			distro,
			version,
			kernel: release(),
			arch: process.arch,
		},
		session: {
			type: Bun.env["XDG_SESSION_TYPE"] || "",
			desktop: Bun.env["XDG_CURRENT_DESKTOP"] || Bun.env["DESKTOP_SESSION"] || "",
		},
		hostname: hostname(),
		keyboardLayout: "US (assumed)",
		inputMethod: "uinput (virtual mouse/keyboard)",
		time: {
			iso: new Date().toISOString(),
			timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
		},
	};
}

const screenSize = await detectScreenSize();
const virtualMouse = new VirtualMouse(screenSize.width, screenSize.height);
const virtualKeyboard = new VirtualKeyboard();

// Define RPC schema for remote input control + MCP plumbing
export type RemoteControlMcpRPC = {
	bun: RPCSchema<{
		requests: {
			getSystemInfo: {
				params: {};
				response: SystemInfo;
			};
			setCaptureResolution: {
				params: {
					width: number;
					height: number;
				};
				response: {
					success: boolean;
				};
			};
			simulateClick: {
				params: {
					x: number;
					y: number;
					button?: MouseButton;
				};
				response: {
					success: boolean;
					error?: string;
				};
			};
			getClickStatus: {
				params: {};
				response: {
					writable: boolean;
				};
			};
			ensureClickPermission: {
				params: {};
				response: {
					ok: boolean;
					changed: boolean;
					error?: string;
				};
			};
			typeText: {
				params: {
					text: string;
				};
				response: {
					success: boolean;
					skipped?: string[];
					error?: string;
				};
			};
			pressKey: {
				params: {
					key: string;
					modifiers?: string[];
				};
				response: {
					success: boolean;
					error?: string;
				};
			};
			kvGet: {
				params: { key: string };
				response: { value: string };
			};
			kvSet: {
				params: { key: string; value: string };
				response: { success: boolean };
			};
			// Closed-circuit ("local only") transport: start/stop a local HTTP MCP
			// listener in this Bun process instead of tunneling through the relay.
			mcpLocalServerStart: {
				params: {};
				response: { url: string; port: number };
			};
			mcpLocalServerStop: {
				params: {};
				response: { success: boolean };
			};
		};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {
			// Bun → renderer: hand an HTTP request from the local MCP listener to the
			// webview's MCP handler (same handler the tunnel uses).
			mcpHandleHttp: {
				params: TunnelHttpRequest;
				response: TunnelHttpResponse;
			};
		};
		messages: {};
	}>;
};

// Create RPC instance using BrowserView.defineRPC
const remoteControlMcpRpc = BrowserView.defineRPC<RemoteControlMcpRPC>({
	maxRequestTime: 120000,
	handlers: {
		requests: {
			getSystemInfo: async () => gatherSystemInfo(),
			// Align the virtual mouse's absolute axis range with the live screen-
			// capture resolution. libinput normalizes a uinput abs device's
			// [0, max] range onto the full output, so by matching the range to the
			// exact pixel space the agent sees in screenshots, click coordinates
			// map 1:1 regardless of any capture downscaling.
			setCaptureResolution: async ({ width, height }) => {
				if (width > 0 && height > 0) {
					virtualMouse.setResolution(Math.round(width), Math.round(height));
				}
				return { success: true };
			},
			getClickStatus: async () => ({ writable: uinputWritable() }),
			ensureClickPermission: async () => ensureUinputAccess(),
			typeText: async ({ text }) => {
				try {
					const { skipped } = await virtualKeyboard.typeText(text);
					return { success: true, skipped };
				} catch (error) {
					console.error("Error typing text:", error);
					return { success: false, error: (error as Error).message };
				}
			},
			pressKey: async ({ key, modifiers }) => {
				try {
					await virtualKeyboard.pressKey(key, modifiers ?? []);
					return { success: true };
				} catch (error) {
					console.error("Error pressing key:", error);
					return { success: false, error: (error as Error).message };
				}
			},
			kvGet: async ({ key }) => ({ value: kvData[key] ?? "" }),
			kvSet: async ({ key, value }) => {
				kvData[key] = value;
				await kvPersist();
				return { success: true };
			},
			mcpLocalServerStart: async () => startLocalMcpServer(),
			mcpLocalServerStop: async () => {
				stopLocalMcpServer();
				return { success: true };
			},
			simulateClick: async ({ x, y, button }) => {
				try {
					await virtualMouse.click(x, y, button ?? "left");
					return { success: true };
				} catch (error) {
					console.error("Error simulating click:", error);
					return {
						success: false,
						error: (error as Error).message,
					};
				}
			},
		},
		messages: {},
	},
});

// Create the main window
// Use native renderer (WKWebView) by default, but allow overriding with CEF
const mainWindow = new BrowserWindow({
	title: "Remote Control MCP",
	url: "views://mainview/index.html",
	// Don't specify renderer to use the default (native WKWebView on macOS)
	frame: {
		width: 1000,
		height: 700,
		x: 100,
		y: 100,
	},
	rpc: remoteControlMcpRpc,
});

// Bridge the local MCP listener (Bun) to the webview's MCP handler, and persist
// its bearer token via the existing file-backed KV store.
configureLocalMcpServer(
	(req) => remoteControlMcpRpc.request.mcpHandleHttp(req),
	{
		getItem: async (key) => kvData[key] ?? "",
		setItem: async (key, value) => {
			kvData[key] = value;
			await kvPersist();
		},
	},
);

process.on("exit", () => {
	stopLocalMcpServer();
	virtualMouse.destroy();
	virtualKeyboard.destroy();
});
process.on("SIGINT", () => {
	stopLocalMcpServer();
	virtualMouse.destroy();
	virtualKeyboard.destroy();
	process.exit(0);
});

console.log("Remote Control MCP started!");
console.log(
	`Detected screen size: ${screenSize.width}x${screenSize.height}`,
);
