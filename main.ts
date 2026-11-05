import {exec, execFile, spawn, spawnSync} from "child_process";
import {app, BrowserWindow, clipboard, dialog, ipcMain} from "electron";
import Store from "electron-store";
import * as fs from "fs";
import * as pty from "node-pty";
import * as os from "os";
import * as path from "path";
import {simpleGit} from "simple-git";
import {promisify} from "util";
import {v4 as uuidv4} from "uuid";
import {attachmentFileName, attachmentsDir, buildTextPaste} from "./attach-utils";
import {findPastedImage, PastedImage} from "./transcript-images";
import {buildClaudeCommand, buildHookSettings, buildPtyEnv, claudeScrollEnv} from "./claude-launch";
import {buildGeminiCommand, ensureGeminiStatusExtension, isGeminiVoiceModeEnabled, readGeminiPromptsAndModel} from "./gemini-launch";
import {adoptAgyConversation, AGY_STATUS_ENV, AgyPluginResult, agyPromptsOf, agySessionName, buildAgyCommand, createAgyWaitingDetector, ensureAgySnapBridge, ensureAgyStatusPlugin, filterAgyEvents, resolveAgyBinary, stripAnsi} from "./antigravity-launch";
import {AGY_FALLBACK_MODELS, AgyModelFamily, groupAgyModels} from "./antigravity-screen";
import {appHome, centralSessionsDir, claudeProjectFolder, hookSettingsPath, statusFilePath} from "./claude-paths";
import {legacyUserDataDir, runDataMigration} from "./data-migration";
import {buildEditorLaunch, DEFAULT_EDITOR_ID, editorEnv} from "./editor-launch";
import {addWorktree, diffAgainstBranch, getBranches, getCurrentBranch} from "./git-utils";
import {hardenNavigation} from "./window-security";
import {assignProjects, canAddDir, computeDirOccupancy, ensureStandaloneProject, filterRepoCandidates, findProjectForDir, isStandaloneProject, normalizeDirs, Occupancy, STANDALONE_PROJECT_NAME, standaloneScratchDir} from "./project-model";
import {scanClaudeProcesses} from "./process-scan";
import {PromptHistory, readUserPrompts} from "./prompt-history";
import {listAntigravitySlashCommands, listGeminiSlashCommands, listSlashCommands, readSessionModel, SessionModel, SlashCommand} from "./prompt-toolbar";
import {buildForkTranscript} from "./fork-transcript";
import {isTerminalReportOnly, nextStatus, parseHookEvents, statusOnAppQuit, statusOnUserInput, statusOnView} from "./session-status";
import {BRACKETED_PASTE_MODE_ENABLE, isTerminalReady} from "./terminal-utils";
import {hasMcpListResult, mcpAddJsonCommand, mcpGetCommand, mcpRemoveCommand, parseMcpListOutput} from "./mcp-utils";
import {inspectTranscript, relinkTranscript} from "./link-store";
import {TranscriptMeta} from "./transcript-meta";
import {
  canAdoptForMove,
  checkSessionGate,
  moveSessionLink,
  pendingAdoptionMtime,
  runSyncTick,
  transcriptExists,
} from "./transcript-sync";
import {PersistedSession, Project, SessionConfig, SessionRuntime, SessionStatus, SessionType} from "./types";

const execAsync = promisify(exec);

let mainWindow: BrowserWindow;
const activePtyProcesses = new Map<string, pty.IPty>();
// PTYs killed by close/delete whose process has not exited yet: their Claude may still be
// writing (and is invisible to the process scan), so they count as running until onExit.
const closingPtys = new Map<string, pty.IPty>();
const mcpPollerPtyProcesses = new Map<string, pty.IPty>();
// Plain shell beside a session's agent (pane's bottom panel), keyed by the session id
const sideShellPtys = new Map<string, pty.IPty>();
let claudeCommandRunnerPty: pty.IPty | null = null;

// One-time move of FleetCode's data (settings, ~/.fleetcode, ~/fleetcode-scratch, transcript links) to Agentyard.
// Runs before the store or anything else reads the data folders; it never blocks startup.
let migrationWarnings: string[] = [];
try {
  const newUserData = app.getPath("userData");
  const migration = runDataMigration({
    home: os.homedir(),
    oldUserData: legacyUserDataDir(app.getPath("appData"), newUserData),
    newUserData,
  });
  console.log(`Data migration: ${migration.summary}`);
  for (const w of migration.warnings) console.warn(`Data migration: ${w}`);
  migrationWarnings = migration.warnings.map(w => `Data migration: ${w}`);
} catch (error) {
  console.error("Data migration failed:", error);
  migrationWarnings = [`Data migration failed: ${error instanceof Error ? error.message : String(error)}`];
}

const store = new Store();

// Helper functions for session management
function getPersistedSessions(): PersistedSession[] {
  const sessions = (store as any).get("sessions", []) as PersistedSession[];

  // Migrate old sessions that don't have sessionType field
  return sessions.map(session => {
    if (!session.config.sessionType) {
      // If session has a worktreePath, it's a worktree session; otherwise local
      session.config.sessionType = session.worktreePath ? SessionType.WORKTREE : SessionType.LOCAL;
    }
    return session;
  });
}

function getWorktreeBaseDir(): string {
  const settings = (store as any).get("terminalSettings");
  if (settings && settings.worktreeDir) {
    return settings.worktreeDir;
  }
  return path.join(os.homedir(), "worktrees");
}

function savePersistedSessions(sessions: PersistedSession[]) {
  (store as any).set("sessions", sessions);
}

function getProjects(): Project[] {
  return (store as any).get("projects", []) as Project[];
}

function saveProjects(projects: Project[]) {
  (store as any).set("projects", projects);
}

function getHiddenUuids(): string[] {
  return (store as any).get("hiddenTranscripts", []) as string[];
}

function addHiddenUuid(uuid: string) {
  const hidden = getHiddenUuids();
  if (!hidden.includes(uuid)) {
    (store as any).set("hiddenTranscripts", [...hidden, uuid]);
  }
}

// One-time (idempotent) migration: give every session a project. Sessions without a directory are skipped.
function migrateProjects(): void {
  try {
    const sessions = getPersistedSessions();
    const eligible = sessions.filter(s => !s.projectId && s.config.projectDir);
    if (eligible.length === 0) return;
    const result = assignProjects(eligible, getProjects(), uuidv4);
    const byId = new Map(result.sessions.map(s => [s.id, s]));
    saveProjects(result.projects);
    savePersistedSessions(sessions.map(s => byId.get(s.id) ?? s));
  } catch (error) {
    console.error("Error migrating sessions to projects:", error);
  }
}

// Migrate any attachments from ~/.agentyard/attachments to ~/agentyard-scratch/attachments
function migrateLegacyAttachments(home: string = os.homedir()): void {
  const oldDir = path.join(appHome(home), "attachments");
  const newDir = path.join(standaloneScratchDir(home), "attachments");
  try {
    if (fs.existsSync(oldDir) && fs.statSync(oldDir).isDirectory()) {
      fs.mkdirSync(newDir, {recursive: true});
      for (const entry of fs.readdirSync(oldDir)) {
        const src = path.join(oldDir, entry);
        const dest = path.join(newDir, entry);
        if (!fs.existsSync(dest)) {
          fs.cpSync(src, dest, {recursive: true});
        }
      }
    }
  } catch (error) {
    console.error("Error migrating legacy attachments:", error);
  }
}

// Idempotent: persist the built-in project of standalone sessions (SESSIONS section) when missing.
function bootstrapStandaloneProject(): void {
  try {
    const result = ensureStandaloneProject(getProjects(), os.homedir());
    if (result.changed) saveProjects(result.projects);
    migrateLegacyAttachments(os.homedir());
  } catch (error) {
    console.error("Error creating the standalone sessions project:", error);
  }
}

