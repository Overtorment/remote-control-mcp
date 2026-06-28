/**
 * MCP server `instructions` (returned on initialize) for the remote-control server.
 */

export const MCP_SERVER_INSTRUCTIONS = [
	"You are connected to a desktop remote-control MCP server. It can observe the",
	"user's screen and synthesize mouse/keyboard input on their machine.",
	"",
	"**Coordinates are the single most common source of error — follow this carefully:**",
	"- The `screenshot` image, `get_system_info`'s `screen`, and `click` all share ONE",
	"  pixel space. Coordinates are within `0..width-1` / `0..height-1`.",
	"- DO NOT estimate coordinates by eye. READ them off the overlaid grid: find the",
	"  nearest labeled gridlines (every 100px) bracketing your target and interpolate.",
	"- Always `screenshot` immediately before a `click` to work from current state.",
	"- After clicking, take another `screenshot` to VERIFY the cursor/effect landed",
	"  where intended; if not, correct using the grid and click again.",
	"- The grid labels are authoritative; never assume the screen extends to a round",
	"  number like 1080/1200 — use the labels actually shown.",
].join("\n");
