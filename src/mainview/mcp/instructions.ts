/**
 * MCP server `instructions` (returned on initialize) for the remote-control server.
 */

export const MCP_SERVER_INSTRUCTIONS = [
	"You are connected to a desktop remote-control MCP server. It can observe the",
	"user's screen and synthesize mouse/keyboard input on their machine.",
	"",
	"**Tools:**",
	"- `get_screen_size` — returns the pixel coordinate space (equals the screenshot",
	"  dimensions). Call it first so click coordinates are within bounds.",
	"- `screenshot` — returns a PNG of the currently shared screen with a labeled",
	"  coordinate grid overlaid (lines every 100px, bolder every 500px). Requires the",
	"  user to have started screen sharing; if not active, it returns an error.",
	"- `click` — left/right/middle click at absolute pixel coordinates (origin top-left).",
	"- `type_text` — type a string. Assumes a US keyboard layout; non-ASCII characters",
	"  are skipped and reported.",
	"- `press_key` — press a named key (e.g. `enter`, `tab`, `esc`, `f5`, arrows) or a",
	"  single character, optionally with modifiers (`ctrl`, `shift`, `alt`, `meta`).",
	"",
	"**Coordinates are the single most common source of error — follow this carefully:**",
	"- The `screenshot` image, `get_screen_size`, and `click` all share ONE pixel space.",
	"  Coordinates are within `0..width-1` / `0..height-1`.",
	"- DO NOT estimate coordinates by eye. READ them off the overlaid grid: find the",
	"  nearest labeled gridlines (every 100px) bracketing your target and interpolate.",
	"- Always `screenshot` immediately before a `click` to work from current state.",
	"- After clicking, take another `screenshot` to VERIFY the cursor/effect landed",
	"  where intended; if not, correct using the grid and click again.",
	"- The grid labels are authoritative; never assume the screen extends to a round",
	"  number like 1080/1200 — use the labels actually shown.",
].join("\n");
