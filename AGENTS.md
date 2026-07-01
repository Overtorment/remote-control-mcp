# AGENTS.md

Orientation for AI agents working on this repo. Read this first — it captures the
architecture, the non-obvious gotchas, and the conventions that aren't visible
from any single file.

## What this app is

A **desktop remote-control MCP server** built on [Electrobun](https://electrobun.dev).
It captures a user-selected display and exposes mouse/keyboard control plus
screenshots to external agents via MCP:

- **Screen capture** of a user-selected display (via the Web `getDisplayMedia` API).
- **Synthetic mouse/keyboard input** on Linux via `/dev/uinput` (FFI, no extra binaries).
- **A remote MCP server** (Model Context Protocol) exposed to the outside world
  through a **WebSocket tunnel** so external agents/clients can drive the machine.

## Process model (read this before editing anything)

Electrobun splits into two runtimes that talk over **RPC**:

- **Bun process** (`src/bun/`) — the main/Node-like process. Has full OS access:
  spawns `xrandr`, opens `/dev/uinput` via FFI, persists files. This is where all
  *native* capability lives.
- **Webview** (`src/mainview/`) — the renderer (a web page). Has browser APIs
  (`getDisplayMedia`, `WebSocket`, canvas) but **no OS access**. This is where the
  UI, screenshots, and the **MCP server + tunnel client** live.

Key architectural decision: **the MCP server and the WebSocket tunnel run in the
webview, NOT in the Bun process.** Native actions (click/type/key) are forwarded
from the webview to Bun over RPC. Screenshots are captured directly in the webview
from the active `getDisplayMedia` stream.

```
External MCP client
      │  HTTPS (Streamable HTTP)
      ▼
wss://layerz.me:4433  (relay/tunnel server — already deployed)
      │  WebSocket
      ▼
Webview (src/mainview)              Bun process (src/bun)
  ├─ tunnel.ts  (WS client) ──┐
  ├─ mcp.ts     (MCP bridge)  │  Electrobun RPC
  ├─ tools.ts   (5 tools) ────┼───────────────────▶ uinput.ts (FFI → /dev/uinput)
  └─ getDisplayMedia stream   │                     xrandr (screen size)
     (screenshot)             └───────────────────▶ KV store (session id persistence)
```

## File map

```
src/
├── bun/
│   ├── index.ts             # Main process: RPC schema + handlers, window, KV store, screen-size detection
│   ├── local-mcp-server.ts  # "Closed circuit" local HTTP MCP listener (borrowed from reference)
│   └── uinput.ts            # FFI bindings to libc → /dev/uinput. VirtualMouse + VirtualKeyboard + permission helpers
└── mainview/
    ├── index.html      # UI: screen-select, remote-control test panel, MCP status panel + local-mode toggle
    ├── index.css       # Styling
    ├── index.ts        # ScreenCaptureApp (UI logic) + McpPanel (wires MCP to UI + share lifecycle)
    └── mcp/
        ├── tunnel-types.ts  # Shared interfaces (borrowed verbatim from reference project)
        ├── tunnel.ts        # WebSocket tunnel client: connect/reconnect, session resume, heartbeats
        ├── transport.ts     # Transport selector: public tunnel vs. local listener (borrowed from tunnel-desktop.ts)
        ├── mcp.ts           # MCP server/session/transport bridge (borrowed, adapted)
        ├── instructions.ts  # Human-readable MCP server instructions
        ├── tools.ts         # The 5 remote-control MCP tools + RemoteControlDeps interface
        └── bootstrap.ts     # Wires deps + storage, starts tunnel (allowAutoConnect: false)
smoke-mcp.sh            # End-to-end MCP smoke test over the public tunnel URL
```

The `mcp/` folder (except `tools.ts` and `instructions.ts`) was **borrowed as close
to verbatim as possible** from the reference project at
`/home/bigboss/Code/layerzwallet/desktop`. Tunnel server source lives at
`/home/bigboss/Code/layerzwallet/mcp-websocket-tunnel`. Prefer keeping borrowed
files close to the original to ease future re-syncs.

## Commands

```bash
bun install          # install deps
bun start            # electrobun dev  (run once)
bun dev              # electrobun dev --watch  (rebuild on change)
bun run build:canary # electrobun build --env=canary  (use to verify it compiles/bundles)
bun run check        # biome lint + format check
bun run check:fix    # biome auto-fix (format, imports, safe lint fixes)
bun run lint         # biome lint only
bun run format       # biome format --write
```

There is **no test suite**. To verify a change compiles, run `bun run build:canary`
(exit code 0 = good). Run `bun run check` for lint/format. To verify runtime
behaviour end-to-end, see `smoke-mcp.sh`.

## The 5 MCP tools (`src/mainview/mcp/tools.ts`)

| Tool              | Backed by                                  | Notes |
|-------------------|--------------------------------------------|-------|
| `get_system_info` | RPC `getSystemInfo` → `os`/`/etc/os-release`/env | Returns `{ screen, os, session, hostname, keyboardLayout, inputMethod, time }`. `screen` is the capture resolution and the click space (`0..w-1 / 0..h-1`). `SystemInfo` type lives in `tools.ts`. |
| `screenshot`      | Webview `getDisplayMedia` stream → canvas  | **Requires the user to have started screen sharing**; errors otherwise. Returns JPEG (90% quality). |
| `click`           | RPC `simulateClick` → `VirtualMouse`       | Absolute pixel coords, origin top-left. |
| `type_text`       | RPC `typeText` → `VirtualKeyboard`         | US layout only; non-ASCII chars are skipped + reported. |
| `press_key`       | RPC `pressKey` → `VirtualKeyboard`         | Named keys (`enter`,`tab`,`f5`,`up`…) or a char, optional modifiers `ctrl/shift/alt/meta`. |

To add a tool: register it in `tools.ts`, extend `RemoteControlDeps`, wire the dep
in `McpPanel.buildDeps()` (`src/mainview/index.ts`) to either an RPC call or a
webview capability, and — if it needs native access — add the RPC request to the
schema and a handler in `src/bun/index.ts`.

## Critical gotchas (these cost real debugging time)

### 1. Linux / Wayland input simulation uses `/dev/uinput` via FFI
This is a **Wayland + Pantheon** environment. Wayland's security model blocks most
userspace input injection, so we create kernel-level virtual input devices through
`/dev/uinput` using `bun:ffi` against `libc.so.6` (`open`/`ioctl`/`write`/`close`).
No external tools (`xdotool`/`ydotool`) are required. This is **Linux-only**; the
template's macOS scaffolding remains but uinput won't work off Linux.

### 2. `/dev/uinput` needs write permission
The device is root-only by default. On startup the webview calls RPC
`getClickStatus`; if not writable it calls `ensureClickPermission`, which runs
`pkexec chmod 666 /dev/uinput` (graphical password prompt). **This is session-only
and does not survive reboot** (intentional — the user asked to keep it simple).
Manual fallback: `sudo chmod 666 /dev/uinput`. Do **not** run the whole app with
`sudo`. If you see `Cannot open /dev/uinput`, this is the cause.

### 3. Absolute-pointer "click lands at the wrong place" bug
The kernel caches the virtual device's last `ABS_X`/`ABS_Y` and **suppresses
duplicate values**. After the *physical* mouse moves, the virtual device's cached
position is stale, so re-emitting the same coordinate emits nothing → cursor
doesn't move → the click lands wherever the physical mouse left it. Fix (already in
`VirtualMouse.moveAbsolute`): **nudge to a 1px-different position first, then emit
the exact target**, forcing a real delta every time, plus ~40ms settle before the
button press. Don't "simplify" this back into a single emit.

