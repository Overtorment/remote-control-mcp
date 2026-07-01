import { Buffer } from "buffer";

// The borrowed MCP/tunnel modules use Node's Buffer; provide it in the webview.
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import Electrobun, { Electroview } from "electrobun/view";
import type { RemoteControlMcpRPC, RpcEmptyParams } from "../bun/index";
import { bootstrapMcp } from "./mcp/bootstrap";
import { handleMcpRequest } from "./mcp/mcp";
import type { MouseButton, RemoteControlDeps } from "./mcp/tools";
import {
	configureTransport,
	connectActiveTransport,
	disconnectActiveTransport,
	getMcpLocalMode,
	getMcpPublicUrl,
	getMcpStatus,
	loadMcpLocalMode,
	setMcpLocalMode,
	subscribeMcp,
} from "./mcp/transport";
import type { IStorage } from "./mcp/tunnel-types";

const rpc = Electroview.defineRPC<RemoteControlMcpRPC>({
	maxRequestTime: 120000,
	handlers: {
		requests: {
			// Bun's local MCP listener forwards each HTTP request here; reuse the same
			// MCP handler the tunnel uses. `configureMcp` runs during bootstrapMcp.
			mcpHandleHttp: (req) => handleMcpRequest(req),
		},
		messages: {} satisfies RpcEmptyParams,
	},
});

const electrobun = new Electrobun.Electroview({ rpc });

function bunRpc() {
	const client = electrobun.rpc;
	if (!client) {
		throw new Error("RPC client unavailable");
	}
	return client;
}

class ScreenCaptureApp {
	private video: HTMLVideoElement;
	private canvas: HTMLCanvasElement;
	private selectScreenBtn: HTMLButtonElement;
	private stopBtn: HTMLButtonElement;
	private status: HTMLElement;
	private statusText: HTMLElement;

	private clickXInput: HTMLInputElement;
	private clickYInput: HTMLInputElement;
	private clickButtonSelect: HTMLSelectElement;
	private simulateClickBtn: HTMLButtonElement;
	private clickResult: HTMLElement;
	private screenSizeLabel: HTMLElement;
	private permissionRow: HTMLElement;
	private permissionText: HTMLElement;
	private grantAccessBtn: HTMLButtonElement;
	private typeTextInput: HTMLInputElement;
	private typeTextBtn: HTMLButtonElement;
	private pressKeyInput: HTMLInputElement;
	private pressKeyBtn: HTMLButtonElement;
	private modCtrl: HTMLInputElement;
	private modShift: HTMLInputElement;
	private modAlt: HTMLInputElement;
	private modMeta: HTMLInputElement;
	private keyResult: HTMLElement;

	private stream: MediaStream | null = null;

	/** Fired after the user grants screen-share consent. */
	onShareStarted?: () => void;
	/** Fired when screen sharing stops (user or system). */
	onShareEnded?: () => void;

	constructor() {
		this.video = document.getElementById("video") as HTMLVideoElement;
		this.canvas = document.getElementById("canvas") as HTMLCanvasElement;
		this.selectScreenBtn = document.getElementById(
			"selectScreenBtn",
		) as HTMLButtonElement;
		this.stopBtn = document.getElementById("stopBtn") as HTMLButtonElement;
		this.status = document.getElementById("status") as HTMLElement;
		this.statusText = this.status.querySelector(".status-text") as HTMLElement;
		this.clickXInput = document.getElementById("clickX") as HTMLInputElement;
		this.clickYInput = document.getElementById("clickY") as HTMLInputElement;
		this.clickButtonSelect = document.getElementById(
			"clickButton",
		) as HTMLSelectElement;
		this.simulateClickBtn = document.getElementById(
			"simulateClickBtn",
		) as HTMLButtonElement;
		this.clickResult = document.getElementById("clickResult") as HTMLElement;
		this.screenSizeLabel = document.getElementById("screenSize") as HTMLElement;
		this.permissionRow = document.getElementById(
			"permissionRow",
		) as HTMLElement;
		this.permissionText = document.getElementById(
			"permissionText",
		) as HTMLElement;
		this.grantAccessBtn = document.getElementById(
			"grantAccessBtn",
		) as HTMLButtonElement;
		this.typeTextInput = document.getElementById(
			"typeText",
		) as HTMLInputElement;
		this.typeTextBtn = document.getElementById(
			"typeTextBtn",
		) as HTMLButtonElement;
		this.pressKeyInput = document.getElementById(
			"pressKey",
		) as HTMLInputElement;
		this.pressKeyBtn = document.getElementById(
			"pressKeyBtn",
		) as HTMLButtonElement;
		this.modCtrl = document.getElementById("modCtrl") as HTMLInputElement;
		this.modShift = document.getElementById("modShift") as HTMLInputElement;
		this.modAlt = document.getElementById("modAlt") as HTMLInputElement;
		this.modMeta = document.getElementById("modMeta") as HTMLInputElement;
		this.keyResult = document.getElementById("keyResult") as HTMLElement;

		this.initializeEventListeners();
		this.setStatus('Click "Select Screen & Start Remote" to begin', false);
		this.loadScreenSize();
		this.checkClickPermission();
	}