// The scratch folder is created on first use, not at startup.
function ensureScratchDir(dir: string): void {
  const scratch = standaloneScratchDir(os.homedir());
  if (!dir || path.resolve(dir) !== scratch) return;
  try {
    fs.mkdirSync(scratch, {recursive: true});
  } catch (error) {
    throw new Error(`Could not create ${scratch}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function notifyProjectsUpdated(projects: Project[]) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("projects-updated", projects);
  }
}

// --- Hook-based session status ---
let viewedSessionId: string | null = null;
const statusFileOffsets = new Map<string, number>();
let statusWatcher: fs.FSWatcher | null = null;
let statusPollTimer: NodeJS.Timeout | null = null;
const STATUS_POLL_INTERVAL_MS = 1000;

// Apply a status change to a persisted session; writes the store and notifies the renderer only on change.
function applySessionStatus(
  sessionId: string,
  compute: (current: SessionStatus | undefined) => SessionStatus | undefined,
): void {
  const sessions = getPersistedSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (!session) return;
  const next = compute(session.status);
  if (next === undefined || next === session.status) return;
  session.status = next;
  session.lastActivity = Date.now();
  savePersistedSessions(sessions);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("session-status", sessionId, next);
  }
}

// In-flight states cannot survive a dead PTY: RUNNING/WAITING become DONE (unseen)
function settleSessionStatus(sessionId: string): void {
  applySessionStatus(sessionId, statusOnAppQuit);
}

function settleAllSessionStatuses(): void {
  try {
    const sessions = getPersistedSessions();
    let changed = false;
    for (const session of sessions) {
      const next = statusOnAppQuit(session.status);
      if (next !== session.status) {
        session.status = next;
        changed = true;
      }
    }
    if (changed) savePersistedSessions(sessions);
  } catch (error) {
    console.error("Error settling session statuses:", error);
  }
}

function processStatusFile(filePath: string): void {
  const sessionUuid = path.basename(filePath, ".jsonl");
  try {
    const size = fs.statSync(filePath).size;
    let offset = statusFileOffsets.get(filePath) ?? 0;
    if (size < offset) offset = 0; // file was truncated/replaced
    if (size === offset) return;

    const buf = Buffer.alloc(size - offset);
    const fd = fs.openSync(filePath, "r");
    try {
      fs.readSync(fd, buf, 0, buf.length, offset);
    } finally {
      fs.closeSync(fd);
    }

    // Only consume up to the last newline; a partial last line is read on the next change
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline === -1) return;
    const newOffset = offset + lastNewline + 1;

    const events = parseHookEvents(buf.subarray(0, lastNewline + 1).toString("utf8"));
    if (events.length === 0) {
      statusFileOffsets.set(filePath, newOffset);
      return;
    }

    // Do not advance the offset until the uuid maps to a persisted session, so events are not lost
    const persisted = getPersistedSessions();
    const target = persisted.find(s => s.sessionUuid === sessionUuid);
    if (!target) return;
    statusFileOffsets.set(filePath, newOffset);
    let accepted = events;
    if (target.config.codingAgent === "antigravity") {
      // Only the session's own conversation counts (not sub-agents); learn its id from the events
      const filtered = filterAgyEvents(target.agentConversationId, events);
      accepted = filtered.accepted;
      if (filtered.conversationId && filtered.conversationId !== target.agentConversationId) {
        const next = adoptAgyConversation(target, filtered.conversationId);
        if (next.agentConversationId !== target.agentConversationId) {
          target.agentConversationId = next.agentConversationId;
          target.forkedFrom = next.forkedFrom;
          target.forkedPromptCount = next.forkedPromptCount;
          savePersistedSessions(persisted);
        }
      }
    }
    applySessionStatus(target.id, current => {
      let status = current;
      for (const ev of accepted) {
        status = nextStatus(status, ev, viewedSessionId === target.id);
      }
      return status;
    });
    // Any hook event may follow a prompt landing in the transcript: let the renderer re-read them
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("session-prompts-changed", target.id);
    }
  } catch (error) {
    console.error(`Error processing status file ${filePath}:`, error);
  }
}

// Start a run with an empty status file: its hooks append to it, earlier events are already applied.
// Gemini's hook only writes to a file that exists, so this also turns status reporting on for it.
function resetStatusFile(sessionUuid: string): void {
  const statusFile = statusFilePath(sessionUuid);
  fs.mkdirSync(path.dirname(statusFile), {recursive: true});
  fs.writeFileSync(statusFile, "");
  statusFileOffsets.set(statusFile, 0);
}

function startStatusWatcher(): void {
  const statusDir = path.join(appHome(), "status");
  const extensionError = ensureGeminiStatusExtension(statusDir);
  if (extensionError) console.error(extensionError);
  try {
    fs.mkdirSync(statusDir, {recursive: true});
    // Existing files: start from the end so old history is not replayed
    for (const name of fs.readdirSync(statusDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = path.join(statusDir, name);
      statusFileOffsets.set(filePath, fs.statSync(filePath).size);
    }
  } catch (error) {
    console.error(`Failed to prepare status directory ${statusDir}:`, error);
    return;
  }

  try {
    statusWatcher = fs.watch(statusDir, (_eventType, filename) => {
      if (!filename || !filename.toString().endsWith(".jsonl")) return;
      processStatusFile(path.join(statusDir, filename.toString()));
    });
    statusWatcher.on("error", error => {
      console.error(`Status watcher error for ${statusDir}, falling back to polling:`, error);
      statusWatcher?.close();
      statusWatcher = null;
      startStatusPolling(statusDir);
    });
  } catch (error) {
    // e.g. EMFILE when the user's inotify instance limit is exhausted by other apps
    console.warn(`Cannot watch status directory ${statusDir} (${(error as NodeJS.ErrnoException).code ?? error}); polling every ${STATUS_POLL_INTERVAL_MS} ms instead`);
    startStatusPolling(statusDir);
  }
}

function startStatusPolling(statusDir: string): void {
  if (statusPollTimer) return;
  statusPollTimer = setInterval(() => {
    try {
      for (const name of fs.readdirSync(statusDir)) {
        if (name.endsWith(".jsonl")) processStatusFile(path.join(statusDir, name));
      }
    } catch (error) {
      console.error(`Error polling status directory ${statusDir}:`, error);
    }
  }, STATUS_POLL_INTERVAL_MS);
}

function getNextSessionNumber(): number {
  const sessions = getPersistedSessions();
  if (sessions.length === 0) return 1;
  return Math.max(...sessions.map(s => s.number)) + 1;
}

// --- Continuous transcript sync ---
const SYNC_INTERVAL_MS = 5000;
const transcriptIndex = new Map<string, TranscriptMeta>();
let lastExternallyOpen = new Set<string>();
let lastSyncWarnings: string[] = [];
let syncTimer: NodeJS.Timeout | null = null;
let syncRunning = false;

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function buildSessionRuntime(sessions: PersistedSession[], externallyOpen: Set<string>): Record<string, SessionRuntime> {
  const runtime: Record<string, SessionRuntime> = {};
  for (const s of sessions) {
    runtime[s.id] = {externallyOpen: externallyOpen.has(s.sessionUuid.toLowerCase())};
  }
  return runtime;
}

function syncTranscripts(): void {
  if (syncRunning) return;
  syncRunning = true;
  try {
    const sessions = getPersistedSessions();
    const openUuids = new Set(sessions.filter(s => hasLivePty(s.id)).map(s => s.sessionUuid));
    let number = getNextSessionNumber();
    const result = runSyncTick({
      projects: getProjects(),
      sessions,
      hidden: new Set(getHiddenUuids()),
      openUuids,
      external: scanClaudeProcesses(),
      index: transcriptIndex,
      centralDir: centralSessionsDir(),
      home: os.homedir(),
      nextNumber: () => number++,
    });

    const agyRenamed = renameAgySessions(result.sessions);
    if (result.changed || agyRenamed) savePersistedSessions(result.sessions);
    // A failed tick knows nothing about open transcripts: keep the previous state.
    const externallyOpen = result.failed ? lastExternallyOpen : result.externallyOpen;
    const openChanged = !sameSet(externallyOpen, lastExternallyOpen);
    lastExternallyOpen = externallyOpen;
    if ((result.changed || agyRenamed || openChanged) && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(
        "sessions-updated",
        result.sessions,
        buildSessionRuntime(result.sessions, externallyOpen),
      );
    }

    // Warnings repeat every tick while their cause persists: report only when the list changes.
    const warningsChanged =
      result.warnings.length !== lastSyncWarnings.length ||
      result.warnings.some((w, i) => w !== lastSyncWarnings[i]);
    if (warningsChanged) {
      for (const w of result.warnings) {
        if (!lastSyncWarnings.includes(w)) console.warn(`Transcript sync: ${w}`);
      }
      lastSyncWarnings = result.warnings;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("sync-warnings", [...migrationWarnings, ...result.warnings]);
      }
    }
  } catch (error) {
    console.error("Error syncing transcripts:", error);
  } finally {
    syncRunning = false;
  }
}

// Antigravity sessions named automatically (not renamed by the user) follow agy's conversation
// title, else their first prompt. Agy sessions from before automatic names have no flag; they are
// automatic too. Updates sessions in place; true when a name changed.
function renameAgySessions(sessions: PersistedSession[]): boolean {
  let changed = false;
  for (const session of sessions) {
    if (session.config.codingAgent !== "antigravity" || session.manualName === true) continue;
    const name = agySessionName(session, sessions);
    if (name && name !== session.name) {
      session.name = name;
      changed = true;
    }
  }
  return changed;
}

function startTranscriptSync(): void {
  syncTranscripts();
  if (!syncTimer) syncTimer = setInterval(syncTranscripts, SYNC_INTERVAL_MS);
}

function stopTranscriptSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

// Extract MCP config for a project from ~/.claude.json
function extractProjectMcpConfig(projectDir: string): any {
  try {
    const claudeConfigPath = path.join(os.homedir(), ".claude.json");

    if (!fs.existsSync(claudeConfigPath)) {
      return {};
    }

    const claudeConfig = JSON.parse(fs.readFileSync(claudeConfigPath, "utf8"));

    if (!claudeConfig.projects || !claudeConfig.projects[projectDir]) {
      return {};
    }

    return claudeConfig.projects[projectDir].mcpServers || {};
  } catch (error) {
    console.error("Error extracting MCP config:", error);
    return {};
  }
}

// Marker file in a project's worktrees directory holding the project path
const WORKTREE_MARKER_FILE = ".agentyard-project";
const LEGACY_WORKTREE_MARKER_FILE = ".fleetcode-project";

// Get a safe directory name from project path, with collision handling
function getProjectWorktreeDirName(projectDir: string): string {
  const baseName = path.basename(projectDir);
  const worktreesBaseDir = getWorktreeBaseDir();
  const candidatePath = path.join(worktreesBaseDir, baseName);

  // If directory doesn't exist or points to the same project, use base name
  if (!fs.existsSync(candidatePath)) {
    return baseName;
  }

  // Check if existing directory is for the same project by reading a marker file
  // (directories created before the rename carry the legacy FleetCode marker)
  for (const markerName of [WORKTREE_MARKER_FILE, LEGACY_WORKTREE_MARKER_FILE]) {
    const markerFile = path.join(candidatePath, markerName);
    if (fs.existsSync(markerFile)) {
      const existingProjectPath = fs.readFileSync(markerFile, "utf-8").trim();
      if (existingProjectPath === projectDir) {
        return baseName;
      }
    }
  }

  // Collision detected - append short hash
  const crypto = require("crypto");
  const hash = crypto.createHash("md5").update(projectDir).digest("hex").substring(0, 6);
  return `${baseName}-${hash}`;
}

// Write MCP config file for a project (shared across all sessions)
function writeMcpConfigFile(projectDir: string, mcpServers: any): string | null {
  try {
    const projectDirName = getProjectWorktreeDirName(projectDir);
    const worktreesDir = getWorktreeBaseDir();
    if (!fs.existsSync(worktreesDir)) {
      fs.mkdirSync(worktreesDir, { recursive: true });
    }

    const configFilePath = path.join(worktreesDir, projectDirName, "mcp-config.json");
    const configContent = JSON.stringify({ mcpServers }, null, 2);

    // Ensure project worktree directory exists
    const projectWorktreeDir = path.join(worktreesDir, projectDirName);
    if (!fs.existsSync(projectWorktreeDir)) {
      fs.mkdirSync(projectWorktreeDir, { recursive: true });
    }

    fs.writeFileSync(configFilePath, configContent, "utf8");

    return configFilePath;
  } catch (error) {
    console.error("Error writing MCP config file:", error);
    return null;
  }
}

// Piped, so Claude prints plain text instead of a cursor-positioned TUI render
const MCP_LIST_COMMAND = "claude mcp list 2>&1 | cat";

// Give up waiting for a parseable `claude mcp list` result after this long
const MCP_POLL_TIMEOUT_MS = 45000;

function resolveNodeBinPath(home: string = os.homedir()): string | undefined {
  if (process.env.NVM_BIN && fs.existsSync(process.env.NVM_BIN)) {
    return process.env.NVM_BIN;
  }
  const nvmVersionsDir = path.join(home, ".nvm", "versions", "node");
  if (fs.existsSync(nvmVersionsDir)) {
    try {
      const versions = fs.readdirSync(nvmVersionsDir).filter(v => v.startsWith("v"));
      versions.sort((a, b) => {
        const parse = (v: string) => v.slice(1).split(".").map(Number);
        const [aMaj = 0, aMin = 0] = parse(a);
        const [bMaj = 0, bMin = 0] = parse(b);
        return bMaj !== aMaj ? bMaj - aMaj : bMin - aMin;
      });
      if (versions.length > 0) {
        const candidate = path.join(nvmVersionsDir, versions[0], "bin");
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  return undefined;
}

function getPtyEnv(sessionId: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const settings = (store as any).get("terminalSettings") ?? {};
  const env = {...buildPtyEnv(process.env, sessionId), ...claudeScrollEnv(settings.scrollSpeed), ...extra};
  delete env.npm_config_prefix;
  delete env.NPM_CONFIG_PREFIX;
  const nodeBin = resolveNodeBinPath();
  if (nodeBin) {
    const currentPath = env.PATH || "";
    const parts = currentPath.split(path.delimiter).filter(p => p !== nodeBin);
    env.PATH = [nodeBin, ...parts].join(path.delimiter);
  }
  return env;
}

// Spawn headless PTY for MCP polling
function spawnMcpPoller(sessionId: string, projectDir: string) {
  const shell = os.platform() === "darwin" ? "zsh" : "bash";
  const ptyProcess = pty.spawn(shell, ["-l"], {
    name: "xterm-color",
    cols: 80,
    rows: 30,
    cwd: projectDir,
    env: getPtyEnv(sessionId),
  });

  mcpPollerPtyProcesses.set(sessionId, ptyProcess);

  let outputBuffer = "";
  const serverMap = new Map<string, any>();
  let lastMcpUpdateAt = 0;
  const sendMcpServers = (servers: any[]) => {
    lastMcpUpdateAt = Date.now();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("mcp-servers-updated", sessionId, servers);
    }
  };

  ptyProcess.onData((data) => {

    // Accumulate output without displaying it
    outputBuffer += data;

    // Parse output whenever we have MCP server entries (see mcp-utils for the accepted formats)
    if (hasMcpListResult(data)) {
      try {
        const servers = parseMcpListOutput(outputBuffer);

        // Clear and replace the server map with current results
        serverMap.clear();
        servers.forEach(server => {
          serverMap.set(server.name, server);
        });

        const allServers = Array.from(serverMap.values());

        sendMcpServers(allServers);
      } catch (error) {
        console.error(`[MCP Poller ${sessionId}] Error parsing:`, error);
      }
    }

    // Clear buffer when we see the shell prompt (command finished)
    if ((data.includes("% ") || data.includes("$ ") || data.includes("➜ ")) &&
        outputBuffer.includes("claude mcp list")) {
      outputBuffer = "";
    }
  });

  // Start polling immediately and then every 60 seconds
  const pollMcp = () => {
    if (mcpPollerPtyProcesses.has(sessionId)) {
      // Notify renderer that polling is starting
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("mcp-polling-started", sessionId);
      }

      const pollStartedAt = Date.now();
      const command = MCP_LIST_COMMAND;
      ptyProcess.write(command + "\r");
      // If nothing parseable arrives (e.g. the CLI output format changed), stop the spinner anyway
      setTimeout(() => {
        if (lastMcpUpdateAt < pollStartedAt && mcpPollerPtyProcesses.has(sessionId)) {
          console.warn(`[MCP Poller ${sessionId}] No parseable "claude mcp list" output within ${MCP_POLL_TIMEOUT_MS} ms`);
          sendMcpServers(Array.from(serverMap.values()));
        }
      }, MCP_POLL_TIMEOUT_MS);
      setTimeout(pollMcp, 60000);
    }
  };

  // Wait briefly for shell to be ready before first poll
  setTimeout(() => {
    pollMcp();
  }, 500);
}


// Pause between Claude turning on bracketed paste and the prefill, so its input box has mounted
const PREFILL_DELAY_MS = 500;
// agy's footer hint, drawn once its input box listens; a fork sends /fork after it
const AGY_READY_HINT = "? for shortcuts";
const AGY_READY_TAIL = 4096;
const AGY_FORK_DELAY_MS = 500;
const AGY_SUBMIT_DELAY_MS = 100;

// Helper function to spawn PTY and setup coding agent
function spawnSessionPty(
  sessionId: string,
  workingDirectory: string,
  config: SessionConfig,
  sessionUuid: string,
  isNewSession: boolean,
  mcpConfigPath?: string,
  projectDir?: string,
  forkFrom?: string,
  /** text pasted into Claude's input box, unsent, once Claude is up (a fork's prompt) */
  prefill?: string,
  /** Antigravity: the conversation to resume */
  agentConversationId?: string,
) {
  const shell = os.platform() === "darwin" ? "zsh" : "bash";
  const isAgy = config.codingAgent === "antigravity";
  const ptyProcess = pty.spawn(shell, ["-l"], {
    name: "xterm-color",
    cols: 80,
    rows: 30,
    cwd: workingDirectory,
    // agy's hooks (agentyard-status plugin) append to this file; they do nothing without it
    env: getPtyEnv(sessionId, isAgy ? {[AGY_STATUS_ENV]: statusFilePath(sessionUuid)} : {}),
  });

  activePtyProcesses.set(sessionId, ptyProcess);

  ptyProcess.onExit(() => {
    if (closingPtys.get(sessionId) === ptyProcess) closingPtys.delete(sessionId);
    // A late exit of an earlier PTY must not touch a session reopened since.
    if (activePtyProcesses.get(sessionId) === ptyProcess) {
      activePtyProcesses.delete(sessionId);
      settleSessionStatus(sessionId);
    }
  });

  let terminalReady = false;
  let readyChecksCompleted = 0;
  let lastReadyCheckPos = 0;
  let setupCommandsIdx = 0;
  let dataBuffer = "";
  // Claude turns on bracketed paste once its input box listens; the shell turned it off when it ran
  // the command, so the first "on" after the command is Claude's
  let prefillPending = false;
  let prefillTail = "";
  // agy sends no hook while it waits for approval: its screen is watched instead
  const agyWaiting = isAgy ? createAgyWaitingDetector() : null;
  // A fork of an agy conversation: once agy is up, /fork makes this session a copy of it
  let agyForkPending = false;
  let agyReadyTail = "";

  ptyProcess.onData((data) => {
    // Only send data if window still exists and is not destroyed
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("session-output", sessionId, data);
    }

    if (agyWaiting?.(data)) applySessionStatus(sessionId, () => SessionStatus.WAITING);

    if (agyForkPending) {
      agyReadyTail = (agyReadyTail + stripAnsi(data)).slice(-AGY_READY_TAIL);
      if (agyReadyTail.includes(AGY_READY_HINT)) {
        agyForkPending = false;
        setTimeout(() => {
          if (activePtyProcesses.get(sessionId) !== ptyProcess) return;
          ptyProcess.write("/fork");
          // agy, like Gemini CLI, may take an Enter right after typing for a newline
          setTimeout(() => {
            if (activePtyProcesses.get(sessionId) === ptyProcess) ptyProcess.write("\r");
          }, AGY_SUBMIT_DELAY_MS);
        }, AGY_FORK_DELAY_MS);
      }
    }

    if (prefillPending) {
      const seen = prefillTail + data;
      prefillTail = seen.slice(-BRACKETED_PASTE_MODE_ENABLE.length);
      if (seen.includes(BRACKETED_PASTE_MODE_ENABLE)) {
        prefillPending = false;
        const paste = buildTextPaste(prefill ?? "");
        setTimeout(() => {
          if (activePtyProcesses.get(sessionId) === ptyProcess && paste) ptyProcess.write(paste);
        }, PREFILL_DELAY_MS);
      }
    }

    // Detect when terminal is ready
    if (!terminalReady) {
      dataBuffer += data;

      if (isTerminalReady(dataBuffer, lastReadyCheckPos)) {
        readyChecksCompleted++;
        lastReadyCheckPos = dataBuffer.length;

        if (config.setupCommands && setupCommandsIdx < config.setupCommands.length) {
          const cmd = config.setupCommands[setupCommandsIdx];
          ptyProcess.write(cmd + "\r");
          setupCommandsIdx++;
        } else {
          terminalReady = true;

          // Auto-run the selected coding agent
          if (config.codingAgent === "claude") {
            let settingsPath: string | undefined;
            const hookPath = hookSettingsPath(sessionUuid);
            const statusFile = statusFilePath(sessionUuid);
            try {
              fs.mkdirSync(path.dirname(hookPath), {recursive: true});
              resetStatusFile(sessionUuid);
              const disableFullscreen = (store as any).get("terminalSettings")?.disableClaudeFullscreen === true;
              fs.writeFileSync(hookPath, JSON.stringify(buildHookSettings(statusFile, {disableFullscreen}), null, 2));
              settingsPath = hookPath;
            } catch (error) {
              console.error(`Error writing hook settings file ${hookPath}:`, error);
            }
            const claudeCmd = buildClaudeCommand({
              sessionUuid,
              isNew: isNewSession,
              forkFrom,
              skipPermissions: !!config.skipPermissions,
              mcpConfigPath,
              settingsPath,
            });
            ptyProcess.write(claudeCmd + "\r");
            prefillPending = !!prefill;

            // Start MCP poller immediately (auth is handled by shell environment)
            if (!mcpPollerPtyProcesses.has(sessionId) && projectDir) {
              spawnMcpPoller(sessionId, projectDir);
            }
          } else if (config.codingAgent === "gemini") {
            try {
              resetStatusFile(sessionUuid);
            } catch (error) {
              console.error(`Error preparing status file for Gemini session ${sessionUuid}:`, error);
            }
            const geminiCmd = buildGeminiCommand({
              sessionUuid,
              isNew: isNewSession,
              targetDir: workingDirectory,
              skipPermissions: !!config.skipPermissions,
            });
            ptyProcess.write(geminiCmd + "\r");
            prefillPending = !!prefill;
          } else if (isAgy) {
            try {
              resetStatusFile(sessionUuid);
            } catch (error) {
              console.error(`Error preparing status file for Antigravity session ${sessionUuid}:`, error);
            }
            ptyProcess.write(buildAgyCommand({
              binary: resolveAgyBinary(),
              conversationId: agentConversationId ?? forkFrom,
              skipPermissions: !!config.skipPermissions,
            }) + "\r");
            agyForkPending = !agentConversationId && !!forkFrom;
          } else if (config.codingAgent === "codex") {
            ptyProcess.write("codex\r");
          }
        }
      }
    }
  });

  return ptyProcess;
}

// Git worktree helper functions
// No longer needed since worktrees are in ~/worktrees, not in project directory

async function createWorktree(projectDir: string, parentBranch: string, sessionNumber: number, sessionUuid: string, customBranchName?: string): Promise<{ worktreePath: string; branchName: string }> {
  const projectDirName = getProjectWorktreeDirName(projectDir);
  const worktreesBaseDir = getWorktreeBaseDir();
  const projectWorktreeDir = path.join(worktreesBaseDir, projectDirName);
  const worktreeName = customBranchName || `session${sessionNumber}`;
  let worktreePath = path.join(projectWorktreeDir, worktreeName);

  // Use custom branch name if provided, otherwise generate default
  let branchName: string;
  const shortUuid = sessionUuid.split('-')[0];
  if (customBranchName) {
    branchName = customBranchName;
  } else {
    // Include short UUID to ensure branch uniqueness across deletes/recreates
    branchName = `agentyard/${worktreeName}-${shortUuid}`;
  }

  // Create worktrees directory if it doesn't exist
  if (!fs.existsSync(projectWorktreeDir)) {
    fs.mkdirSync(projectWorktreeDir, { recursive: true });

    // Write marker file to track which project this directory belongs to
    const markerFile = path.join(projectWorktreeDir, WORKTREE_MARKER_FILE);
    fs.writeFileSync(markerFile, projectDir, "utf-8");
  }

  // Append short UUID to worktree path to ensure uniqueness
  if (fs.existsSync(worktreePath)) {
    worktreePath += `-${shortUuid}`;
  }

  // Create new worktree with a new branch from parent branch
  // This creates a new branch named "agentyard/session<N>" starting from the parent branch
  await addWorktree(projectDir, branchName, worktreePath, parentBranch);

  return { worktreePath, branchName };
}

async function removeWorktree(projectDir: string, worktreePath: string) {
  const git = simpleGit(projectDir);
  try {
    await git.raw(["worktree", "remove", worktreePath, "--force"]);
  } catch (error) {
    console.error("Error removing worktree:", error);
  }
}

async function removeGitBranch(projectDir: string, branchName: string) {
  const git = simpleGit(projectDir);
  try {
    await git.raw(["branch", "-D", branchName]);
  } catch (error) {
    console.error("Error removing git branch:", error);
  }
}

// Open directory picker
ipcMain.handle("select-directory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  return result.filePaths[0];
});

// Pane "+" menu: pick files to insert as paths into a session's prompt
ipcMain.handle("select-attachment-files", async (): Promise<{ ok: true; paths: string[] } | { ok: false; error: string }> => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Attach files",
      properties: ["openFile", "multiSelections"],
      filters: [
        {name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"]},
        {name: "PDF", extensions: ["pdf"]},
        {name: "All files", extensions: ["*"]},
      ],
    });
    return {ok: true, paths: result.canceled ? [] : result.filePaths};
  } catch (error) {
    console.error("Error opening the attachment file dialog:", error);
    return {ok: false, error: `File dialog failed: ${error instanceof Error ? error.message : String(error)}`};
  }
});

// Pane "+" menu: save the clipboard image as a PNG under ~/agentyard-scratch/attachments/<sessionUuid>/
ipcMain.handle("save-clipboard-image", (_event, sessionId: string): { ok: true; path: string } | { ok: false; error: string; empty?: boolean } => {
  try {
    const session = getPersistedSessions().find(s => s.id === sessionId);
    if (!session) return {ok: false, error: `Session not found: ${sessionId}`};
    const image = clipboard.readImage();
    if (image.isEmpty()) return {ok: false, empty: true, error: "Clipboard has no image"};

    const dir = attachmentsDir(session.sessionUuid);
    fs.mkdirSync(dir, {recursive: true});
    const now = new Date();
    let n = 1;
    while (fs.existsSync(path.join(dir, attachmentFileName(now, n)))) n++;
    const filePath = path.join(dir, attachmentFileName(now, n));
    fs.writeFileSync(filePath, image.toPNG());
    return {ok: true, path: filePath};
  } catch (error) {
    console.error(`Error saving clipboard image for session ${sessionId}:`, error);
    return {ok: false, error: `Saving clipboard image failed: ${error instanceof Error ? error.message : String(error)}`};
  }
});

// Get git branches from directory
ipcMain.handle("get-branches", async (_event, dirPath: string) => {
  return getBranches(dirPath);
});

// Get last used settings
ipcMain.handle("get-last-settings", () => {
  return (store as any).get("lastSessionConfig", {
    projectDir: "",
    sessionType: SessionType.WORKTREE,
    parentBranch: "",
    codingAgent: "claude",
    skipPermissions: true,
  });
});

// Save settings
ipcMain.on("save-settings", (_event, config: SessionConfig) => {
  (store as any).set("lastSessionConfig", config);
});

function isLocalClaude(session: PersistedSession): boolean {
  return session.config.sessionType === SessionType.LOCAL && session.config.codingAgent === "claude";
}

function hasLivePty(sessionId: string): boolean {
  return activePtyProcesses.has(sessionId) || closingPtys.has(sessionId);
}

// Resolve once a stopped session's PTY has really exited (or after timeoutMs).
async function waitForPtyExit(sessionId: string, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (hasLivePty(sessionId)) {
    if (Date.now() > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return true;
}

// Kill a session's PTY; it counts as running (closingPtys) until its onExit fires.
function stopSessionPty(sessionId: string): void {
  const ptyProcess = activePtyProcesses.get(sessionId);
  if (!ptyProcess) return;
  activePtyProcesses.delete(sessionId);
  closingPtys.set(sessionId, ptyProcess);
  try {
    ptyProcess.kill();
  } catch (error) {
    // kill throws only for a process that is already gone
    closingPtys.delete(sessionId);
    console.error(`Error killing PTY for session ${sessionId}:`, error);
  }
}

function runningSessionDirs(sessions: PersistedSession[]): {sessionId: string; sessionName: string; dir: string}[] {
  return sessions
    .filter(s => hasLivePty(s.id) && s.config.projectDir)
    .map(s => ({sessionId: s.id, sessionName: s.name, dir: s.config.projectDir}));
}

/**
 * Before moving a session's link: when its transcript is still a real file in
 * the source folder, moving it means adopting it, which is only safe when no
 * Claude runs in the source directory and the file is no longer written.
 * Returns an error message, or null when the move may proceed.
 */
function checkMoveSource(
  session: PersistedSession,
  sessions: PersistedSession[],
  external: ReturnType<typeof scanClaudeProcesses>,
): string | null {
  const srcDir = session.linkedDir || session.config.projectDir;
  if (!srcDir) return null;
  const mtimeMs = pendingAdoptionMtime(claudeProjectFolder(srcDir), session.sessionUuid, centralSessionsDir());
  if (mtimeMs === null) return null;
  const check = canAdoptForMove({
    srcDir,
    external,
    mtimeMs,
    now: Date.now(),
  });
  return check.ok ? null : check.error;
}

/**
 * Fresh safety gate before a local Claude session is launched or its transcript
 * moved (see checkSessionGate). `moving` also checks a real source that the
 * move would adopt. Fails closed when the process scan fails.
 * Returns an error (must not proceed) or an optional warning (may proceed).
 */
function localClaudeGate(
  sessions: PersistedSession[],
  opts: {sessionId: string; sessionUuid?: string; sourceDir?: string; targetDir: string; moving?: PersistedSession},
): {error?: string; warning?: string} {
  let external: ReturnType<typeof scanClaudeProcesses>;
  try {
    external = scanClaudeProcesses();
  } catch (error) {
    console.error("Error scanning claude processes:", error);
    return {error: "Could not check running Claude processes; try again"};
  }
  const gate = checkSessionGate({
    external,
    running: runningSessionDirs(sessions),
    sessionId: opts.sessionId,
    sessionUuid: opts.sessionUuid,
    sourceDir: opts.sourceDir,
    targetDir: opts.targetDir,
  });
  if (!gate.ok) return {error: gate.error};
  const moveError = opts.moving ? checkMoveSource(opts.moving, sessions, external) : null;
  if (moveError) return {error: moveError};
  return {warning: gate.warning};
}

// Create new session
ipcMain.on("create-session", async (event, request: SessionConfig & {projectId?: string}) => {
  try {
    const {projectId: requestedProjectId, ...config} = request;
    ensureScratchDir(config.projectDir);

    // Local Claude runs in the directory itself: warn when other agents already work there
    let launchWarning: string | undefined;
    if (config.sessionType === SessionType.LOCAL && config.codingAgent === "claude") {
      const gate = localClaudeGate(getPersistedSessions(), {sessionId: "", targetDir: config.projectDir});
      if (gate.error) {
        event.reply("session-error", gate.error);
        return;
      }
      launchWarning = gate.warning;
    }
    const sessionNumber = getNextSessionNumber();
    const sessionId = `session-${Date.now()}`;

    // Use custom branch name as session name if provided, otherwise default
    const sessionName = config.branchName || `Session ${sessionNumber}`;

    // Generate UUID for this session
    const sessionUuid = uuidv4();

    let worktreePath: string | undefined;
    let workingDirectory: string;
    let branchName: string | undefined;
    let mcpConfigPath: string | undefined;

    if (config.sessionType === SessionType.WORKTREE) {
      // Validate that parentBranch is provided for worktree sessions
      if (!config.parentBranch) {
        throw new Error("Parent branch is required for worktree sessions");
      }

      // Create git worktree with custom or default branch name
      const worktreeResult = await createWorktree(config.projectDir, config.parentBranch, sessionNumber, sessionUuid, config.branchName);
      worktreePath = worktreeResult.worktreePath;
      workingDirectory = worktreeResult.worktreePath;
      branchName = worktreeResult.branchName;

      // Extract and write MCP config
      const mcpServers = extractProjectMcpConfig(config.projectDir);
      mcpConfigPath = writeMcpConfigFile(config.projectDir, mcpServers) || undefined;
    } else {
      // For local sessions, use the project directory directly (no worktree)
      worktreePath = undefined;
      workingDirectory = config.projectDir;
      branchName = undefined;
      mcpConfigPath = undefined;
    }

    // Create persisted session metadata
    const persistedSession: PersistedSession = {
      id: sessionId,
      number: sessionNumber,
      name: sessionName,
      config,
      worktreePath,
      createdAt: Date.now(),
      sessionUuid,
      mcpConfigPath,
      gitBranch: branchName,
    };

    persistedSession.projectId = requestedProjectId ?? findProjectForDir(getProjects(), config.projectDir)?.id;

    // Like Claude's, an Antigravity session takes its name from the conversation (agy's title)
    if (config.codingAgent === "antigravity") {
      persistedSession.origin = "agentyard";
      persistedSession.manualName = false;
      persistedSession.lastActivity = Date.now();
    }

    if (isLocalClaude(persistedSession)) {
      persistedSession.origin = "agentyard";
      persistedSession.manualName = false;
      persistedSession.linkedDir = config.projectDir;
      persistedSession.lastActivity = Date.now();
    }

    // Save to store
    const sessions = getPersistedSessions();
    sessions.push(persistedSession);
    savePersistedSessions(sessions);

    // Spawn PTY in the appropriate directory
    spawnSessionPty(sessionId, workingDirectory, config, sessionUuid, true, mcpConfigPath, config.projectDir);

    event.reply("session-created", sessionId, persistedSession);
    if (launchWarning) event.reply("session-warning", launchWarning);
  } catch (error) {
    console.error("Error creating session:", error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    event.reply("session-error", errorMessage);
  }
});

// Handle session input
ipcMain.on("session-input", (_event, sessionId: string, data: string) => {
  const ptyProcess = activePtyProcesses.get(sessionId);

  if (ptyProcess) {
    ptyProcess.write(data);
    // A rejected permission prompt fires no Stop hook; reset WAITING on user input.
    // Focus reports and DA/CPR replies come from xterm itself, not the user.
    if (!isTerminalReportOnly(data)) applySessionStatus(sessionId, statusOnUserInput);
  }
});

// Renderer reports which session the user is looking at
ipcMain.on("session-viewed", (_event, sessionId: string | null) => {
  viewedSessionId = sessionId;
  if (sessionId) applySessionStatus(sessionId, statusOnView);
});

// Handle session resize
ipcMain.on("session-resize", (_event, sessionId: string, cols: number, rows: number) => {
  const ptyProcess = activePtyProcesses.get(sessionId);
  if (ptyProcess) {
    ptyProcess.resize(cols, rows);
  }
});

// ---- Side shell: a plain login shell in the session's directory, shown under its agent ----

function stopSideShell(sessionId: string): void {
  const ptyProcess = sideShellPtys.get(sessionId);
  if (!ptyProcess) return;
  sideShellPtys.delete(sessionId);
  try {
    ptyProcess.kill();
  } catch (error) {
    console.error(`Error killing the side shell of session ${sessionId}:`, error);
  }
}

ipcMain.handle("side-shell-start", (_event, sessionId: string, cols: number, rows: number): {ok: true} | {ok: false; error: string} => {
  if (sideShellPtys.has(sessionId)) return {ok: true};
  const session = getPersistedSessions().find(s => s.id === sessionId);
  if (!session) return {ok: false, error: `Session not found: ${sessionId}`};
  const cwd = session.worktreePath || session.config.projectDir;
  if (!cwd || !fs.existsSync(cwd)) return {ok: false, error: `Directory not found: ${cwd || "(none)"}`};
  try {
    const env = getPtyEnv(sessionId);
    // An agent started in this shell must not report as the session's own agent
    delete env.AGENTYARD_SESSION_ID;
    const shell = os.platform() === "darwin" ? "zsh" : "bash";
    const ptyProcess = pty.spawn(shell, ["-l"], {name: "xterm-256color", cols: Math.max(2, cols), rows: Math.max(2, rows), cwd, env});
    sideShellPtys.set(sessionId, ptyProcess);
    ptyProcess.onData((data) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("side-shell-output", sessionId, data);
    });
    ptyProcess.onExit(() => {
      // A late exit of a shell already replaced must not close the new one
      if (sideShellPtys.get(sessionId) !== ptyProcess) return;
      sideShellPtys.delete(sessionId);
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("side-shell-exit", sessionId);
    });
    return {ok: true};
  } catch (error) {
    return {ok: false, error: `Starting a shell in ${cwd} failed: ${error instanceof Error ? error.message : String(error)}`};
  }
});

// Pane breadcrumb: open the session's directory (its worktree when it has one) in the editor chosen
// in Settings (a preset, or a custom command run without a shell)
ipcMain.handle("open-in-editor", async (_event, sessionId: string): Promise<{ok: true} | {ok: false; error: string}> => {
  const session = getPersistedSessions().find(s => s.id === sessionId);
  if (!session) return {ok: false, error: `Session not found: ${sessionId}`};
  const dir = session.worktreePath || session.config.projectDir;
  if (!dir || !fs.existsSync(dir)) return {ok: false, error: `Directory not found: ${dir || "(none)"}`};
  const settings = (store as any).get("terminalSettings") ?? {};
  const launch = buildEditorLaunch({
    editorId: typeof settings.editor === "string" ? settings.editor : DEFAULT_EDITOR_ID,
    customCommand: typeof settings.editorCommand === "string" ? settings.editorCommand : "",
    dir,
    pathEnv: process.env.PATH,
    platform: os.platform(),
    home: os.homedir(),
    exists: p => fs.existsSync(p),
  });
  if (!launch.ok) return launch;
  return new Promise(resolve => {
    try {
      const child = spawn(launch.file, launch.args, {detached: true, stdio: "ignore", env: editorEnv(process.env)});
      child.once("error", (error) => resolve({ok: false, error: `Opening ${launch.file} failed: ${error.message}`}));
      child.once("spawn", () => {
        child.unref();
        resolve({ok: true});
      });
    } catch (error) {
      resolve({ok: false, error: `Opening ${launch.file} failed: ${error instanceof Error ? error.message : String(error)}`});
    }
  });
});

ipcMain.on("side-shell-input", (_event, sessionId: string, data: string) => {
  sideShellPtys.get(sessionId)?.write(data);
});

ipcMain.on("side-shell-resize", (_event, sessionId: string, cols: number, rows: number) => {
  try {
    sideShellPtys.get(sessionId)?.resize(Math.max(2, cols), Math.max(2, rows));
  } catch (error) {
    console.error(`Error resizing the side shell of session ${sessionId}:`, error);
  }
});

ipcMain.on("side-shell-stop", (_event, sessionId: string) => {
  stopSideShell(sessionId);
});

// Reopen session (spawn new PTY for existing session)
ipcMain.on("reopen-session", (event, sessionId: string) => {
  // Check if PTY already active
  if (activePtyProcesses.has(sessionId)) {
    event.reply("session-reopened", sessionId);
    return;
  }

  // Find persisted session
  const sessions = getPersistedSessions();
  const session = sessions.find(s => s.id === sessionId);

  if (!session) {
    console.error("Session not found:", sessionId);
    return;
  }

  let isNew = false;
  let forkFrom: string | undefined;
  if (isLocalClaude(session)) {
    const dir = session.config.projectDir;
    if (dir === "") {
      event.reply("session-needs-dir", sessionId);
      return;
    }
    if (closingPtys.has(sessionId)) {
      event.reply("session-error", "Session is still closing; try again shortly");
      return;
    }
    try {
      if (lastExternallyOpen.has(session.sessionUuid.toLowerCase())) {
        throw new Error("Session is open elsewhere");
      }
      const sourceDir = session.linkedDir || dir;
      // A session whose Claude never wrote anything starts fresh with its uuid.
      isNew = !transcriptExists(session.sessionUuid, [sourceDir, dir], os.homedir(), centralSessionsDir());
      const moving = !isNew && session.linkedDir !== dir;
      const gate = localClaudeGate(sessions, {
        sessionId,
        sessionUuid: session.sessionUuid,
        sourceDir,
        targetDir: dir,
        moving: moving ? session : undefined,
      });
      if (gate.error) throw new Error(gate.error);
      if (gate.warning) event.reply("session-warning", gate.warning);
      if (session.linkedDir !== dir) {
        if (moving) moveSessionLink(session, dir, os.homedir(), centralSessionsDir());
        session.linkedDir = dir;
        savePersistedSessions(sessions);
      }
      // A fork whose Claude never wrote its own transcript yet (closed before the first message)
      // must start as a fork again, not as an empty session; Claude reads the source from `dir`.
      if (isNew && session.forkedFrom) {
        const sourceState = inspectTranscript(claudeProjectFolder(dir), session.forkedFrom, centralSessionsDir());
        if (sourceState === "real" || sourceState === "link-ok") {
          forkFrom = session.forkedFrom;
        } else {
          event.reply("session-warning", "The original conversation of this fork is not in this directory; starting an empty session");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error preparing session ${sessionId} to reopen:`, error);
      event.reply("session-error", message);
      return;
    }
  }

  // For non-worktree sessions, use project directory; otherwise use worktree path
  const workingDir = session.worktreePath || session.config.projectDir;
  try {
    ensureScratchDir(workingDir);
  } catch (error) {
    console.error(`Error preparing directory of session ${sessionId}:`, error);
    event.reply("session-error", error instanceof Error ? error.message : String(error));
    return;
  }

  // An agy fork closed before its first prompt never got its own conversation: fork again
  if (session.config.codingAgent === "antigravity" && !session.agentConversationId) forkFrom = session.forkedFrom;

  // Spawn new PTY in the appropriate directory
  spawnSessionPty(sessionId, workingDir, session.config, session.sessionUuid, isNew, session.mcpConfigPath, session.config.projectDir, forkFrom, undefined, session.agentConversationId);

  event.reply("session-reopened", sessionId);
});

