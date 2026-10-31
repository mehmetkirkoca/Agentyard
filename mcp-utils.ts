// Parsing helpers for `claude mcp list` output

export interface McpServerStatus {
  name: string;
  connected: boolean;
}

const NO_SERVERS_MESSAGE = "No MCP servers configured";

// A server line: "<name>: <url or command> [(<type>)] - <status mark> <status text>"
// Older CLI versions print ✓/✗ and always a type; current ones print ✔/✘, names may contain
// spaces/dots (e.g. "claude.ai Gmail") and stdio servers carry no type.
const SERVER_LINE = /^(.+?):\s+\S.*?\s-\s+([✓✔⚠✗✘])/;
const CONNECTED_MARKS = new Set(["✓", "✔"]);

// CSI sequences, and OSC sequences up to their own terminator (BEL or ESC \) — the OSC body
// never contains ESC/BEL, so it cannot run past its terminator into the following lines
// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

// Cursor moves to a column / forward (CSI n G, CSI n C) stand in for spaces in TUI output
// eslint-disable-next-line no-control-regex
const CURSOR_COLUMN_MOVE = /\x1b\[[0-9]*[GC]/g;

function cleanLines(output: string): string[] {
  return output
    .replace(CURSOR_COLUMN_MOVE, " ")
    .replace(ANSI_SEQUENCE, "")
    .split(/\r?\n|\r/)
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

/**
 * Parse the server list printed by `claude mcp list`, tolerating terminal noise
 * (echoed command, ANSI colours, shell prompt).
 */
export function parseMcpListOutput(output: string): McpServerStatus[] {
  if (output.includes(NO_SERVERS_MESSAGE)) {
    return [];
  }

  const servers: McpServerStatus[] = [];
  for (const line of cleanLines(output)) {
    const match = line.match(SERVER_LINE);
    if (!match) continue;
    servers.push({
      name: match[1].trim(),
      connected: CONNECTED_MARKS.has(match[2]),
    });
  }
  return servers;
}

/**
 * True when an output chunk contains at least one server line or the "no servers" message.
 */
export function hasMcpListResult(chunk: string): boolean {
  if (chunk.includes(NO_SERVERS_MESSAGE)) return true;
  return cleanLines(chunk).some(line => SERVER_LINE.test(line));
}