### 3b. Click coordinate space is unified to the CAPTURE resolution (don't break this)
Vision agents misclick when the screenshot they see and the click space differ.
Browsers frequently **downscale** `getDisplayMedia` video (e.g. a 1920×1200 desktop
captured as ~1422×888), which silently offsets every click. Fix in place:
- The agent works entirely in **screenshot pixel space**. `screenshot`,
  `get_system_info`'s `screen`, and `click` all share that one space.
- On share start, the webview reads `video.videoWidth/Height` and calls RPC
  `setCaptureResolution`, which sets the `VirtualMouse` absolute axis range to those
  dims. libinput **normalizes** a uinput abs device's `[0, max]` range onto the full
  output, so matching the range to the captured pixel space makes clicks land 1:1
  regardless of downscaling. (This is why the abs max value need not equal the real
  screen pixels — see gotcha #3.)
- `screenshot` returns the image dims as a text block alongside the JPEG.
Don't reintroduce a second coordinate system (e.g. clicking against xrandr dims while
screenshotting the video frame) — that's the original misclick bug.

### 4. RPC `maxRequestTime` is 120s (not the default)
`typeText` uses **human-like randomized delays** between keystrokes
(`humanKeyDelay`), so long strings can take many seconds. The RPC timeout in
`src/bun/index.ts` was raised to `120000` to avoid spurious timeouts. Keep it high.