// Close session (kill PTY but keep session)
ipcMain.on("close-session", (_event, sessionId: string) => {
  stopSessionPty(sessionId);
  stopSideShell(sessionId);
  settleSessionStatus(sessionId);
  if (viewedSessionId === sessionId) viewedSessionId = null;

  // Kill MCP poller if active
  const mcpPoller = mcpPollerPtyProcesses.get(sessionId);
  if (mcpPoller) {
    mcpPoller.kill();
    mcpPollerPtyProcesses.delete(sessionId);
  }
});

// Delete session (kill PTY, remove worktree, delete from store)
ipcMain.on("delete-session", async (_event, sessionId: string) => {
  // Kill PTY if active
  stopSessionPty(sessionId);
  stopSideShell(sessionId);

  // Kill MCP poller if active
  const mcpPoller = mcpPollerPtyProcesses.get(sessionId);
  if (mcpPoller) {
    mcpPoller.kill();
    mcpPollerPtyProcesses.delete(sessionId);
  }

  // Find and remove from persisted sessions
  const session = getPersistedSessions().find(s => s.id === sessionId);

  if (!session) {
    console.error("Session not found:", sessionId);
    return;
  }

  // Only clean up git worktree and branch for worktree sessions
  if (session.config.sessionType === SessionType.WORKTREE && session.worktreePath) {
    // Remove git worktree
    await removeWorktree(session.config.projectDir, session.worktreePath);

    // Remove git branch if it exists
    if (session.gitBranch) {
      await removeGitBranch(session.config.projectDir, session.gitBranch);
    }
  }

  // Local Claude: hide the transcript from sync so it is not re-imported. Files are never touched.
  if (isLocalClaude(session)) {
    addHiddenUuid(session.sessionUuid);
  }

  // Remove from store. Re-read: sync, status and rename may have saved while git cleanup ran.
  savePersistedSessions(getPersistedSessions().filter(s => s.id !== sessionId));

  mainWindow.webContents.send("session-deleted", sessionId);
});

