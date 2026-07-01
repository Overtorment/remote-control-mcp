/**
 * Remote-control MCP tools.
 *
 * Each tool maps to an existing app capability: clicks/typing/keys are forwarded to
 * the Bun process over Electrobun RPC; screenshots are captured from the active
 * screen-share stream in the webview.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export type MouseButton = "left" | "right" | "middle";

/** Host system details surfaced to the agent via `get_system_info`. */
export type SystemInfo = {
	/** The pixel coordinate space for screenshots and clicks. */
	screen: { width: number; height: number };
	os: {
		platform: string;
		distro: string;
		version: string;
		kernel: string;
		arch: string;
	};
	session: {
		/** `wayland` | `x11` | "" */
		type: string;
		/** Desktop environment, e.g. `pantheon`, `GNOME`. */
		desktop: string;
	};
	hostname: string;
	keyboardLayout: string;
	inputMethod: string;
	time: { iso: string; timezone: string };
};

/** Platform capabilities the tools depend on, injected via `configureMcp`. */
export type RemoteControlDeps = {
	getSystemInfo(): Promise<SystemInfo>;
	/** Capture the currently shared screen as a base64 JPEG (no data: prefix). */
	screenshot(): Promise<{
		ok: boolean;
		base64?: string;
		width?: number;
		height?: number;
		error?: string;
	}>;
	click(
		x: number,
		y: number,
		button: MouseButton,
	): Promise<{ success: boolean; error?: string }>;
	typeText(
		text: string,
	): Promise<{ success: boolean; skipped?: string[]; error?: string }>;
	pressKey(
		key: string,
		modifiers: string[],
	): Promise<{ success: boolean; error?: string }>;
};

function jsonText(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data) }],
	};
}

function errorText(message: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		isError: true as const,
	};
}

type ScreenshotResult = Awaited<ReturnType<RemoteControlDeps["screenshot"]>>;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function screenshotResponse(shot: ScreenshotResult, prefix?: string) {
	if (!shot.ok || !shot.base64) {
		return errorText(shot.error || "Screenshot failed");
	}
	const content: Array<
		| { type: "image"; data: string; mimeType: string }
		| { type: "text"; text: string }
	> = [{ type: "image", data: shot.base64, mimeType: "image/jpeg" }];
	if (shot.width && shot.height) {
		const dims = `Image is ${shot.width}x${shot.height} px. Origin (0,0) is top-left.`;
		content.push({ type: "text", text: prefix ? `${prefix} ${dims}` : dims });
	} else if (prefix) {
		content.push({ type: "text", text: prefix });
	}
	return { content };
}

export function registerTools(mcp: McpServer, deps: RemoteControlDeps): void {
	mcp.registerTool(
		"get_system_info",
		{
			title: "Get system info",
			description:
				"Return information about the host machine: `screen` size in pixels, OS/distro and kernel, CPU architecture, desktop session (Wayland/X11 + environment), hostname, assumed keyboard layout, input method, and local time/timezone. Call this first — `screen.width`/`screen.height` define the click bounds (0..width-1 / 0..height-1) and equal the dimensions of the image returned by `screenshot`.",
		},
		async () => {
			const info = await deps.getSystemInfo();
			return jsonText(info);
		},
	);

	mcp.registerTool(
		"screenshot",
		{
			title: "Take screenshot",
			description:
				"Capture the currently shared screen as a JPEG (90% quality). When clicking, aim for the exact center of the target element." +
				"Screenshots are returned inline (as base64) with the response, and can be several megabytes." +
				"If you are using `mcporter` always use `--save-images <dir>` to actually save the images to a directory." +
				"If you need to show images to the user make sure images are not outside of the allowed directory." +
				'When providing screenshots to a model for computer vision always use `detail: "original"` or similar setting to provide image without any additional processing.',
		},
		async () => {
			const shot = await deps.screenshot();
			return screenshotResponse(shot);
		},
	);

	mcp.registerTool(
		"click",
		{
			title: "Click",
			description:
				"Click the mouse at absolute pixel coordinates (origin top-left). Coordinates are in the same pixel space as `get_system_info`'s screen and `screenshot`. After clicking, waits 500ms and returns a screenshot (same format as the `screenshot` tool)." +
				"Not all actions execute that quickly, so you may need to wait longer to get a screenshot of the result." +
				"Screenshots are returned inline (as base64) with the response, and can be several megabytes." +
				"If you are using `mcporter` always use `--save-images <dir>` to actually save the images to a directory." +
				"If you need to show images to the user make sure images are not outside of the allowed directory." +
				'When providing screenshots to a model for computer vision always use `detail: "original"` or similar setting to provide image without any additional processing.',
			inputSchema: {
				x: z.number().int().describe("X coordinate in pixels (0 = left edge)"),
				y: z.number().int().describe("Y coordinate in pixels (0 = top edge)"),
				button: z
					.enum(["left", "right", "middle"])
					.optional()
					.describe("Mouse button to click. Defaults to left."),
			},
		},
		async ({ x, y, button }) => {
			const btn = button ?? "left";
			const result = await deps.click(x, y, btn);
			if (!result.success) {
				return errorText(result.error || "Click failed");
			}
			await sleep(500);
			const shot = await deps.screenshot();
			return screenshotResponse(shot, `Clicked ${btn} at (${x}, ${y}).`);
		},
	);

	mcp.registerTool(
		"type_text",
		{
			title: "Type text",
			description:
				"Type a string using a virtual keyboard (US layout). Non-ASCII characters are skipped and reported.",
			inputSchema: {
				text: z.string().describe("The text to type."),
			},
		},
		async ({ text }) => {
			const result = await deps.typeText(text);
			if (!result.success) {
				return errorText(result.error || "Type failed");
			}
			return jsonText({ typed: text.length, skipped: result.skipped ?? [] });
		},
	);

	mcp.registerTool(
		"press_key",
		{
			title: "Press key",
			description:
				"Press a named key (e.g. enter, tab, esc, f5, up/down/left/right) or a single character, optionally with modifiers.",
			inputSchema: {
				key: z
					.string()
					.describe("Key name (e.g. 'enter', 'f5') or single character."),
				modifiers: z
					.array(z.enum(["ctrl", "shift", "alt", "meta"]))
					.optional()
					.describe("Modifier keys to hold, e.g. ['ctrl'] for Ctrl+C."),
			},
		},
		async ({ key, modifiers }) => {
			const result = await deps.pressKey(key, modifiers ?? []);
			if (!result.success) {
				return errorText(result.error || "Key press failed");
			}
			return jsonText({ pressed: { key, modifiers: modifiers ?? [] } });
		},
	);
}
