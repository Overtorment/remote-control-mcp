import { Buffer } from "buffer";
// The borrowed MCP/tunnel modules use Node's Buffer; provide it in the webview.
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;

import Electrobun, { Electroview } from "electrobun/view";
import type { PhotoBoothRPC } from "../bun/index";
import { bootstrapMcp } from "./mcp/bootstrap";
import {
	connectTunnel,
	disconnectTunnel,
	getTunnelConnectionStatus,
	getTunnelPublicUrl,
	subscribeTunnelConnection,
} from "./mcp/bootstrap";
import type { MouseButton, RemoteControlDeps } from "./mcp/tools";
import type { IStorage } from "./mcp/tunnel-types";

const rpc = Electroview.defineRPC<PhotoBoothRPC>({
	maxRequestTime: 120000,
	handlers: {
		requests: {},
		messages: {},
	},
});

const electrobun = new Electrobun.Electroview({ rpc });

interface Screenshot {
	id: string;
	dataUrl: string;
	timestamp: Date;
}

class ScreenCaptureApp {
	private video: HTMLVideoElement;
	private canvas: HTMLCanvasElement;
	private captureBtn: HTMLButtonElement;
	private gallery: HTMLElement;
	private timerToggle: HTMLInputElement;
	private selectScreenBtn: HTMLButtonElement;
	private status: HTMLElement;
	private statusText: HTMLElement;
	private countdown: HTMLElement;
	private modal: HTMLElement;
	private modalImage: HTMLImageElement;

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
	private screenshots: Screenshot[] = [];
	private currentScreenshotId: string | null = null;

	/** Fired after the user grants screen-share consent. */
	onShareStarted?: () => void;
	/** Fired when screen sharing stops (user or system). */
	onShareEnded?: () => void;

