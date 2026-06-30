# Remote Control MCP (Electrobun)

A **desktop remote-control MCP server** built with
[Electrobun](https://electrobun.dev). It captures a user-selected screen and
exposes mouse/keyboard control + screenshots as an **MCP (Model Context Protocol)
server**, reachable from anywhere through a WebSocket tunnel — so external agents
and tools can drive the machine.

> Native input simulation currently targets **Linux** (via `/dev/uinput`).
> See [Setup & permissions](#setup--permissions).

> Working on this codebase with an AI agent? Read **[AGENTS.md](./AGENTS.md)** first —
> it documents the architecture and the non-obvious gotchas.

## Features

- **Screen capture** — pick a display via the Web `getDisplayMedia` API and take PNG screenshots.
- **Synthetic mouse** — click at absolute pixel coordinates (left/right/middle).
- **Synthetic keyboard** — type text (with human-like timing) and press named keys with modifiers.
- **Remote MCP server** — 5 tools (`get_system_info`, `screenshot`, `click`, `type_text`, `press_key`)
  exposed over a WebSocket tunnel with a stable public URL.
- **In-app test panel** — exercise clicks/typing/keys locally before going remote.

## Architecture (short version)

Electrobun runs two processes that talk over RPC:

- **Bun process** (`src/bun/`) — OS access: `/dev/uinput` (FFI), `xrandr`, persistent storage.
- **Webview** (`src/mainview/`) — UI, screenshots, and the **MCP server + WebSocket tunnel client**.

Native actions are forwarded from the webview to Bun via RPC; screenshots are
captured in the webview from the active screen-share stream. Full detail and the
data-flow diagram live in [AGENTS.md](./AGENTS.md).

```
src/
├── bun/
│   ├── index.ts      # RPC schema + handlers, window, screen-size detection, KV store
│   └── uinput.ts     # FFI → /dev/uinput: VirtualMouse + VirtualKeyboard
└── mainview/
    ├── index.html    # UI
    ├── index.css
    ├── index.ts      # ScreenCaptureApp + McpPanel
    └── mcp/          # tunnel client + MCP server bridge + tool definitions
```

## Getting started

```bash
bun install
bun start            # run (electrobun dev)
bun dev              # run with file watching
bun run build:canary # build / verify it compiles
```

In the app, click **Select Screen & Start Remote**, choose a display, and the
Remote MCP panel will show the public URL once the tunnel connects.

## Setup & permissions

Input simulation creates kernel-level virtual devices through `/dev/uinput`, which
is root-only by default. On startup the app offers to grant access via `pkexec`
(graphical password prompt), running:

```bash
chmod 666 /dev/uinput
```

This is **session-only** (does not survive reboot). Manual equivalent:

```bash
sudo chmod 666 /dev/uinput
```

Do **not** run the whole app with `sudo`.

## Remote control via MCP

The app exposes a [Streamable HTTP](https://modelcontextprotocol.io) MCP endpoint
at the public tunnel URL. Tools:

| Tool              | Description |
|-------------------|-------------|
| `get_system_info` | Host details: screen size (the click coordinate space), OS/distro, kernel, arch, session (Wayland/X11), hostname, time. |
| `screenshot`      | PNG of the shared screen (requires active screen sharing). |
| `click`           | Click at absolute pixel `x,y` (`button`: left/right/middle). |
| `type_text`       | Type a string (US layout; non-ASCII skipped + reported). |
| `press_key`       | Press a named key / char, optional `ctrl/shift/alt/meta`. |

### Smoke test

`smoke-mcp.sh` drives a demo sequence (click → type "chrome" → down → enter):

```bash
./smoke-mcp.sh 'https://layerz.me:4433/mcp/<session>'
# or
MCP_URL='https://layerz.me:4433/mcp/<session>' ./smoke-mcp.sh
```

Paste the URL from the app's **Remote MCP** panel.

## Security considerations

- Screen sharing requires explicit user consent; the tunnel only connects after consent.
- Once connected, the public URL lets remote clients control mouse/keyboard and read the
  screen — treat it like a remote-access credential and disconnect when not in use.
- The tunnel never autostarts; it is tied to the screen-selection action.

## Notes

- US QWERTY keyboard layout assumed for synthetic typing.
- Tunnel server: `wss://layerz.me:4433/connect` (already deployed; configurable in `tunnel.ts`).