// Sticky prompt bar: the user's prompts from a session's transcript, read incrementally per uuid
const promptHistories = new Map<string, PromptHistory>();

// Central store first; a transcript not yet adopted still lives in the project folder
function sessionTranscriptFile(session: PersistedSession): string | undefined {
  const candidates = [path.join(centralSessionsDir(), `${session.sessionUuid}.jsonl`)];
  const dir = session.linkedDir || session.config.projectDir;
  if (dir) candidates.push(path.join(claudeProjectFolder(dir), `${session.sessionUuid}.jsonl`));
  return candidates.find(f => fs.existsSync(f));
}

function readSessionPrompts(session: PersistedSession): PromptHistory | undefined {
  const file = sessionTranscriptFile(session);
  if (!file) return undefined;
  const history = readUserPrompts(file, promptHistories.get(session.sessionUuid));
  promptHistories.set(session.sessionUuid, history);
  return history;
}

// Preview of an [Image #N] label: the transcript holds the image once its prompt is sent
ipcMain.handle("get-session-image", async (_event, sessionId: string, imageId: number): Promise<{ok: true; image: PastedImage} | {ok: false; error: string}> => {
  const notFound = {ok: false as const, error: `Image #${imageId} is not in the transcript yet: it can be previewed once its prompt is sent`};
  try {
    const session = getPersistedSessions().find(s => s.id === sessionId);
    const file = session && sessionTranscriptFile(session);
    if (!file) return notFound;
    const image = findPastedImage(await fs.promises.readFile(file, "utf-8"), imageId);
    return image ? {ok: true, image} : notFound;
  } catch (error) {
    console.error("Error reading a session image:", error);
    return {ok: false, error: `Could not read Image #${imageId}: ${error instanceof Error ? error.message : String(error)}`};
  }
});

