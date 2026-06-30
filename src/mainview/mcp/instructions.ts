/**
 * MCP server `instructions` (returned on initialize) for the remote-control server.
 * Not all clients will read them, so we keep them brief.
 */

export const MCP_SERVER_INSTRUCTIONS = [
	"You are connected to a desktop remote-control MCP server. It can observe the",
	"user's screen and synthesize mouse/keyboard input on their machine.",
	"Screenshots are JPEG at 90% quality; coordinates in get_system_info match the",
	"screenshot pixel space (origin top-left).",
].join("\n");
