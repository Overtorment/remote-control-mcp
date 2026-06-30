import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "remote-control-mcp",
		identifier: "remotecontrolmcp.electrobun.dev",
		version: "0.0.1",
	},
	build: {
		views: {
			mainview: {
				entrypoint: "src/mainview/index.ts",
			},
		},
		copy: {
			"src/mainview/index.html": "views/mainview/index.html",
			"src/mainview/index.css": "views/mainview/index.css",
		},
		mac: {
			bundleCEF: false,
			codesign: true,
		},
		linux: {
			bundleCEF: true,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