ipcMain.handle("get-session-prompts", (_event, sessionId: string): string[] => {
  const session = getPersistedSessions().find(s => s.id === sessionId);
  if (!session) return [];
  if (session.config.codingAgent === "gemini") {
    const dir = session.worktreePath || session.config.projectDir;
    return readGeminiPromptsAndModel(dir, undefined, session.sessionUuid).prompts;
  }
  if (session.config.codingAgent === "antigravity") return agyPromptsOf(session, getPersistedSessions());
  try {
    return readSessionPrompts(session)?.prompts ?? [];
  } catch (error) {
    console.error(`Error reading prompts of session ${sessionId}:`, error);
    return promptHistories.get(session.sessionUuid)?.prompts ?? [];
  }
});

// Pane toolbar model menu for Antigravity: `agy models` takes seconds, so it is read once, async
let agyModelsCache: Promise<AgyModelFamily[]> | null = null;
ipcMain.handle("get-agy-models", (): Promise<AgyModelFamily[]> => {
  agyModelsCache ??= new Promise(resolve => {
    execFile(resolveAgyBinary(), ["models"], {timeout: 30000}, (error, stdout) => {
      const families = error ? [] : groupAgyModels(stdout);
      if (error) console.error("Reading Antigravity models failed:", error);
      if (families.length === 0) agyModelsCache = null; // try again next time
      resolve(families.length > 0 ? families : AGY_FALLBACK_MODELS);
    });
  });
  return agyModelsCache;
});

