#!/usr/bin/env bun
/**
 * Ask GPT-5.4 about a local screenshot (OpenAI Responses API, detail: original).
 *
 * Usage:
 *   OPENAI_API_KEY=sk-... bun scripts/ask-screenshot.ts <image-path> "<prompt>"
 *
 * Optional env:
 *   OPENAI_MODEL   — default gpt-5.4
 *   OPENAI_BASE_URL — default https://api.openai.com/v1
 */

import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

function usage(): never {
	console.error(
		`Usage: OPENAI_API_KEY=sk-... bun scripts/ask-screenshot.ts <image-path> "<prompt>"`,
	);
	process.exit(1);
}

function mimeFor(path: string): string {
	const mime = MIME_BY_EXT[extname(path).toLowerCase()];
	if (!mime) {
		throw new Error(
			`Unsupported image type "${extname(path)}". Use png, jpg, jpeg, webp, or gif.`,
		);
	}
	return mime;
}

function extractOutputText(body: {
	output_text?: string;
	output?: Array<{
		type?: string;
		content?: Array<{ type?: string; text?: string }>;
	}>;
}): string {
	if (body.output_text?.trim()) {
		return body.output_text.trim();
	}
	const chunks: string[] = [];
	for (const item of body.output ?? []) {
		if (item.type !== "message") continue;
		for (const part of item.content ?? []) {
			if (part.type === "output_text" && part.text) {
				chunks.push(part.text);
			}
		}
	}
	return chunks.join("\n").trim();
}

const imagePath = process.argv[2];
const prompt = process.argv[3];
if (!imagePath || !prompt) {
	usage();
}

const apiKey = process.env.OPENAI_API_KEY?.trim();
if (!apiKey) {
	console.error("Missing OPENAI_API_KEY environment variable.");
	process.exit(1);
}

const model = process.env.OPENAI_MODEL?.trim() || "gpt-5.4-mini";
const baseUrl =
	process.env.OPENAI_BASE_URL?.trim().replace(/\/$/, "") ||
	"https://api.openai.com/v1";

const resolved = resolve(imagePath);
const mime = mimeFor(resolved);
const base64 = readFileSync(resolved).toString("base64");
const imageUrl = `data:${mime};base64,${base64}`;

const response = await fetch(`${baseUrl}/responses`, {
	method: "POST",
	headers: {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
	},
	body: JSON.stringify({
		model,
		input: [
			{
				role: "user",
				content: [
					{ type: "input_text", text: prompt },
					{
						type: "input_image",
						image_url: imageUrl,
						detail: "original",
					},
				],
			},
		],
	}),
});

const body = (await response.json()) as {
	error?: { message?: string };
	output_text?: string;
	output?: Array<{
		type?: string;
		content?: Array<{ type?: string; text?: string }>;
	}>;
};

if (!response.ok) {
	const message =
		body.error?.message ?? `OpenAI API error (HTTP ${response.status})`;
	console.error(message);
	process.exit(1);
}

const text = extractOutputText(body);
if (!text) {
	console.error("Model returned no text output.");
	console.error(JSON.stringify(body, null, 2));
	process.exit(1);
}

console.log(text);
