// Argument checks for IPC channels that reach the filesystem, processes, git or MCP config.
// Pure, so they are testable without Electron; main.ts decides how a failure is reported per channel.

// `has` is all that is needed, so a Set of ids and the Map of live PTYs both fit
export function isKnownSessionId(id: unknown, sessionIds: {has(id: string): boolean}): id is string {
  return typeof id === "string" && sessionIds.has(id);
}

// Input channels fire per keystroke, so an unknown session (a dead PTY whose terminal is still
// visible) must stay silent; only malformed data for a known session is worth a log line.
export type InputArgsCheck = "ok" | "unknown-session" | "bad-data";

export function checkInputArgs(id: unknown, data: unknown, sessionIds: {has(id: string): boolean}): InputArgsCheck {
  if (!isKnownSessionId(id, sessionIds)) return "unknown-session";
  return typeof data === "string" ? "ok" : "bad-data";
}

// Only the object-ness is checked; `claude mcp add-json` validates the server's own shape.
export function assertMcpConfig(config: unknown): object {
  const proto = typeof config === "object" && config !== null ? Object.getPrototypeOf(config) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("MCP server config must be a plain object");
  }
  return config as object;
}