// The agentyard-status plugin carries agy's hooks; set up once per app start, never re-enabled
let agyPluginResult: AgyPluginResult | null = null;
function setUpAgyStatusPlugin(): void {
  ensureAgySnapBridge();
  const binary = resolveAgyBinary();
  agyPluginResult = ensureAgyStatusPlugin({
    binary,
    sourceDir: path.join(appHome(), "agy-plugin", "agentyard-status"),
    run: args => {
      const result = spawnSync(binary, args, {encoding: "utf8", timeout: 30000});
      if (result.error) throw result.error;
      return {status: result.status, stdout: result.stdout, stderr: result.stderr};
    },
  });
  // No agy installed: nothing to report
  if (!agyPluginResult.ok && agyPluginResult.reason === "failed" && /ENOENT/.test(agyPluginResult.message)) agyPluginResult = {ok: true};
  if (!agyPluginResult.ok) console.error(agyPluginResult.message);
}
ipcMain.handle("agy-plugin-status", (): AgyPluginResult => agyPluginResult ?? {ok: true});

// Pane toolbar voice button: Gemini CLI has /voice only with experimental.voiceMode on
ipcMain.handle("gemini-voice-enabled", (_event, sessionId: string): boolean => {
  const session = getPersistedSessions().find(s => s.id === sessionId);
  if (!session) return false;
  return isGeminiVoiceModeEnabled(os.homedir(), session.worktreePath || session.config.projectDir);
});

// Pane toolbar: model and effort of the session's last reply, read from its transcript
const sessionModels = new Map<string, SessionModel>();

ipcMain.handle("get-session-model", (_event, sessionId: string): {model?: string; effort?: string} => {
  const session = getPersistedSessions().find(s => s.id === sessionId);
  if (!session) return {};
  // Antigravity's transcript has no model: the renderer reads model and effort from its footer
  if (session.config.codingAgent === "antigravity") return {};
  if (session.config.codingAgent === "gemini") {
    const dir = session.worktreePath || session.config.projectDir;
    // No model before the first reply: the renderer keeps a model chosen from the menu meanwhile
    return {model: readGeminiPromptsAndModel(dir, undefined, session.sessionUuid).model};
  }
  const file = sessionTranscriptFile(session);
  if (!file) return {};
  try {
    const state = readSessionModel(file, sessionModels.get(session.sessionUuid));
    sessionModels.set(session.sessionUuid, state);
    return {model: state.model, effort: state.effort};
  } catch (error) {
    console.error(`Error reading the model of session ${sessionId}:`, error);
    const state = sessionModels.get(session.sessionUuid);
    return {model: state?.model, effort: state?.effort};
  }
});

// Pane toolbar: slash commands and skills available in the session's working directory
ipcMain.handle("list-slash-commands", (_event, sessionId: string): SlashCommand[] => {
  const session = getPersistedSessions().find(s => s.id === sessionId);
  const projectDir = session ? (session.worktreePath || session.linkedDir || session.config.projectDir) : undefined;
  try {
    if (session?.config.codingAgent === "gemini") {
      return listGeminiSlashCommands({home: os.homedir(), projectDir});
    }
    if (session?.config.codingAgent === "antigravity") {
      return listAntigravitySlashCommands({home: os.homedir(), projectDir});
    }
    return listSlashCommands({home: os.homedir(), projectDir});
  } catch (error) {
    console.error(`Error listing slash commands for session ${sessionId}:`, error);
    return [];
  }
});

// Get all persisted sessions
ipcMain.handle("get-all-sessions", () => {
  return getPersistedSessions();
});

// Rename session
ipcMain.on("rename-session", (_event, sessionId: string, newName: string) => {
  const sessions = getPersistedSessions();
  const session = sessions.find(s => s.id === sessionId);

  if (session) {
    session.name = newName;
    session.manualName = true;
    savePersistedSessions(sessions);
  }
});

// Fork a local Claude session: a new session that starts as a copy of the conversation.
// It runs in the original's directory, where Claude can read the original transcript.
// Shared by both forks: checks the original and prepares (but does not save) the fork's record
function prepareFork(sessions: PersistedSession[], sessionId: string): {original: PersistedSession; fork: PersistedSession; dir: string; warning?: string} {
  const original = sessions.find(s => s.id === sessionId);
  if (!original) throw new Error("Session not found");
  if (!isLocalClaude(original)) throw new Error("Only local Claude sessions can be forked");
  const dir = original.linkedDir || original.config.projectDir;
  if (!dir) throw new Error("Choose a directory for this session first");
  ensureScratchDir(dir);
  const linkState = inspectTranscript(claudeProjectFolder(dir), original.sessionUuid, centralSessionsDir());
  if (linkState !== "real" && linkState !== "link-ok") {
    throw new Error("This conversation has no messages yet; nothing to fork");
  }

  const forkId = `session-${Date.now()}`;
  const gate = localClaudeGate(sessions, {sessionId: forkId, targetDir: dir});
  if (gate.error) throw new Error(gate.error);

  const fork: PersistedSession = {
    id: forkId,
    number: getNextSessionNumber(),
    name: `${original.name} (fork)`,
    config: {...original.config, projectDir: dir},
    createdAt: Date.now(),
    sessionUuid: uuidv4(),
    projectId: original.projectId,
    origin: "agentyard",
    manualName: true,
    lastActivity: Date.now(),
    linkedDir: dir,
  };
  return {original, fork, dir, warning: gate.warning};
}

// An agy fork: a new local session in the same directory that opens the original conversation and
// sends /fork; agy then works on a copy and the original stays as it was (see spawnSessionPty)
function prepareAgyFork(sessions: PersistedSession[], original: PersistedSession): PersistedSession {
  if (original.config.sessionType !== SessionType.LOCAL) throw new Error("Only local sessions can be forked");
  if (!original.agentConversationId) throw new Error("This conversation has no messages yet; nothing to fork");
  return {
    id: `session-${Date.now()}`,
    number: getNextSessionNumber(),
    name: `${original.name} (fork)`,
    config: {...original.config},
    createdAt: Date.now(),
    sessionUuid: uuidv4(),
    projectId: original.projectId,
    origin: "agentyard",
    manualName: true,
    lastActivity: Date.now(),
    forkedFrom: original.agentConversationId,
    // agy's fork transcript starts after the fork: its prompt list begins with these of the original
    forkedPromptCount: agyPromptsOf(original, sessions).length,
  };
}

