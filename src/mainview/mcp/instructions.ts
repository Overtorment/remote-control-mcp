/**
 * MCP server `instructions` (returned on initialize) for the remote-control server.
 */

export const MCP_SERVER_INSTRUCTIONS = [
	"You are connected to a desktop remote-control MCP server. It can observe the",
	"user's screen and synthesize mouse/keyboard input on their machine.",
	"",
	"**Tools:**",
	"- `get_screen_size` — returns the target screen resolution in pixels. Call this",
	"  first so click coordinates are within bounds.",
	"- `screenshot` — returns a PNG of the currently shared screen. Requires the user",
	"  to have started screen sharing in the app; if not active, it returns an error.",
	"- `click` — left/right/middle click at absolute pixel coordinates (origin top-left).",
	"- `type_text` — type a string. Assumes a US keyboard layout; non-ASCII characters",
	"  are skipped and reported.",
	"- `press_key` — press a named key (e.g. `enter`, `tab`, `esc`, `f5`, arrows) or a",
	"  single character, optionally with modifiers (`ctrl`, `shift`, `alt`, `meta`).",
	"",
	"**Coordinates:** always within `0..width-1` / `0..height-1` from `get_screen_size`.",
	"Take a `screenshot` to see current state before clicking when possible.",
].join("\n");