	private initializeEventListeners() {
		this.selectScreenBtn.addEventListener("click", () => this.selectScreen());
		this.stopBtn.addEventListener("click", () =>
			this.endShare("Screen reading stopped"),
		);

		this.simulateClickBtn.addEventListener("click", () => this.simulateClick());
		this.grantAccessBtn.addEventListener("click", () =>
			this.requestClickPermission(),
		);

		this.typeTextBtn.addEventListener("click", () => this.typeText());
		this.typeTextInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") this.typeText();
		});
		this.pressKeyBtn.addEventListener("click", () => this.pressKey());
	}

	private async typeText() {
		const text = this.typeTextInput.value;
		if (!text) {
			this.setKeyResult("Enter some text to type", true);
			return;
		}

		this.typeTextBtn.disabled = true;

		try {
			await this.runCountdown(3, "Typing", (m, e) => this.setKeyResult(m, e));
			const result = await bunRpc().request.typeText({ text });
			if (result.success) {
				const skipped = result.skipped ?? [];
				if (skipped.length > 0) {
					this.setKeyResult(
						`Typed (skipped ${skipped.length} unsupported char(s))`,
						false,
					);
				} else {
					this.setKeyResult("Text typed", false);
				}
			} else {
				this.setKeyResult(result.error || "Type failed", true);
				this.maybeReRequestPermission(result.error);
			}
		} catch (error) {
			this.setKeyResult((error as Error).message, true);
		} finally {
			this.typeTextBtn.disabled = false;
		}
	}

	private async pressKey() {
		const key = this.pressKeyInput.value.trim();
		if (!key) {
			this.setKeyResult("Enter a key name", true);
			return;
		}

		const modifiers: string[] = [];
		if (this.modCtrl.checked) modifiers.push("ctrl");
		if (this.modShift.checked) modifiers.push("shift");
		if (this.modAlt.checked) modifiers.push("alt");
		if (this.modMeta.checked) modifiers.push("meta");

		this.pressKeyBtn.disabled = true;
		const combo = [...modifiers, key].join("+");

		try {
			await this.runCountdown(3, `Pressing ${combo}`, (m, e) =>
				this.setKeyResult(m, e),
			);
			const result = await bunRpc().request.pressKey({ key, modifiers });
			if (result.success) {
				this.setKeyResult(`Pressed ${combo}`, false);
			} else {
				this.setKeyResult(result.error || "Key press failed", true);
				this.maybeReRequestPermission(result.error);
			}
		} catch (error) {
			this.setKeyResult((error as Error).message, true);
		} finally {
			this.pressKeyBtn.disabled = false;
		}
	}

	private setKeyResult(message: string, error: boolean) {
		this.keyResult.textContent = message;
		this.keyResult.classList.toggle("error", error);
	}

	private maybeReRequestPermission(error?: string) {
		if ((error || "").includes("/dev/uinput")) {
			this.requestClickPermission();
		}
	}

	// Show a live countdown before performing an action, giving the user time to
	// focus the target window.
	private runCountdown(
		seconds: number,
		label: string,
		setResult: (message: string, error: boolean) => void,
	): Promise<void> {
		return new Promise((resolve) => {
			let remaining = seconds;
			setResult(`${label} in ${remaining}…`, false);
			const interval = setInterval(() => {
				remaining -= 1;
				if (remaining <= 0) {
					clearInterval(interval);
					resolve();
				} else {
					setResult(`${label} in ${remaining}…`, false);
				}
			}, 1000);
		});
	}

	// Check on startup whether we can synthesize clicks. If not, trigger the
	// elevation flow automatically (graphical password prompt via pkexec).
	private async checkClickPermission() {
		try {
			const status = await bunRpc().request.getClickStatus({});
			if (status.writable) {
				this.setPermissionGranted();
			} else {
				await this.requestClickPermission();
			}
		} catch (error) {
			console.error("Failed to check click permission:", error);
		}
	}

	private async requestClickPermission() {
		this.permissionRow.style.display = "flex";
		this.grantAccessBtn.disabled = true;
		this.permissionText.textContent = "Requesting input access…";
		this.permissionRow.classList.remove("error");

		try {
			const result = await bunRpc().request.ensureClickPermission({});
			if (result.ok) {
				this.setPermissionGranted();
			} else {
				this.permissionRow.classList.add("error");
				this.permissionText.textContent =
					result.error || "Input access not granted";
				this.grantAccessBtn.disabled = false;
			}
		} catch (error) {
			this.permissionRow.classList.add("error");
			this.permissionText.textContent = (error as Error).message;
			this.grantAccessBtn.disabled = false;
		}
	}

	private setPermissionGranted() {
		this.permissionRow.style.display = "none";
		this.permissionRow.classList.remove("error");
		this.simulateClickBtn.disabled = false;
	}

	private async loadScreenSize() {
		try {
			const { screen } = await bunRpc().request.getSystemInfo({});
			this.screenSizeLabel.textContent = `${screen.width} x ${screen.height}`;
			this.clickXInput.max = String(screen.width - 1);
			this.clickYInput.max = String(screen.height - 1);
		} catch (error) {
			this.screenSizeLabel.textContent = "unknown";
			console.error("Failed to get screen size:", error);
		}
	}

	private async simulateClick() {
		const x = Number.parseInt(this.clickXInput.value, 10);
		const y = Number.parseInt(this.clickYInput.value, 10);
		const button = this.clickButtonSelect.value as "left" | "right" | "middle";

		if (Number.isNaN(x) || Number.isNaN(y)) {
			this.setClickResult("Enter valid X and Y coordinates", true);
			return;
		}

		this.simulateClickBtn.disabled = true;

		try {
			await this.runCountdown(3, `Clicking (${x}, ${y})`, (m, e) =>
				this.setClickResult(m, e),
			);
			const result = await bunRpc().request.simulateClick({
				x,
				y,
				button,
			});
			if (result.success) {
				this.setClickResult(`Clicked ${button} at (${x}, ${y})`, false);
			} else {
				this.setClickResult(result.error || "Click failed", true);
				if ((result.error || "").includes("/dev/uinput")) {
					this.requestClickPermission();
				}
			}
		} catch (error) {
			this.setClickResult((error as Error).message, true);
		} finally {
			this.simulateClickBtn.disabled = false;
		}
	}

	private setClickResult(message: string, error: boolean) {
		this.clickResult.textContent = message;
		this.clickResult.classList.toggle("error", error);
	}

	private stopStream() {
		if (this.stream) {
			this.stream.getTracks().forEach((track) => {
				track.stop();
			});
			this.stream = null;
			this.video.srcObject = null;
		}
	}

	private async selectScreen() {
		try {
			if (
				!navigator.mediaDevices ||
				!(
					navigator.mediaDevices as MediaDevices & {
						getDisplayMedia?: typeof navigator.mediaDevices.getDisplayMedia;
					}
				).getDisplayMedia
			) {
				throw new Error("getDisplayMedia is not available in this browser.");
			}

			this.stopStream();

			this.stream = await navigator.mediaDevices.getDisplayMedia({
				video: true,
				audio: false,
			});

			this.video.srcObject = this.stream;
			this.setStatus("Screen reading active", true);
			this.selectScreenBtn.style.display = "none";
			this.stopBtn.style.display = "flex";

			const videoTracks = this.stream.getVideoTracks();
			if (videoTracks.length > 0) {
				// Fires when the user stops sharing via the OS/browser UI.
				videoTracks[0].addEventListener("ended", () =>
					this.endShare("Screen sharing stopped"),
				);
			}

			// Align the click coordinate space with the actual capture resolution
			// BEFORE the tunnel goes live, so the very first agent click is correct.
			await this.waitForVideoMetadata();
			await this.syncCaptureResolution();

			// Screen consent granted — start the remote tunnel (it's useless
			// without screenshots, so the two are tied to one action).
			this.onShareStarted?.();
		} catch (error) {
			console.error("Error selecting screen:", error);
			this.setStatus(
				`Remote control error: ${(error as Error).message}`,
				false,
			);
		}
	}

	// Stop reading the screen and tear down the tunnel. Safe to call whether the
	// stop was user-initiated (Stop button) or external (OS "stop sharing").
	private endShare(message: string) {
		if (!this.stream) return;
		this.stopStream();
		this.setStatus(message, false);
		this.selectScreenBtn.style.display = "flex";
		this.stopBtn.style.display = "none";
		this.onShareEnded?.();
	}

	// Resolve once the captured video has real dimensions (or after a timeout).
	private waitForVideoMetadata(): Promise<void> {
		if (this.video.videoWidth > 0) return Promise.resolve();
		return new Promise((resolve) => {
			const done = () => {
				this.video.removeEventListener("loadedmetadata", done);
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(done, 2000);
			this.video.addEventListener("loadedmetadata", done);
		});
	}

	// Tell the Bun process to map the virtual mouse onto the exact pixel space we
	// capture, so screenshot coordinates and click coordinates are identical.
	private async syncCaptureResolution() {
		const width = this.video.videoWidth;
		const height = this.video.videoHeight;
		if (!width || !height) return;
		try {
			await bunRpc().request.setCaptureResolution({ width, height });
			this.screenSizeLabel.textContent = `${width} x ${height}`;
			this.clickXInput.max = String(width - 1);
			this.clickYInput.max = String(height - 1);
		} catch (error) {
			console.error("Failed to sync capture resolution:", error);
		}
	}

	/** Capture the current shared-screen frame as a base64 JPEG (no data: prefix). */
	async captureScreenshotBase64(): Promise<{
		ok: boolean;
		base64?: string;
		width?: number;
		height?: number;
		error?: string;
	}> {
		if (!this.stream) {
			return {
				ok: false,
				error:
					'No screen share active. Click "Select Screen & Start Remote" in the app first.',
			};
		}
		try {
			const context = this.canvas.getContext("2d");
			if (!context) {
				return { ok: false, error: "Canvas 2D context unavailable" };
			}
			const width = this.video.videoWidth;
			const height = this.video.videoHeight;
			this.canvas.width = width;
			this.canvas.height = height;
			context.drawImage(this.video, 0, 0);
			const dataUrl = this.canvas.toDataURL("image/jpeg", 0.9);
			const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
			return { ok: true, base64, width, height };
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
	}

	private setStatus(message: string, active: boolean, error: boolean = false) {
		this.statusText.textContent = message;
		this.status.classList.toggle("active", active && !error);
		this.status.classList.toggle("error", error);
	}
}

// Wires the remote-control MCP server: builds the platform deps from the app +
// RPC, starts the tunnel, and drives the MCP status UI.
class McpPanel {
	private statusDot: HTMLElement;
	private statusText: HTMLElement;
	private urlRow: HTMLElement;
	private urlInput: HTMLInputElement;
	private copyBtn: HTMLButtonElement;
	private localToggle: HTMLInputElement;
	private ready: Promise<void> = Promise.resolve();

	constructor(private app: ScreenCaptureApp) {
		this.statusDot = document.getElementById("mcpStatusDot") as HTMLElement;
		this.statusText = document.getElementById("mcpStatusText") as HTMLElement;
		this.urlRow = document.getElementById("mcpUrlRow") as HTMLElement;
		this.urlInput = document.getElementById("mcpUrl") as HTMLInputElement;
		this.copyBtn = document.getElementById("mcpCopyBtn") as HTMLButtonElement;
		this.localToggle = document.getElementById(
			"mcpLocalMode",
		) as HTMLInputElement;

		this.copyBtn.addEventListener("click", () => this.copyUrl());
		this.localToggle.addEventListener("change", () => {
			void setMcpLocalMode(this.localToggle.checked);
		});

		// Configure the transport layer (tunnel vs. local listener) before anything
		// connects. Local-server controls are RPC calls into the Bun process.
		configureTransport({
			storage: this.buildStorage(),
			local: {
				start: () => bunRpc().request.mcpLocalServerStart({}),
				stop: async () => {
					await bunRpc().request.mcpLocalServerStop({});
				},
			},
		});

		// Transport start/stop is driven by the unified screen-share action: granting
		// consent connects the preferred transport; stopping the share disconnects it.
		this.app.onShareStarted = () => void this.connect();
		this.app.onShareEnded = () => void disconnectActiveTransport();

		subscribeMcp(() => this.render());
		this.render();
		void this.start();
	}

	private async connect() {
		await this.ready;
		await connectActiveTransport();
	}

	private buildDeps(): RemoteControlDeps {
		return {
			getSystemInfo: () => bunRpc().request.getSystemInfo({}),
			screenshot: () => this.app.captureScreenshotBase64(),
			click: (x: number, y: number, button: MouseButton) =>
				bunRpc().request.simulateClick({ x, y, button }),
			typeText: (text: string) => bunRpc().request.typeText({ text }),
			pressKey: (key: string, modifiers: string[]) =>
				bunRpc().request.pressKey({ key, modifiers }),
		};
	}

	// Persist tunnel state via the Bun process (real filesystem) so the public
	// MCP URL stays stable across app restarts — the webview's localStorage is
	// not reliably persisted in the Electrobun webview.
	private buildStorage(): IStorage {
		return {
			getItem: async (key: string) =>
				(await bunRpc().request.kvGet({ key })).value,
			setItem: async (key: string, value: string) => {
				await bunRpc().request.kvSet({ key, value });
			},
		};
	}

	private async start() {
		this.ready = (async () => {
			await bootstrapMcp(this.buildDeps(), this.buildStorage());
			await loadMcpLocalMode();
		})();
		try {
			await this.ready;
		} catch (error) {
			console.error("[mcp] bootstrap failed:", error);
			this.statusText.textContent = `MCP error: ${(error as Error).message}`;
		}
		this.render();
	}

	private async copyUrl() {
		const url = this.urlInput.value;
		if (!url) return;
		try {
			await navigator.clipboard.writeText(url);
			this.copyBtn.textContent = "Copied";
			setTimeout(() => {
				this.copyBtn.textContent = "Copy";
			}, 1500);
		} catch {
			this.urlInput.select();
		}
	}

	private render() {
		const status = getMcpStatus();
		const url = getMcpPublicUrl();

		if (this.localToggle.checked !== getMcpLocalMode()) {
			this.localToggle.checked = getMcpLocalMode();
		}

		this.statusDot.classList.toggle("connected", status === "connected");
		this.statusDot.classList.toggle("connecting", status === "connecting");
		this.statusText.textContent =
			status === "connected"
				? getMcpLocalMode()
					? "Connected (local)"
					: "Connected"
				: status === "connecting"
					? "Connecting…"
					: "Disconnected";

		if (url && status === "connected") {
			this.urlRow.style.display = "flex";
			this.urlInput.value = url;
		} else {
			this.urlRow.style.display = "none";
		}
	}
}

document.addEventListener("DOMContentLoaded", () => {
	const app = new ScreenCaptureApp();
	new McpPanel(app);
});