ipcMain.on("fork-session", (event, sessionId: string) => {
  const agyOriginal = getPersistedSessions().find(s => s.id === sessionId && s.config.codingAgent === "antigravity");
  if (agyOriginal) {
    try {
      const sessions = getPersistedSessions();
      const fork = prepareAgyFork(sessions, agyOriginal);
      sessions.push(fork);
      savePersistedSessions(sessions);
      const dir = fork.config.projectDir;
      spawnSessionPty(fork.id, dir, fork.config, fork.sessionUuid, true, undefined, dir, fork.forkedFrom);
      event.reply("session-created", fork.id, fork);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error forking Antigravity session ${sessionId}:`, error);
      event.reply("session-error", `Fork failed: ${message}`);
    }
    return;
  }
  try {
    const sessions = getPersistedSessions();
    const {original, fork, dir, warning} = prepareFork(sessions, sessionId);
    fork.forkedFrom = original.sessionUuid;
    sessions.push(fork);
    savePersistedSessions(sessions);

    spawnSessionPty(fork.id, dir, fork.config, fork.sessionUuid, true, undefined, dir, original.sessionUuid);
    event.reply("session-created", fork.id, fork);
    if (warning) event.reply("session-warning", warning);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error forking session ${sessionId}:`, error);
    event.reply("session-error", `Fork failed: ${message}`);
  }
});

