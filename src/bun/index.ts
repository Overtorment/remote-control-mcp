import {
	BrowserWindow,
	BrowserView,
	Utils,
	type RPCSchema,
} from "electrobun/bun";
import { mkdirSync } from "node:fs";
import {
	VirtualMouse,
	VirtualKeyboard,
	ensureUinputAccess,
	uinputWritable,
	type MouseButton,
} from "./uinput";

// Persistent key/value store backed by a JSON file in the user's config dir.
// The webview's localStorage is not reliably persisted across app restarts in
// the Electrobun webview, so the MCP tunnel session id (which keeps the public
// URL stable) is persisted here instead, via RPC.
const KV_DIR = `${Bun.env["XDG_CONFIG_HOME"] || `${Bun.env["HOME"] || "."}/.config`}/photo-booth-remote`;
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

const screenSize = await detectScreenSize();
const virtualMouse = new VirtualMouse(screenSize.width, screenSize.height);
const virtualKeyboard = new VirtualKeyboard();

// Define RPC schema for photo saving + remote input control
export type PhotoBoothRPC = {
	bun: RPCSchema<{
		requests: {
			savePhoto: {
				params: {
					dataUrl: string;
					filename: string;
				};
				response: {
					success: boolean;
					path?: string;
					reason?: string;
					error?: string;
				};
			};
			getScreenSize: {
				params: {};
				response: {
					width: number;
					height: number;
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
		};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {};
	}>;
};

// Create RPC instance using BrowserView.defineRPC
const photoBoothRPC = BrowserView.defineRPC<PhotoBoothRPC>({
	maxRequestTime: 120000,
	handlers: {
		requests: {
			savePhoto: async ({ dataUrl, filename }) => {
				try {
					// Convert data URL to buffer
					const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
					const buffer = Buffer.from(base64Data, "base64");

					// Show save dialog using Utils
					const chosenPaths = await Utils.openFileDialog({
						startingFolder: Bun.env["HOME"] || "/",
						allowedFileTypes: "png",
						canChooseFiles: false,
						canChooseDirectory: true,
						allowsMultipleSelection: false,
					});

					if (chosenPaths[0] && chosenPaths[0] !== "") {
						const savePath = `${chosenPaths[0]}/${filename}`;

						// Save the file
						await Bun.write(savePath, buffer);

						return {
							success: true,
							path: savePath,
						};
					} else {
						return {
							success: false,
							reason: "canceled",
						};
					}
				} catch (error) {
					console.error("Error saving photo:", error);
					return {
						success: false,
						error: (error as Error).message,
					};
				}
			},
			getScreenSize: async () => virtualMouse.resolution,
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
	title: "Screen Capture",
	url: "views://mainview/index.html",
	// Don't specify renderer to use the default (native WKWebView on macOS)
	frame: {
		width: 1000,
		height: 700,
		x: 100,
		y: 100,
	},
	rpc: photoBoothRPC,
});

process.on("exit", () => {
	virtualMouse.destroy();
	virtualKeyboard.destroy();
});
process.on("SIGINT", () => {
	virtualMouse.destroy();
	virtualKeyboard.destroy();
	process.exit(0);
});

console.log("Screen Capture app started!");
console.log(
	`Detected screen size: ${screenSize.width}x${screenSize.height}`,
);
