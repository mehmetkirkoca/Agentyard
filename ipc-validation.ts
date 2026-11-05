// Argument checks for IPC channels that reach the filesystem, processes, git or MCP config.
// Pure, so they are testable without Electron; main.ts decides how a failure is reported per channel.
import * as path from "path";

// `has` is all that is needed, so a Set of ids and the Map of live PTYs both fit
export function isKnownSessionId(id: unknown, sessionIds: {has(id: string): boolean}): id is string {
  return typeof id === "string" && sessionIds.has(id);
}

// Exact match after normalization (trailing slash, "..", "."): a project's directory is what
// sessions run in, never a path below or beside it. Returns the normalized directory.
export function assertDirectoryInProjects(dir: unknown, projectDirs: readonly string[]): string {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) {
    throw new Error(`Directory must be an absolute path string: ${String(dir)}`);
  }
  const normalized = path.resolve(dir);
  if (!projectDirs.some(d => path.resolve(d) === normalized)) {
    throw new Error(`Directory is not in any project: ${normalized}`);
  }
  return normalized;
}

// Only the object-ness is checked; `claude mcp add-json` validates the server's own shape.
export function assertMcpConfig(config: unknown): object {
  const proto = typeof config === "object" && config !== null ? Object.getPrototypeOf(config) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    throw new Error("MCP server config must be a plain object");
  }
  return config as object;
}