// Fork ending right before one of the user's prompts: Agentyard writes the fork's transcript (see
// fork-transcript.ts) and Claude resumes it with that prompt waiting, unsent, in the input box.
// No forkedFrom: re-forking the whole original would be wrong if this transcript went missing.
ipcMain.on("fork-session-at", (event, sessionId: string, promptIndex: number, promptText: string) => {
  try {
    const sessions = getPersistedSessions();
    const {original, fork, dir, warning} = prepareFork(sessions, sessionId);
    const source = sessionTranscriptFile(original);
    const history = readSessionPrompts(original);
    if (!source || !history) throw new Error("The conversation's transcript was not found");
    // The renderer's list may be stale: the index must still point at the same prompt
    const promptUuid = history.uuids[promptIndex];
    if (history.prompts[promptIndex] !== promptText || !promptUuid) {
      throw new Error("The conversation changed; open the prompt list again");
    }

    const entries: any[] = [];
    for (const line of fs.readFileSync(source, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {
        // skip a broken line, as Claude Code does
      }
    }
    const lines = buildForkTranscript(entries, promptUuid, {
      forkUuid: fork.sessionUuid,
      newUuid: uuidv4,
      now: new Date().toISOString(),
      title: fork.name,
    });
    const folder = claudeProjectFolder(dir);
    fs.mkdirSync(folder, {recursive: true});
    const target = path.join(folder, `${fork.sessionUuid}.jsonl`);
    fs.writeFileSync(target, lines.join("\n") + "\n", {flag: "wx"});

    sessions.push(fork);
    savePersistedSessions(sessions);
    spawnSessionPty(fork.id, dir, fork.config, fork.sessionUuid, false, undefined, dir, undefined, promptText);
    event.reply("session-created", fork.id, fork);
    if (warning) event.reply("session-warning", warning);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Error forking session ${sessionId} at prompt ${promptIndex + 1}:`, error);
    event.reply("session-error", `Fork failed: ${message}`);
  }
});

// `restart`: the session may be running; stop it and wait for its PTY to exit before moving
// (the renderer reopens it in the new directory afterwards).
ipcMain.handle("set-session-dir", async (_event, sessionId: string, dir: string, restart = false): Promise<{ ok: true; session: PersistedSession; warning?: string } | { ok: false; error: string }> => {
  try {
    if (hasLivePty(sessionId)) {
      if (!restart) return {ok: false, error: "Stop the session first"};
      stopSessionPty(sessionId);
      if (!(await waitForPtyExit(sessionId))) return {ok: false, error: "The session did not stop in time; try again"};
    }
    const sessions = getPersistedSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return {ok: false, error: `Session not found: ${sessionId}`};
    if (!isLocalClaude(session)) return {ok: false, error: "Only local Claude sessions can switch directory"};
    if (lastExternallyOpen.has(session.sessionUuid.toLowerCase())) return {ok: false, error: "Session is open elsewhere"};

    const project = getProjects().find(p => p.id === session.projectId);
    const target = project?.dirs.find(d => path.resolve(d) === path.resolve(dir));
    if (!target) return {ok: false, error: "Directory is not in this project"};

    const oldDir = session.linkedDir || session.config.projectDir;
    // A session whose Claude never wrote anything has no link to move: only the record changes.
    const exists = transcriptExists(session.sessionUuid, [oldDir, target], os.homedir(), centralSessionsDir());
    const gate = localClaudeGate(sessions, {
      sessionId,
      sessionUuid: session.sessionUuid,
      sourceDir: oldDir || undefined,
      targetDir: target,
      moving: exists ? session : undefined,
    });
    if (gate.error) return {ok: false, error: gate.error};

    if (exists) moveSessionLink(session, target, os.homedir(), centralSessionsDir());
    try {
      session.config.projectDir = target;
      session.linkedDir = target;
      savePersistedSessions(sessions);
    } catch (saveError) {
      // The link moved but the record did not: put the link back where the record says it is.
      let rollback = "";
      if (exists && oldDir) {
        try {
          relinkTranscript(claudeProjectFolder(target), claudeProjectFolder(oldDir), session.sessionUuid, centralSessionsDir());
        } catch (rollbackError) {
          rollback = ` (rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)})`;
        }
      }
      throw new Error(`Failed to save session: ${saveError instanceof Error ? saveError.message : String(saveError)}${rollback}`);
    }
    return {ok: true, session, warning: gate.warning};
  } catch (error) {
    console.error(`Error switching directory of session ${sessionId} to ${dir}:`, error);
    return {ok: false, error: error instanceof Error ? error.message : String(error)};
  }
});

// Takes effect on the next launch of the session.
// Only the sidebar's listing changes: a running session keeps running
ipcMain.handle("set-session-archived", (_event, sessionId: string, archived: boolean): {ok: true} | {ok: false; error: string} => {
  try {
    const sessions = getPersistedSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) return {ok: false, error: `Session not found: ${sessionId}`};
    if (archived) session.archived = true;
    else delete session.archived;
    savePersistedSessions(sessions);
    return {ok: true};
  } catch (error) {
    return {ok: false, error: `Archiving session ${sessionId} failed: ${error instanceof Error ? error.message : String(error)}`};
  }
});

ipcMain.handle("set-skip-permissions", (_event, sessionId: string, value: boolean): void => {
  try {
    const sessions = getPersistedSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) {
      console.error("Session not found:", sessionId);
      return;
    }
    session.config.skipPermissions = !!value;
    savePersistedSessions(sessions);
  } catch (error) {
    console.error(`Error setting skip-permissions for session ${sessionId}:`, error);
  }
});

// Terminal settings handlers
ipcMain.handle("get-terminal-settings", () => {
  return (store as any).get("terminalSettings");
});

ipcMain.handle("save-terminal-settings", (_event, settings: any) => {
  (store as any).set("terminalSettings", settings);
});

// Get app version
ipcMain.handle("get-app-version", () => {
  return app.getVersion();
});

// Apply session changes to project
ipcMain.handle("apply-session-to-project", async (_event, sessionId: string) => {
  try {
    const sessions = getPersistedSessions();
    const session = sessions.find(s => s.id === sessionId);

    if (!session) {
      return { success: false, error: "Session not found" };
    }

    if (session.config.sessionType !== SessionType.WORKTREE) {
      return { success: false, error: "Only worktree sessions can be applied to project" };
    }

    if (!session.worktreePath || !session.config.parentBranch) {
      return { success: false, error: "Session missing worktree path or parent branch" };
    }

    const projectDir = session.config.projectDir;
    const worktreePath = session.worktreePath;
    const parentBranch = session.config.parentBranch;
    const patchFilename = `agentyard-patch-${Date.now()}.patch`;
    const patchPath = path.join("/tmp", patchFilename);

    // Generate patch file from parent branch to current state (includes commits + unstaged changes)
    // Using diff against parent branch to capture all changes
    const patchContent = await diffAgainstBranch(worktreePath, parentBranch);

    // If patch is empty, there are no changes to apply
    if (!patchContent.trim()) {
      return { success: false, error: "No changes to apply" };
    }

    // Write patch to temp file
    fs.writeFileSync(patchPath, patchContent);

    // Apply patch to original project directory
    try {
      await execAsync(`git apply "${patchPath}"`, { cwd: projectDir });

      // Clean up patch file on success
      fs.unlinkSync(patchPath);

      return { success: true };
    } catch (applyError: any) {
      // Clean up patch file on error
      if (fs.existsSync(patchPath)) {
        fs.unlinkSync(patchPath);
      }

      return {
        success: false,
        error: `Failed to apply patch: ${applyError.message || applyError}`
      };
    }
  } catch (error: any) {
    return {
      success: false,
      error: error.message || String(error)
    };
  }
});

// MCP Server management functions
async function listMcpServers() {
  try {
    const { stdout } = await execAsync("claude mcp list");

    return parseMcpListOutput(stdout);
  } catch (error) {
    console.error("Error listing MCP servers:", error);
    return [];
  }
}

// Spawn a dedicated PTY for running claude commands
function spawnClaudeCommandRunner() {
  if (claudeCommandRunnerPty) {
    return;
  }

  const shell = os.platform() === "darwin" ? "zsh" : "bash";
  claudeCommandRunnerPty = pty.spawn(shell, ["-l"], {
    name: "xterm-color",
    cols: 80,
    rows: 30,
    cwd: os.homedir(),
    env: getPtyEnv("command-runner"),
  });
}

// Execute claude command in dedicated PTY
async function execClaudeCommand(command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!claudeCommandRunnerPty) {
      reject(new Error("Claude command runner PTY not initialized"));
      return;
    }

    const pty = claudeCommandRunnerPty;
    let outputBuffer = "";
    let timeoutId: NodeJS.Timeout;
    let disposed = false;

    const dataHandler = pty.onData((data: string) => {
      if (disposed) return;

      outputBuffer += data;

      // Check if command completed (prompt returned)
      if (isTerminalReady(data)) {
        disposed = true;
        clearTimeout(timeoutId);
        dataHandler.dispose();

        // Extract just the command output (remove the command echo and prompt lines)
        const lines = outputBuffer.split('\n');
        const output = lines.slice(1, -1).join('\n').trim();
        resolve(output);
      }
    });

    // Set timeout
    timeoutId = setTimeout(() => {
      if (!disposed) {
        disposed = true;
        dataHandler.dispose();
        reject(new Error("Command timeout"));
      }
    }, 10000);

    pty.write(command + "\r");
  });
}

async function addMcpServer(name: string, config: any) {
  // Use add-json to support full configuration including env vars, headers, etc.
  await execClaudeCommand(mcpAddJsonCommand(name, config));
}

async function removeMcpServer(name: string) {
  await execClaudeCommand(mcpRemoveCommand(name));
}

async function getMcpServerDetails(name: string) {
  try {
    const output = await execClaudeCommand(mcpGetCommand(name));

    // Parse the output to extract details
    const details: any = { name };
    const lines = output.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.includes("Scope:")) {
        details.scope = trimmed.replace("Scope:", "").trim();
      } else if (trimmed.includes("Status:")) {
        details.status = trimmed.replace("Status:", "").trim();
      } else if (trimmed.includes("Type:")) {
        details.type = trimmed.replace("Type:", "").trim();
      } else if (trimmed.includes("URL:")) {
        details.url = trimmed.replace("URL:", "").trim();
      } else if (trimmed.includes("Command:")) {
        details.command = trimmed.replace("Command:", "").trim();
      } else if (trimmed.includes("Args:")) {
        details.args = trimmed.replace("Args:", "").trim();
      }
    }

    return details;
  } catch (error) {
    console.error("Error getting MCP server details:", error);
    throw error;
  }
}

ipcMain.handle("list-mcp-servers", async (_event, sessionId: string) => {
  try {
    // Trigger an immediate MCP list command in the session's poller
    const mcpPoller = mcpPollerPtyProcesses.get(sessionId);
    if (mcpPoller) {
      mcpPoller.write(MCP_LIST_COMMAND + "\r");
    }
    // Return empty array - actual results will come via mcp-servers-updated event
    return [];
  } catch (error) {
    console.error("Error listing MCP servers:", error);
    return [];
  }
});

ipcMain.handle("add-mcp-server", async (_event, name: string, config: any) => {
  try {
    await addMcpServer(name, config);
  } catch (error) {
    console.error("Error adding MCP server:", error);
    throw error;
  }
});

ipcMain.handle("remove-mcp-server", async (_event, name: string) => {
  try {
    await removeMcpServer(name);
  } catch (error) {
    console.error("Error removing MCP server:", error);
    throw error;
  }
});

ipcMain.handle("get-mcp-server-details", async (_event, name: string) => {
  try {
    return await getMcpServerDetails(name);
  } catch (error) {
    console.error("Error getting MCP server details:", error);
    throw error;
  }
});

ipcMain.handle("get-projects", () => getProjects());

ipcMain.handle("save-project", (_event, project: Project): { ok: true } | { ok: false; error: string } => {
  try {
    // The built-in standalone project keeps its id and name and never ends up without a directory.
    const standalone = isStandaloneProject(project.id);
    const name = standalone ? STANDALONE_PROJECT_NAME : (project.name ?? "").trim();
    if (!name) return {ok: false, error: "Project name is required"};
    for (const dir of project.dirs) {
      if (!path.isAbsolute(dir)) return {ok: false, error: `Directory must be an absolute path: ${dir}`};
    }
    let dirs = normalizeDirs(project.dirs);
    if (standalone && dirs.length === 0) {
      const scratch = standaloneScratchDir(os.homedir());
      ensureScratchDir(scratch);
      dirs = [scratch];
    }

    const projects = getProjects();
    const id = project.id || uuidv4();
    const existing = projects.find(p => p.id === id);
    const oldDirs = existing ? existing.dirs : [];
    const sameDir = (a: string, b: string) => path.resolve(a) === path.resolve(b);

    const added = dirs.filter(d => !oldDirs.some(o => sameDir(o, d)));
    for (const dir of added) {
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        return {ok: false, error: `Directory does not exist: ${dir}`};
      }
      const check = canAddDir(projects, id, dir);
      if (!check.ok) return {ok: false, error: `${dir}: ${check.reason}`};
    }

    const removed = oldDirs.filter(o => !dirs.some(d => sameDir(o, d)));
    const sessions = getPersistedSessions();
    const projectSessions = sessions.filter(s => s.projectId === id);
    for (const dir of removed) {
      const busy = projectSessions.some(
        s => hasLivePty(s.id) && s.config.projectDir && sameDir(s.config.projectDir, dir),
      );
      if (busy) return {ok: false, error: `Stop sessions running in ${dir} first`};
    }

    // Only local Claude sessions can pick a new directory; worktree/Codex sessions keep theirs
    // (git cleanup and apply-to-project run there).
    for (const s of projectSessions) {
      if (isLocalClaude(s) && s.config.projectDir && removed.some(r => sameDir(r, s.config.projectDir))) {
        s.config.projectDir = "";
      }
    }

    const saved: Project = {id, name, dirs};
    const next = existing ? projects.map(p => (p.id === id ? saved : p)) : [...projects, saved];
    saveProjects(next);
    savePersistedSessions(sessions);
    notifyProjectsUpdated(next);
    return {ok: true};
  } catch (error) {
    console.error("Error saving project:", error);
    return {ok: false, error: error instanceof Error ? error.message : String(error)};
  }
});

ipcMain.handle("scan-parent-dir", async (_event, parent: string, prefix: string): Promise<string[]> => {
  try {
    const dirents = await fs.promises.readdir(parent, {withFileTypes: true});
    const entries = await Promise.all(
      dirents
        .filter(d => d.isDirectory() || d.isSymbolicLink())
        .map(async d => ({
          name: d.name,
          isGitRepo: await fs.promises.access(path.join(parent, d.name, ".git")).then(() => true, () => false),
        })),
    );
    return filterRepoCandidates(entries, prefix).map(name => path.join(parent, name));
  } catch (error) {
    console.error(`Error scanning parent directory ${parent}:`, error);
    return [];
  }
});

interface DirInfo {
  dir: string;
  name: string;
  branch: string;
  occupancy: Occupancy;
}

ipcMain.handle("get-dir-info", async (_event, projectId: string): Promise<DirInfo[]> => {
  try {
    const project = getProjects().find(p => p.id === projectId);
    if (!project) return [];
    const running = runningSessionDirs(getPersistedSessions());
    let external: ReturnType<typeof scanClaudeProcesses> = [];
    try {
      external = scanClaudeProcesses();
    } catch (error) {
      console.error("Error scanning claude processes:", error);
    }
    const occupancy = computeDirOccupancy(project.dirs, running, external);
    return await Promise.all(
      project.dirs.map(async dir => ({
        dir,
        name: path.basename(dir),
        branch: fs.existsSync(dir) ? await getCurrentBranch(dir) : "",
        occupancy: occupancy[dir],
      })),
    );
  } catch (error) {
    console.error(`Error getting dir info for project ${projectId}:`, error);
    return [];
  }
});

// Window controls of the frameless window (buttons at the right of the tab row)
ipcMain.on("window-control", (_event, action: "minimize" | "toggle-maximize" | "close") => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (action === "minimize") mainWindow.minimize();
  else if (action === "toggle-maximize") {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === "close") mainWindow.close();
});

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    // The default File/Edit/View menu bar takes the system (GTK) font and offers nothing
    // Agentyard-specific: keep it hidden, Alt reveals it (its shortcuts keep working)
    autoHideMenuBar: true,
    // Own minimal window controls at the right of the tab row: the system frame takes its button
    // layout from GSettings under Electron's XDG_CURRENT_DESKTOP=Unity override, which on Ubuntu
    // puts them on the left. Moving the window stays with the compositor (-webkit-app-region: drag).
    frame: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  const sendMaximized = () => mainWindow.webContents.send("window-maximized-changed", mainWindow.isMaximized());
  mainWindow.on("maximize", sendMaximized);
  mainWindow.on("unmaximize", sendMaximized);

  hardenNavigation(mainWindow.webContents);
  mainWindow.loadFile("index.html");

  // Load persisted sessions once window is ready
  mainWindow.webContents.on("did-finish-load", () => {
    const sessions = getPersistedSessions();
    notifyProjectsUpdated(getProjects());
    mainWindow.webContents.send("load-persisted-sessions", sessions);
    // A reload starts a fresh renderer: resend runtime state and warnings.
    lastExternallyOpen = new Set();
    lastSyncWarnings = [];
    if (migrationWarnings.length > 0) mainWindow.webContents.send("sync-warnings", migrationWarnings);
    sendMaximized();
    startTranscriptSync();
  });

  // Clean up PTY processes when window is closed
  mainWindow.on("closed", () => {
    stopTranscriptSync();

    // Kill all active PTY processes
    activePtyProcesses.forEach((ptyProcess, sessionId) => {
      try {
        ptyProcess.kill();
      } catch (error) {
        console.error(`Error killing PTY for session ${sessionId}:`, error);
      }
    });
    activePtyProcesses.clear();
    for (const sessionId of [...sideShellPtys.keys()]) stopSideShell(sessionId);

    // Kill all MCP poller processes
    mcpPollerPtyProcesses.forEach((ptyProcess, sessionId) => {
      try {
        ptyProcess.kill();
      } catch (error) {
        console.error(`Error killing MCP poller for session ${sessionId}:`, error);
      }
    });
    mcpPollerPtyProcesses.clear();
  });
};

app.on("before-quit", () => {
  try {
    const sessions = getPersistedSessions();
    let changed = false;
    for (const session of sessions) {
      const next = statusOnAppQuit(session.status);
      if (next !== session.status) {
        session.status = next;
        changed = true;
      }
    }
    if (changed) savePersistedSessions(sessions);
  } catch (error) {
    console.error("Error updating session status on quit:", error);
  }
  statusWatcher?.close();
  if (statusPollTimer) clearInterval(statusPollTimer);
});

app.whenReady().then(() => {
  // No PTY survives a restart: settle stale RUNNING/WAITING (covers crashes)
  settleAllSessionStatuses();
  bootstrapStandaloneProject();
  migrateProjects();
  createWindow();
  startStatusWatcher();
  setUpAgyStatusPlugin();

  // Spawn claude command runner PTY early so it's ready when needed (fire-and-forget)
  spawnClaudeCommandRunner();

  // Handles launch from dock on macos
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