### 5. Session-id persistence lives in the Bun process, not the webview
Webview `localStorage` does **not** reliably persist across Electrobun restarts, so
the MCP tunnel **session id** (which keeps the public URL stable across restarts)
is stored in a **file-backed KV store in the Bun process** and accessed from the
webview via RPC `kvGet`/`kvSet`. File: `$XDG_CONFIG_HOME/remote-control-mcp/storage.json`
(falls back to `~/.config/...`). If the public URL changes on every restart, this
plumbing is broken.

### 6. The tunnel does NOT autostart, and is unified with screen selection
`bootstrap.ts` calls `startTunnel({ allowAutoConnect: false })` — the tunnel never
opens on launch. The single **"Select Screen & Start Remote"** button drives both:
granting screen-share consent fires `ScreenCaptureApp.onShareStarted` →
`connectTunnel()`. Stopping the share fires `onShareEnded` → `disconnectTunnel()`
(a tunnel is useless without screenshots, so they're deliberately tied together).
The standalone MCP connect/disconnect buttons were removed.

### 6b. Two transports: public tunnel vs. "closed circuit" local listener
A checkbox ("Local only (closed circuit)") in the Remote MCP section selects the
transport; `src/mainview/mcp/transport.ts` orchestrates it (borrowed/simplified from
the reference's `tunnel-desktop.ts`):
- **Tunnel (default):** the webview WS-connects to `wss://layerz.me:4433`.
- **Local:** `src/bun/local-mcp-server.ts` runs a `Bun.serve` HTTP listener (ports
  4435+) in the Bun process and forwards each request back to the webview's
  `handleMcpRequest` via the **bun→webview RPC** `mcpHandleHttp`. The webview triggers
  start/stop via `mcpLocalServerStart`/`mcpLocalServerStop`. URL is
  `http://<lan-ip>:<port>/mcp/<token>`; the token is the bearer credential, persisted
  in the KV store so the URL is stable across restarts.
The transports are **mutually exclusive** — selecting local tears the tunnel down
first (and vice-versa), so "local only" never leaves the public tunnel exposed. The
preference is persisted (`mcpLocalMode` in the KV store). Both transports are still
**share-driven**: nothing connects until the user clicks "Select Screen & Start
Remote", and stopping the share disconnects whichever is live. `getMcpStatus`/
`getMcpPublicUrl` track the transport that is *actually live*, not the preference.
This is the one place the webview exposes an RPC the Bun side calls
(`RemoteControlMcpRPC.webview.requests.mcpHandleHttp`).

### 7. `Buffer` polyfill in the webview
The MCP SDK expects Node's `Buffer`. The webview top of `src/mainview/index.ts`
does `(globalThis).Buffer ??= Buffer` (from the `buffer` npm package). Don't remove it.

### 8. US keyboard layout only
`uinput` emits physical keycodes; the compositor maps them to characters using the
**active XKB layout**. The maps in `uinput.ts` (`LETTER_CODES`, `SYMBOL_ROWS`,
`NAMED_KEYS`, `MODIFIER_KEYS`) assume **US QWERTY**. Non-US layouts / non-ASCII
won't type correctly and unmapped chars are reported via `skipped`.

## Tunnel server

- Default URL: `wss://layerz.me:4433/connect` (`DEFAULT_TUNNEL_URL` in `tunnel.ts`).
  Already deployed; override per-connection via `opts.url`.
- The webview opens a WS to the relay; the relay assigns a public HTTPS URL
  (`https://layerz.me:4433/mcp/<session>`) shown in the app's Remote MCP panel and
  logged as `[mcp] PUBLIC URL: …`. External MCP clients POST Streamable HTTP there.

## Testing end-to-end

1. `bun start`, click **Select Screen & Start Remote**, pick a display.
2. Copy the public URL from the Remote MCP panel (or grab it from the console log).
3. `./smoke-mcp.sh '<public-url>'` (or `MCP_URL=<url> ./smoke-mcp.sh`).
   It runs: `get_system_info` → `click(10,10)` → `type_text "chrome"` → wait →
   `press_key down` → wait → `press_key enter`.

## Conventions

- Tabs for indentation (match existing files).
- Comments explain *why* / non-obvious intent, not *what*. Don't narrate code.
- Native capability → Bun process behind an RPC; browser capability → webview.
- After substantive edits, run `bun run check` and `bun run build:canary`.
- Don't commit unless explicitly asked.
