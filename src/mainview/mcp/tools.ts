/**
 * Remote-control MCP tools.
 *
 * Replaces the wallet-specific `mcp-calls.ts` from the borrowed reference. Each
 * tool maps to an existing app capability: clicks/typing/keys are forwarded to
 * the Bun process over Electrobun RPC; screenshots are captured from the active
 * screen-share stream in the webview.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type MouseButton = "left" | "right" | "middle";

/** Platform capabilities the tools depend on, injected via `configureMcp`. */
export type RemoteControlDeps = {
	getScreenSize(): Promise<{ width: number; height: number }>;
	/** Capture the currently shared screen as a base64 PNG (no data: prefix). */
	screenshot(grid?: boolean): Promise<{
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

export function registerTools(mcp: McpServer, deps: RemoteControlDeps): void {
	mcp.registerTool(
		"get_screen_size",
		{
			title: "Get screen size",
			description:
				"Return the coordinate space used for both screenshots and clicks, in pixels ({ width, height }). This equals the dimensions of the image returned by `screenshot`. Click coordinates must be within 0..width-1 / 0..height-1.",
		},
		async () => {
			const size = await deps.getScreenSize();
			return jsonText(size);
		},
	);

	mcp.registerTool(
		"screenshot",
		{
			title: "Take screenshot",
			description:
				"Capture the currently shared screen as a PNG. By default a coordinate grid is overlaid (lines every 100px, bolder every 500px, labeled on every edge). The grid labels are in the EXACT pixel space used by `click`, so read target coordinates directly off the grid instead of estimating. Requires the user to have started screen sharing; returns an error otherwise.",
			inputSchema: {
				grid: z
					.boolean()
					.optional()
					.describe(
						"Overlay the coordinate grid (default true). Set false for a clean, unannotated screenshot.",
					),
			},
		},
		async ({ grid }) => {
			const shot = await deps.screenshot(grid ?? true);
			if (!shot.ok || !shot.base64) {
				return errorText(shot.error || "Screenshot failed");
			}
			const content: Array<
				| { type: "image"; data: string; mimeType: string }
				| { type: "text"; text: string }
			> = [{ type: "image", data: shot.base64, mimeType: "image/png" }];
			if (shot.width && shot.height) {
				content.push({
					type: "text",
					text: `Image is ${shot.width}x${shot.height} px. Origin (0,0) is top-left. Use these exact pixel coordinates for click(); read them off the overlaid grid (lines every 100px, labeled on every edge).`,
				});
			}
			return { content };
		},
	);

	mcp.registerTool(
		"click",
		{
			title: "Click",
			description:
				"Click the mouse at absolute pixel coordinates (origin top-left). Coordinates are in the same pixel space as `get_screen_size` and the `screenshot` grid — read them off the grid rather than estimating. Recommended flow: screenshot → read coordinates → click → screenshot again to verify.",
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
			const result = await deps.click(x, y, button ?? "left");
			if (!result.success) {
				return errorText(result.error || "Click failed");
			}
			return jsonText({ clicked: { x, y, button: button ?? "left" } });
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
