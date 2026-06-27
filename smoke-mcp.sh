#!/usr/bin/env bash
#
# MCP Streamable HTTP smoke test against the remote-control tunnel URL.
#
# Drives a short demo sequence through the MCP server running in the app's
# webview: click (10,10) → type "chrome" → wait 1s → press "down" → wait 1s →
# press "enter". Handy for launching an app from a desktop search/launcher.
#
# Safe to run repeatedly: each run starts with a headerless `initialize`, which
# mints a fresh MCP session on the app (see mcp.ts bare + init path).
#
# Usage:
#   ./smoke-mcp.sh https://layerz.me:4433/mcp/…    # paste from the app's Remote MCP panel
#   # …or rely on MCP_URL export:
#   MCP_URL=https://layerz.me:4433/mcp/… ./smoke-mcp.sh
#

set -euo pipefail

URL="${MCP_URL:-${1:-}}"
if [[ -z "$URL" ]]; then
  echo "Usage: $0 https://layerz.me:4433/mcp/…" >&2
  echo "       MCP_URL=https://layerz.me:4433/mcp/… $0" >&2
  exit 1
fi

HDR=$(mktemp)
BODY=$(mktemp)
trap 'rm -f "$HDR" "$BODY"' EXIT

echo "→ initialize …"
curl -sk -D "$HDR" -o "$BODY" -X POST "$URL" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  --data-binary @- <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke-mcp.sh","version":"0"}}}
EOF

# Prefer the server's negotiated protocol version from the initialize result.
PROTO=$(sed -nE 's/.*"protocolVersion":"([^"]+)".*/\1/p' "$BODY" | head -1 || true)
if [[ -z "$PROTO" ]]; then
  PROTO="2025-06-18"
fi

# Bun's fetch lower-cases outbound header names → server echoes lowercase.
SID=$(grep -Fi 'mcp-session-id:' "$HDR" | awk '{print $2}' | tr -d '\r')

if [[ -z "$SID" ]]; then
  echo "❌ Failed to capture mcp-session-id from response headers."
  echo "   HTTP trace saved (headers→$HDR body→$BODY)."
  echo "   Raw body:"
  cat "$BODY"
  echo
  exit 1
fi

echo "  Mcp-Session-Id: $SID"
echo "  MCP-Protocol-Version: $PROTO"

echo "→ notifications/initialized …"
curl -sk -X POST "$URL" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -H "mcp-protocol-version: $PROTO" \
  --data-binary '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  -w '%{http_code}\n'

# Monotonic JSON-RPC id for the calls below.
RPC_ID=1

# call_tool <name> <arguments-json>
call_tool() {
  local name="$1" args="$2"
  RPC_ID=$((RPC_ID + 1))
  echo ""
  echo "→ tools/call ${name} ${args} …"
  curl -sk -X POST "$URL" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    -H "mcp-session-id: $SID" \
    -H "mcp-protocol-version: $PROTO" \
    --data-binary "{\"jsonrpc\":\"2.0\",\"id\":${RPC_ID},\"method\":\"tools/call\",\"params\":{\"name\":\"${name}\",\"arguments\":${args}}}"
  echo ""
}

# --- query screen size first -------------------------------------------------
RPC_ID=$((RPC_ID + 1))
echo ""
echo "→ tools/call get_screen_size …"
SIZE_RESP=$(curl -sk -X POST "$URL" \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H "mcp-session-id: $SID" \
  -H "mcp-protocol-version: $PROTO" \
  --data-binary "{\"jsonrpc\":\"2.0\",\"id\":${RPC_ID},\"method\":\"tools/call\",\"params\":{\"name\":\"get_screen_size\",\"arguments\":{}}}")
echo "$SIZE_RESP"

# The size lives in content[0].text as JSON-escaped {"width":W,"height":H}.
SCREEN_SIZE=$(printf '%s' "$SIZE_RESP" | sed -nE 's/.*\\"width\\":([0-9]+),\\"height\\":([0-9]+).*/\1 x \2/p' | head -1)
echo ""
if [[ -n "$SCREEN_SIZE" ]]; then
  echo "  📐 Screen size: ${SCREEN_SIZE}"
else
  echo "  ⚠️  Could not parse screen size from response."
fi

# --- demo sequence -----------------------------------------------------------
call_tool "click"     '{"x":10,"y":10}'
call_tool "type_text" '{"text":"chrome"}'

echo "… waiting 1s"
sleep 1
call_tool "press_key" '{"key":"down"}'

echo "… waiting 1s"
sleep 1
call_tool "press_key" '{"key":"enter"}'

echo ""
echo "✓ Smoke done"
