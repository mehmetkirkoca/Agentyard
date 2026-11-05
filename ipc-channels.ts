// IPC allowlist and the renderer-facing API built on it. No electron import here: preload.ts
// hands in ipcRenderer, webUtils and contextBridge, so this stays testable with fakes.
// ipc-channels.test.ts scans main.ts and renderer.ts and fails when a channel is missing here.

// Request/response channels (ipcMain.handle <-> ipcRenderer.invoke)
export const INVOKE_CHANNELS: readonly string[] = [
  "add-mcp-server",
  "agy-plugin-status",
  "apply-session-to-project",
  "clipboard-read-text",
  "clipboard-write-text",
  "gemini-voice-enabled",
  "get-agy-models",
  "get-all-sessions",
  "get-app-version",
  "get-branches",
  "get-dir-info",
  "get-home-dir",
  "get-last-settings",
  "get-mcp-server-details",
  "get-projects",
  "get-session-image",
  "get-session-model",
  "get-session-prompts",
  "get-terminal-settings",
  "list-mcp-servers",
  "list-slash-commands",
  "open-in-editor",
  "remove-mcp-server",
  "save-clipboard-image",
  "save-project",
  "save-terminal-settings",
  "scan-parent-dir",
  "select-attachment-files",
  "select-directory",
  "set-session-archived",
  "set-session-dir",
  "set-skip-permissions",
  "side-shell-start",
];

// Fire-and-forget channels (ipcMain.on <-> ipcRenderer.send)
export const SEND_CHANNELS: readonly string[] = [
  "close-session",
  "create-session",
  "delete-session",
  "fork-session",
  "fork-session-at",
  "rename-session",
  "reopen-session",
  "save-settings",
  "session-input",
  "session-resize",
  "session-viewed",
  "side-shell-input",
  "side-shell-resize",
  "side-shell-stop",
  "window-control",
];

// Main-to-renderer events (webContents.send / event.reply <-> ipcRenderer.on)
export const EVENT_CHANNELS: readonly string[] = [
  "load-persisted-sessions",
  "mcp-polling-started",
  "mcp-servers-updated",
  "projects-updated",
  "session-created",
  "session-deleted",
  "session-error",
  "session-needs-dir",
  "session-output",
  "session-prompts-changed",
  "session-reopened",
  "session-status",
  "session-warning",
  "sessions-updated",
  "side-shell-exit",
  "side-shell-output",
  "sync-warnings",
  "window-maximized-changed",
];

export type AgentyardListener = (...args: any[]) => void;

export interface AgentyardApi {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  /** Subscribes to a main-to-renderer event; the returned function removes the listener. */
  on(channel: string, listener: AgentyardListener): () => void;
  getPathForFile(file: File): string;
}

export interface IpcLike {
  invoke(channel: string, ...args: any[]): Promise<any>;
  send(channel: string, ...args: any[]): void;
  on(channel: string, listener: (event: any, ...args: any[]) => void): unknown;
  removeListener(channel: string, listener: (event: any, ...args: any[]) => void): unknown;
}

export interface WebUtilsLike {
  getPathForFile(file: File): string;
}

export interface BridgeLike {
  exposeInMainWorld(key: string, api: unknown): void;
}

function assertAllowed(list: readonly string[], kind: string, channel: string): void {
  if (!list.includes(channel)) throw new Error(`IPC channel not allowed for ${kind}: ${channel}`);
}

export function createAgentyardApi(ipc: IpcLike, webUtils: WebUtilsLike): AgentyardApi {
  return {
    invoke: async (channel, ...args) => {
      assertAllowed(INVOKE_CHANNELS, "invoke", channel);
      return ipc.invoke(channel, ...args);
    },
    send: (channel, ...args) => {
      assertAllowed(SEND_CHANNELS, "send", channel);
      ipc.send(channel, ...args);
    },
    on: (channel, listener) => {
      assertAllowed(EVENT_CHANNELS, "on", channel);
      // The IpcRendererEvent never reaches the page: listeners get the payload only
      const wrapped = (_event: unknown, ...args: any[]) => listener(...args);
      ipc.on(channel, wrapped);
      return () => { ipc.removeListener(channel, wrapped); };
    },
    getPathForFile: (file) => webUtils.getPathForFile(file),
  };
}

export function exposeAgentyardApi(bridge: BridgeLike, ipc: IpcLike, webUtils: WebUtilsLike): void {
  bridge.exposeInMainWorld("agentyard", createAgentyardApi(ipc, webUtils));
}

// contextBridge.exposeInMainWorld throws while contextIsolation is off, so there the api is
// assigned onto the window directly. Once contextIsolation is on (Task 5), contextBridge is the
// only path and the fallback can go.
export function pickBridge(contextIsolated: boolean, contextBridge: BridgeLike, target: Record<string, unknown>): BridgeLike {
  if (contextIsolated) return contextBridge;
  return {exposeInMainWorld: (key, api) => { target[key] = api; }};
}