	constructor() {
		this.video = document.getElementById("video") as HTMLVideoElement;
		this.canvas = document.getElementById("canvas") as HTMLCanvasElement;
		this.captureBtn = document.getElementById(
			"captureBtn",
		) as HTMLButtonElement;
		this.gallery = document.getElementById("gallery") as HTMLElement;
		this.timerToggle = document.getElementById(
			"timerToggle",
		) as HTMLInputElement;
		this.selectScreenBtn = document.getElementById(
			"selectScreenBtn",
		) as HTMLButtonElement;
		this.status = document.getElementById("status") as HTMLElement;
		this.statusText = this.status.querySelector(".status-text") as HTMLElement;
		this.countdown = document.getElementById("countdown") as HTMLElement;
		this.modal = document.getElementById("photoModal") as HTMLElement;
		this.modalImage = document.getElementById("modalImage") as HTMLImageElement;
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
		this.captureBtn.addEventListener("click", () => this.captureScreenshot());
		this.selectScreenBtn.addEventListener("click", () => this.selectScreen());

		document
			.getElementById("modalClose")
			?.addEventListener("click", () => this.closeModal());
		document
			.getElementById("downloadBtn")
			?.addEventListener("click", () => this.saveCurrentScreenshot());
		document
			.getElementById("deleteBtn")
			?.addEventListener("click", () => this.deleteCurrentScreenshot());

		this.modal.addEventListener("click", (e) => {
			if (e.target === this.modal) {
				this.closeModal();
			}
		});

		this.simulateClickBtn.addEventListener("click", () =>
			this.simulateClick(),
		);
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
			await this.runCountdown(3, "Typing", (m, e) =>
				this.setKeyResult(m, e),
			);
			const result = await electrobun.rpc!.request.typeText({ text });
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
			const result = await electrobun.rpc!.request.pressKey({ key, modifiers });
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
			const status = await electrobun.rpc!.request.getClickStatus({});
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
			const result = await electrobun.rpc!.request.ensureClickPermission({});
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
			const size = await electrobun.rpc!.request.getScreenSize({});
			this.screenSizeLabel.textContent = `${size.width} x ${size.height}`;
			this.clickXInput.max = String(size.width - 1);
			this.clickYInput.max = String(size.height - 1);
		} catch (error) {
			this.screenSizeLabel.textContent = "unknown";
			console.error("Failed to get screen size:", error);
		}
	}

	private async simulateClick() {
		const x = Number.parseInt(this.clickXInput.value, 10);
		const y = Number.parseInt(this.clickYInput.value, 10);
		const button = this.clickButtonSelect.value as
			| "left"
			| "right"
			| "middle";

		if (Number.isNaN(x) || Number.isNaN(y)) {
			this.setClickResult("Enter valid X and Y coordinates", true);
			return;
		}

		this.simulateClickBtn.disabled = true;

		try {
			await this.runCountdown(3, `Clicking (${x}, ${y})`, (m, e) =>
				this.setClickResult(m, e),
			);
			const result = await electrobun.rpc!.request.simulateClick({
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
			this.stream.getTracks().forEach((track) => track.stop());
			this.stream = null;
			this.video.srcObject = null;
		}
	}

	private async selectScreen() {
		try {
			if (
				!navigator.mediaDevices ||
				!(navigator.mediaDevices as MediaDevices & { getDisplayMedia?: typeof navigator.mediaDevices.getDisplayMedia }).getDisplayMedia
			) {
				throw new Error(
					"getDisplayMedia is not available in this browser.",
				);
			}

			this.stopStream();

			this.stream = await navigator.mediaDevices.getDisplayMedia({
				video: true,
				audio: false,
			});

			this.video.srcObject = this.stream;
			this.setStatus("Screen capture active - ready to take screenshots", true);
			this.captureBtn.disabled = false;
			this.selectScreenBtn.style.display = "none";

			const videoTracks = this.stream.getVideoTracks();
			if (videoTracks.length > 0) {
				videoTracks[0].addEventListener("ended", () => {
					this.setStatus("Screen sharing stopped", false);
					this.captureBtn.disabled = true;
					this.selectScreenBtn.style.display = "flex";
					this.stream = null;
					this.onShareEnded?.();
				});
			}

			// Screen consent granted — start the remote tunnel (it's useless
			// without screenshots, so the two are tied to one action).
			this.onShareStarted?.();
		} catch (error) {
			console.error("Error selecting screen:", error);
			this.setStatus(
				`Screen capture error: ${(error as Error).message}`,
				false,
			);
		}
	}

	private async captureScreenshot() {
		if (!this.stream) {
			this.setStatus(
				"No screen capture stream available. Select a screen first.",
				false,
			);
			return;
		}

		try {
			if (this.timerToggle.checked) {
				await this.showCountdown();
			}

			const context = this.canvas.getContext("2d");
			if (!context) return;

			this.canvas.width = this.video.videoWidth;
			this.canvas.height = this.video.videoHeight;
			context.drawImage(this.video, 0, 0);

			const dataUrl = this.canvas.toDataURL("image/png");

			const screenshot: Screenshot = {
				id: Date.now().toString(),
				dataUrl,
				timestamp: new Date(),
			};

			this.screenshots.push(screenshot);
			this.addScreenshotToGallery(screenshot);
			this.setStatus("Screenshot captured!", true);
			this.playCaptureFeedback();
		} catch (error) {
			console.error("Error capturing screenshot:", error);
			this.setStatus(`Screenshot failed: ${(error as Error).message}`, false);
		}
	}

	/** Capture the current shared-screen frame as a base64 PNG (no data: prefix). */
	async captureScreenshotBase64(): Promise<{
		ok: boolean;
		base64?: string;
		error?: string;
	}> {
		if (!this.stream) {
			return {
				ok: false,
				error:
					"No screen capture stream available. Start screen sharing in the app first.",
			};
		}
		try {
			const context = this.canvas.getContext("2d");
			if (!context) {
				return { ok: false, error: "Canvas 2D context unavailable" };
			}
			this.canvas.width = this.video.videoWidth;
			this.canvas.height = this.video.videoHeight;
			context.drawImage(this.video, 0, 0);
			const dataUrl = this.canvas.toDataURL("image/png");
			const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, "");
			return { ok: true, base64 };
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
	}

	private async showCountdown() {
		for (let i = 3; i > 0; i--) {
			this.countdown.textContent = i.toString();
			this.countdown.style.display = "flex";
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		this.countdown.style.display = "none";
	}

	private playCaptureFeedback() {
		document.body.style.backgroundColor = "white";
		setTimeout(() => {
			document.body.style.backgroundColor = "";
		}, 100);
	}

	private addScreenshotToGallery(screenshot: Screenshot) {
		const emptyState = this.gallery.querySelector(".empty-state");
		if (emptyState) {
			emptyState.remove();
		}

		const item = document.createElement("div");
		item.className = "photo-item";
		item.dataset["photoId"] = screenshot.id;

		item.innerHTML = `
            <img src="${screenshot.dataUrl}" alt="Captured screenshot">
            <div class="photo-info">
                <span class="photo-type">🖥️</span>
                <span class="photo-time">${screenshot.timestamp.toLocaleTimeString()}</span>
            </div>
        `;

		item.addEventListener("click", () => this.openModal(screenshot.id));
		this.gallery.insertBefore(item, this.gallery.firstChild);
	}

	private openModal(screenshotId: string) {
		const screenshot = this.screenshots.find((s) => s.id === screenshotId);
		if (!screenshot) return;

		this.currentScreenshotId = screenshotId;
		this.modalImage.src = screenshot.dataUrl;
		this.modal.style.display = "flex";
	}

	private closeModal() {
		this.modal.style.display = "none";
		this.currentScreenshotId = null;
	}

	private async saveCurrentScreenshot() {
		if (!this.currentScreenshotId) return;

		const screenshot = this.screenshots.find(
			(s) => s.id === this.currentScreenshotId,
		);
		if (!screenshot) return;

		try {
			const filename = `screenshot-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, "-")}.png`;
			const result = await electrobun.rpc!.request.savePhoto({
				dataUrl: screenshot.dataUrl,
				filename,
			});

			if (result.success) {
				this.showStatus("Screenshot saved successfully!", "success");
				if (result.path) {
					console.log("Screenshot saved to:", result.path);
				}
			} else if (result.reason === "canceled") {
				this.showStatus("Save canceled", "info");
			} else {
				this.showStatus("Failed to save screenshot", "error");
			}
		} catch (error) {
			console.error("Error saving screenshot:", error);
			this.showStatus("Error saving screenshot", "error");
		}
	}

	private deleteCurrentScreenshot() {
		if (!this.currentScreenshotId) return;

		const index = this.screenshots.findIndex(
			(s) => s.id === this.currentScreenshotId,
		);
		if (index === -1) return;

		this.screenshots.splice(index, 1);

		const element = this.gallery.querySelector(
			`[data-photo-id="${this.currentScreenshotId}"]`,
		);
		if (element) {
			element.remove();
		}

		if (this.screenshots.length === 0) {
			this.gallery.innerHTML = `
                <div class="empty-state">
                    No screenshots yet. Select a screen and click capture to get started!
                </div>
            `;
		}

		this.closeModal();
		this.showStatus("Screenshot deleted", "info");
	}

	private setStatus(message: string, active: boolean, error: boolean = false) {
		this.statusText.textContent = message;
		this.status.classList.toggle("active", active && !error);
		this.status.classList.toggle("error", error);
	}

	private showStatus(message: string, type: "success" | "error" | "info") {
		console.log(`[${type}] ${message}`);

		const originalText = this.statusText.textContent;
		const originalClasses = this.status.className;

		this.setStatus(message, type === "success", type === "error");

		setTimeout(() => {
			this.statusText.textContent = originalText;
			this.status.className = originalClasses;
		}, 3000);
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
	private ready: Promise<void> = Promise.resolve();

	constructor(private app: ScreenCaptureApp) {
		this.statusDot = document.getElementById("mcpStatusDot") as HTMLElement;
		this.statusText = document.getElementById("mcpStatusText") as HTMLElement;
		this.urlRow = document.getElementById("mcpUrlRow") as HTMLElement;
		this.urlInput = document.getElementById("mcpUrl") as HTMLInputElement;
		this.copyBtn = document.getElementById("mcpCopyBtn") as HTMLButtonElement;

		this.copyBtn.addEventListener("click", () => this.copyUrl());

		// Tunnel start/stop is driven by the unified screen-share action: granting
		// consent connects the tunnel; stopping the share disconnects it.
		this.app.onShareStarted = () => void this.connect();
		this.app.onShareEnded = () => void disconnectTunnel();

		subscribeTunnelConnection(() => this.render());
		this.render();
		void this.start();
	}

	private async connect() {
		await this.ready;
		await connectTunnel();
	}

	private buildDeps(): RemoteControlDeps {
		return {
			getScreenSize: () => electrobun.rpc!.request.getScreenSize({}),
			screenshot: () => this.app.captureScreenshotBase64(),
			click: (x: number, y: number, button: MouseButton) =>
				electrobun.rpc!.request.simulateClick({ x, y, button }),
			typeText: (text: string) => electrobun.rpc!.request.typeText({ text }),
			pressKey: (key: string, modifiers: string[]) =>
				electrobun.rpc!.request.pressKey({ key, modifiers }),
		};
	}

	// Persist tunnel state via the Bun process (real filesystem) so the public
	// MCP URL stays stable across app restarts — the webview's localStorage is
	// not reliably persisted in the Electrobun webview.
	private buildStorage(): IStorage {
		return {
			getItem: async (key: string) =>
				(await electrobun.rpc!.request.kvGet({ key })).value,
			setItem: async (key: string, value: string) => {
				await electrobun.rpc!.request.kvSet({ key, value });
			},
		};
	}

	private async start() {
		this.ready = bootstrapMcp(this.buildDeps(), this.buildStorage());
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
		const status = getTunnelConnectionStatus();
		const url = getTunnelPublicUrl();

		this.statusDot.classList.toggle("connected", status === "connected");
		this.statusDot.classList.toggle("connecting", status === "connecting");
		this.statusText.textContent =
			status === "connected"
				? "Connected"
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
