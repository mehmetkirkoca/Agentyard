import {FitAddon} from "@xterm/addon-fit";
import {clipboard, ipcRenderer, webUtils} from "electron";
import {Terminal} from "xterm";
import {buildPathPaste} from "./attach-utils";
import {PersistedSession, Project, SessionConfig, SessionRuntime, SessionStatus, SessionType} from "./types";
import {isStandaloneProject, STANDALONE_PROJECT_ID, STANDALONE_PROJECT_NAME} from "./project-model";
import {buildSidebar, buildStandaloneGroup, SidebarGroup, filterSidebarGroup, moveProjectInOrder} from "./sidebar-model";
import {isClaudeSessionReady} from "./terminal-utils";
import {currentPromptIndex, hasJumpToBottom, seekStep} from "./sticky-prompt";
import {
  applyTemplate,
  assignSession,
  canSplit,
  closePane,
  createPaneState,
  crossHandle,
  dropZone,
  ensureInTabOrder,
  focusedSession,
  focusPane,
  is2x2,
  LAYOUTS,
  LayoutKind,
  leaves,
  MAX_PANES,
  movePane,
  moveTab,
  paneRects,
  paneOfSession,
  paneSession,
  PaneState,
  parsePaneState,
  pruneSessions,
  removeSession,
  setLinkedSplits,
  setRatio,
  showSession,
  Side,
  splitPane,
  splitterSpecs,
  swapPanes,
  tabInsertBefore,
  templateOf,
  visibleSessions,
} from "./pane-layout";
import * as path from "path";

interface Session {
  id: string;
  terminal: Terminal | null;
  fitAddon: FitAddon | null;
  element: HTMLDivElement | null;
  name: string;
  config: SessionConfig;
  worktreePath?: string;
  hasActivePty: boolean;
  status?: SessionStatus;
  meta: PersistedSession;
}

interface McpServer {
  name: string;
  connected?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  type?: "stdio" | "sse";
}

interface TerminalSettings {
  fontFamily: string;
  fontSize: number;
  theme: string; // Theme preset name
  cursorBlink: boolean;
  worktreeDir: string;
}

interface ThemeColors {
  background: string;
  foreground: string;
  cursor?: string;
  cursorAccent?: string;
  selection?: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  magenta?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightMagenta?: string;
  brightCyan?: string;
  brightWhite?: string;
}

// Theme presets
const THEME_PRESETS: Record<string, ThemeColors> = {
  "vscode-dark": {
    background: "#1e1e1e",
    foreground: "#cccccc",
    cursor: "#aeafad",
    selection: "#264f78",
    black: "#000000",
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#e5e5e5",
  },
  "macos-light": {
    background: "#ffffff",
    foreground: "#000000",
    cursor: "#000000",
    selection: "#b4d5fe",
    black: "#000000",
    red: "#c23621",
    green: "#25bc24",
    yellow: "#adad27",
    blue: "#492ee1",
    magenta: "#d338d3",
    cyan: "#33bbc8",
    white: "#cbcccd",
    brightBlack: "#818383",
    brightRed: "#fc391f",
    brightGreen: "#31e722",
    brightYellow: "#eaec23",
    brightBlue: "#5833ff",
    brightMagenta: "#f935f8",
    brightCyan: "#14f0f0",
    brightWhite: "#e9ebeb",
  },
  "macos-dark": {
    background: "#000000",
    foreground: "#ffffff",
    cursor: "#ffffff",
    selection: "#4d4d4d",
    black: "#000000",
    red: "#c23621",
    green: "#25bc24",
    yellow: "#adad27",
    blue: "#492ee1",
    magenta: "#d338d3",
    cyan: "#33bbc8",
    white: "#cbcccd",
    brightBlack: "#818383",
    brightRed: "#fc391f",
    brightGreen: "#31e722",
    brightYellow: "#eaec23",
    brightBlue: "#5833ff",
    brightMagenta: "#f935f8",
    brightCyan: "#14f0f0",
    brightWhite: "#e9ebeb",
  },
  "solarized-dark": {
    background: "#002b36",
    foreground: "#839496",
    cursor: "#839496",
    selection: "#073642",
    black: "#073642",
    red: "#dc322f",
    green: "#859900",
    yellow: "#b58900",
    blue: "#268bd2",
    magenta: "#d33682",
    cyan: "#2aa198",
    white: "#eee8d5",
    brightBlack: "#002b36",
    brightRed: "#cb4b16",
    brightGreen: "#586e75",
    brightYellow: "#657b83",
    brightBlue: "#839496",
    brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1",
    brightWhite: "#fdf6e3",
  },
  "dracula": {
    background: "#282a36",
    foreground: "#f8f8f2",
    cursor: "#f8f8f2",
    selection: "#44475a",
    black: "#21222c",
    red: "#ff5555",
    green: "#50fa7b",
    yellow: "#f1fa8c",
    blue: "#bd93f9",
    magenta: "#ff79c6",
    cyan: "#8be9fd",
    white: "#f8f8f2",
    brightBlack: "#6272a4",
    brightRed: "#ff6e6e",
    brightGreen: "#69ff94",
    brightYellow: "#ffffa5",
    brightBlue: "#d6acff",
    brightMagenta: "#ff92df",
    brightCyan: "#a4ffff",
    brightWhite: "#ffffff",
  },
  "one-dark": {
    background: "#282c34",
    foreground: "#abb2bf",
    cursor: "#528bff",
    selection: "#3e4451",
    black: "#282c34",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#e5c07b",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#e06c75",
    brightGreen: "#98c379",
    brightYellow: "#e5c07b",
    brightBlue: "#61afef",
    brightMagenta: "#c678dd",
    brightCyan: "#56b6c2",
    brightWhite: "#ffffff",
  },
  "github-dark": {
    background: "#0d1117",
    foreground: "#c9d1d9",
    cursor: "#58a6ff",
    selection: "#163c61",
    black: "#484f58",
    red: "#ff7b72",
    green: "#3fb950",
    yellow: "#d29922",
    blue: "#58a6ff",
    magenta: "#bc8cff",
    cyan: "#39c5cf",
    white: "#b1bac4",
    brightBlack: "#6e7681",
    brightRed: "#ffa198",
    brightGreen: "#56d364",
    brightYellow: "#e3b341",
    brightBlue: "#79c0ff",
    brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd",
    brightWhite: "#f0f6fc",
  },
};

// Detect system theme
function getSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

// Default settings - macOS Terminal matching system theme
const DEFAULT_SETTINGS: TerminalSettings = {
  fontFamily: "Menlo, Monaco, 'Courier New', monospace",
  fontSize: 11,
  theme: "vscode-dark",
  cursorBlink: false,
  worktreeDir: require("path").join(require("os").homedir(), "worktrees"),
};

const sessions = new Map<string, Session>();
let activeSessionId: string | null = null;
let projects: Project[] = [];
let runtime: Record<string, SessionRuntime> = {};
let syncWarnings: string[] = [];
// Accordion flags that survive restarts: every change is written to localStorage (per viewer)
class PersistedFlags extends Map<string, boolean> {
  constructor(private readonly storageKey: string) {
    super();
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
      if (saved && typeof saved === "object") {
        for (const [k, v] of Object.entries(saved)) if (typeof v === "boolean") super.set(k, v);
      }
    } catch (error) {
      console.error(`Error restoring ${storageKey}:`, error);
    }
  }

  set(key: string, value: boolean): this {
    super.set(key, value);
    // storageKey is unset while the base constructor runs; nothing to save then
    if (!this.storageKey) return this;
    try {
      localStorage.setItem(this.storageKey, JSON.stringify(Object.fromEntries(this)));
    } catch (error) {
      console.error(`Error saving ${this.storageKey}:`, error);
    }
    return this;
  }
}

const collapsedProjects = new PersistedFlags("collapsedGroups"); // true = collapsed (default expanded)
const olderExpanded = new PersistedFlags("olderExpanded"); // true = expanded (default collapsed)
const OTHER_PROJECT_ID = "__other__";

// Project order in the PROJECTS section (drag & drop), remembered per viewer; OTHERS is a
// separate section and always stays below.
const PROJECT_ORDER_KEY = "projectOrder";
const PROJECT_DRAG_MIME = "application/x-agentyard-project";

function loadProjectOrder(): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(PROJECT_ORDER_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch (error) {
    console.error("Error restoring project order:", error);
    return [];
  }
}

function saveProjectOrder(order: string[]) {
  try {
    localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(order));
  } catch (error) {
    console.error("Error saving project order:", error);
  }
}

function clearProjectDropMarkers() {
  document.querySelectorAll(".project-header.drop-before, .project-header.drop-after")
    .forEach(el => el.classList.remove("drop-before", "drop-after"));
}

// Make a project header draggable and a drop target for reordering projects
function wireProjectReorder(header: HTMLElement, pid: string, orderedIds: string[]) {
  header.draggable = true;
  header.addEventListener("dragstart", (e) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(PROJECT_DRAG_MIME, pid);
    e.dataTransfer.effectAllowed = "move";
  });
  header.addEventListener("dragend", clearProjectDropMarkers);
  header.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes(PROJECT_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = header.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    clearProjectDropMarkers();
    header.classList.add(after ? "drop-after" : "drop-before");
  });
  header.addEventListener("dragleave", (e) => {
    if (!header.contains(e.relatedTarget as Node | null)) header.classList.remove("drop-before", "drop-after");
  });
  header.addEventListener("drop", (e) => {
    const moved = e.dataTransfer?.getData(PROJECT_DRAG_MIME);
    const after = header.classList.contains("drop-after");
    clearProjectDropMarkers();
    if (!moved) return;
    e.preventDefault();
    e.stopPropagation();
    saveProjectOrder(moveProjectInOrder(orderedIds, moved, pid, after));
    renderSidebar();
  });
}
let mcpServers: McpServer[] = [];
let mcpPollerActive = false;
let terminalSettings: TerminalSettings = { ...DEFAULT_SETTINGS };

const PANE_STATE_KEY = "paneLayout";
const SESSION_DRAG_MIME = "application/x-agentyard-session";
const PANE_DRAG_MIME = "application/x-agentyard-pane";
let paneState: PaneState = loadPaneState();

// Track activity timers for each session
const activityTimers = new Map<string, NodeJS.Timeout>();

async function loadAndPopulateBranches(
  directory: string,
  selectedBranch?: string
): Promise<void> {
  const branches = await ipcRenderer.invoke("get-branches", directory);
  existingBranches = branches;
  parentBranchSelect.innerHTML = "";

  if (branches.length === 0) {
    parentBranchSelect.innerHTML = '<option value="">No git repository found</option>';
  } else {
    branches.forEach((branch: string) => {
      const option = document.createElement("option");
      option.value = branch;
      option.textContent = branch;
      if (branch === selectedBranch) {
        option.selected = true;
      }
      parentBranchSelect.appendChild(option);
    });
  }
}

// Pane prompt line: the prompt whose answer is at the top of the terminal, tracked from the screen
interface StickyPromptController {
  term: Terminal;
  prompts(): string[];
  currentIndex(): number | null;
  refreshPrompts(): void;
  /** Scroll until the prompt at `target` sits on the top rows */
  scrollToPrompt(target: number): Promise<void>;
}
const stickyPrompts = new Map<string, StickyPromptController>();
const STICKY_RESCAN_DELAY_MS = 100;
const SEEK_MAX_STEPS = 400;
const SEEK_STEP_TIMEOUT_MS = 150;

function createStickyPrompt(sessionId: string, term: Terminal): StickyPromptController {
  let prompts: string[] = [];
  let index: number | null = null;
  let rescanTimer: NodeJS.Timeout | null = null;

  let seekToken = 0;

  // Only the visible rows: fullscreen Claude Code scrolls its own view, so the screen is all there is
  const visibleLines = () => {
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let i = buffer.viewportY; i < buffer.viewportY + term.rows; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
    }
    return lines;
  };

  const isScrolledUp = (lines: string[]) => {
    const buffer = term.buffer.active;
    return buffer.viewportY < buffer.baseY || hasJumpToBottom(lines);
  };

  const rescan = () => {
    rescanTimer = null;
    const lines = visibleLines();
    const next = currentPromptIndex(lines, prompts, isScrolledUp(lines), index);
    if (next === index) return;
    index = next;
    renderPanePromptOf(sessionId);
  };
  const scheduleRescan = () => {
    if (!rescanTimer) rescanTimer = setTimeout(rescan, STICKY_RESCAN_DELAY_MS);
  };

  term.onWriteParsed(scheduleRescan);
  term.onScroll(scheduleRescan);
  term.onRender(scheduleRescan); // user scrolling repaints even where onScroll stays silent

  // One wheel notch: fullscreen Claude Code tracks the mouse and scrolls its own view, so the
  // notch goes to the PTY as an SGR wheel report, as xterm sends it; otherwise xterm scrolls itself
  const scrollOneStep = (direction: "up" | "down"): Promise<void> => {
    if (term.modes.mouseTrackingMode === "none") {
      term.scrollLines(direction === "up" ? -1 : 1);
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        parsed.dispose();
        resolve();
      };
      const timer = setTimeout(done, SEEK_STEP_TIMEOUT_MS);
      const parsed = term.onWriteParsed(done);
      const button = direction === "up" ? 64 : 65;
      ipcRenderer.send("session-input", sessionId, `\x1b[<${button};1;${Math.ceil(term.rows / 2)}M`);
    });
  };

  const controller: StickyPromptController = {
    term,
    prompts: () => prompts,
    currentIndex: () => index,
    refreshPrompts() {
      ipcRenderer.invoke("get-session-prompts", sessionId)
        .then((next: string[]) => {
          prompts = next; // only ever grows, so the current index stays valid
          renderPanePromptOf(sessionId); // the list button follows the prompt count
          scheduleRescan();
        })
        .catch(error => console.error(`Failed to load prompts of session ${sessionId}:`, error));
    },
    async scrollToPrompt(target: number) {
      const token = ++seekToken; // a newer request cancels this one
      // In fullscreen the top row is Claude Code's sticky header, which echoes a prompt of its own
      const skipRows = term.buffer.active.type === "alternate" ? 1 : 0;
      let current = index;
      let last: "up" | "down" | null = null;
      for (let step = 0; step < SEEK_MAX_STEPS && token === seekToken; step++) {
        const lines = visibleLines();
        const scrolledUp = isScrolledUp(lines);
        current = currentPromptIndex(lines, prompts, scrolledUp, current);
        const next = seekStep(lines, prompts, target, skipRows, scrolledUp, current);
        // A turn means the target was passed without being recognised: stop next to it
        if (next === "done" || (last !== null && next !== last)) break;
        last = next;
        await scrollOneStep(next);
      }
      scheduleRescan();
    },
  };
  controller.refreshPrompts();
  return controller;
}

// Fill a pane's prompt line from the session it shows; the line stays even when empty, so the
// terminal height never changes
function renderPanePrompt(pane: HTMLElement, sessionId: string | undefined): void {
  const line = pane.querySelector(".pane-prompt") as HTMLElement | null;
  if (!line) return;
  const sticky = sessionId ? stickyPrompts.get(sessionId) : undefined;
  const current = sticky?.currentIndex() ?? null;
  const prompt = sticky && current !== null ? sticky.prompts()[current] ?? null : null;
  (line.querySelector(".pane-prompt-text") as HTMLElement).textContent = prompt ? prompt.replace(/\s+/g, " ").trim() : "";
  line.classList.toggle("empty", !prompt);
  (line.querySelector(".pane-prompt-text") as HTMLElement).title = prompt ?? "";
  (line.querySelector(".pane-prompt-list") as HTMLButtonElement).disabled = !sticky || sticky.prompts().length === 0;
}

// Prompt list under a pane's prompt line, in conversation order; picking one scrolls to it
let promptPickerCloser: (() => void) | null = null;
let promptPickerLeafId: number | null = null;

function openPromptPicker(leafId: number, anchor: HTMLElement): void {
  promptPickerCloser?.();
  const sessionId = paneSession(paneState, leafId);
  const sticky = sessionId ? stickyPrompts.get(sessionId) : undefined;
  if (!sticky) return;
  const prompts = sticky.prompts();
  if (prompts.length === 0) return;
  const current = sticky.currentIndex();

  const popover = document.createElement("div");
  popover.className = "prompt-picker";
  popover.innerHTML = prompts.map((prompt, idx) => {
    const oneLine = escapeHtml(prompt.replace(/\s+/g, " ").trim());
    // The first prompt has nothing before it to fork from
    const fork = idx > 0
      ? `<span class="prompt-picker-fork" data-idx="${idx}" title="Fork the conversation right before this prompt">Fork</span>`
      : "";
    return `<button class="prompt-picker-row${idx === current ? " current" : ""}" data-idx="${idx}" title="${escapeHtml(prompt)}">
      <span class="prompt-picker-number">${idx + 1}</span><span class="prompt-picker-text">${oneLine}</span>${fork}</button>`;
  }).join("");

  const position = () => {
    const rect = anchor.getBoundingClientRect();
    popover.style.top = `${rect.bottom + 2}px`;
    popover.style.right = `${Math.max(4, window.innerWidth - rect.right)}px`;
  };
  position();
  document.body.appendChild(popover);
  popover.querySelector(".prompt-picker-row.current")?.scrollIntoView({block: "nearest"});
  window.addEventListener("resize", position);

  const onDocClick = (e: MouseEvent) => {
    if (!popover.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  function close() {
    popover.remove();
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", position);
    if (promptPickerCloser === close) {
      promptPickerCloser = null;
      promptPickerLeafId = null;
    }
  }
  promptPickerCloser = close;
  promptPickerLeafId = leafId;
  document.addEventListener("click", onDocClick, true);
  document.addEventListener("keydown", onKey);

  popover.querySelectorAll<HTMLButtonElement>(".prompt-picker-row").forEach(row => {
    row.addEventListener("click", (e) => {
      close();
      const idx = Number(row.dataset.idx);
      if ((e.target as HTMLElement).closest(".prompt-picker-fork")) {
        ipcRenderer.send("fork-session-at", sessionId, idx, prompts[idx]);
      } else {
        scrollPaneToPrompt(sticky, idx);
      }
    });
  });
}

function scrollPaneToPrompt(sticky: StickyPromptController, target: number): void {
  sticky.scrollToPrompt(target)
    .catch(error => console.error(`Failed to scroll to prompt ${target + 1}:`, error))
    .finally(() => sticky.term.focus());
}

function renderPanePromptOf(sessionId: string): void {
  const leafId = paneOfSession(paneState, sessionId);
  const pane = leafId === null ? undefined : paneElements.get(leafId);
  if (pane) renderPanePrompt(pane, sessionId);
}

function createTerminalUI(sessionId: string) {
  const themeColors = THEME_PRESETS[terminalSettings.theme] || THEME_PRESETS["macos-dark"];

  const term = new Terminal({
    cursorBlink: terminalSettings.cursorBlink,
    fontSize: terminalSettings.fontSize,
    fontFamily: terminalSettings.fontFamily,
    theme: themeColors,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  const sessionElement = document.createElement("div");
  sessionElement.className = "session-wrapper";
  sessionElement.id = `session-${sessionId}`;

  const container = document.getElementById("session-container");
  if (container) {
    container.appendChild(sessionElement);
  }

  // term.open() waits until renderPanes shows the element: opened inside the hidden
  // container, xterm measures a 0px cell, so the first fit is skipped and the PTY
  // keeps its 80x30 spawn size while the terminal shows 80x24.

  stickyPrompts.set(sessionId, createStickyPrompt(sessionId, term));

  term.onData((data) => {
    ipcRenderer.send("session-input", sessionId, data);
  });

  // Listen for bell character to mark unread activity
  term.onBell(() => {
    if (!isShownInPane(sessionId)) {
      markSessionAsUnread(sessionId);
    }
  });

  return { terminal: term, fitAddon, element: sessionElement };
}

function addSession(persistedSession: PersistedSession, hasActivePty: boolean, render = true) {
  const session: Session = {
    id: persistedSession.id,
    terminal: null,
    fitAddon: null,
    element: null,
    name: persistedSession.name,
    config: persistedSession.config,
    worktreePath: persistedSession.worktreePath,
    hasActivePty,
    status: persistedSession.status,
    meta: persistedSession,
  };

  sessions.set(persistedSession.id, session);

  if (render) renderSidebar();

  // Only add tab if terminal is active
  if (hasActivePty) {
    addTab(persistedSession.id, persistedSession.name);
    applyTabStatus(persistedSession.id);
  }

  return session;
}

function activateSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // If terminal UI doesn't exist yet, create it
  if (!session.terminal) {
    const ui = createTerminalUI(sessionId);
    session.terminal = ui.terminal;
    session.fitAddon = ui.fitAddon;
    session.element = ui.element;
  }

  session.hasActivePty = true;
  updateSessionState(sessionId, true);

  // Add tab if it doesn't exist
  if (!document.getElementById(`tab-${sessionId}`)) {
    addTab(sessionId, session.name);
  }

  // Switch to this session
  switchToSession(sessionId);
}

const STATUS_CLASSES = ["status-running", "status-waiting", "status-done", "status-idle", "status-closed", "status-external"];

function indicatorStatusClass(session: Session): string {
  if (runtime[session.id]?.externallyOpen) return "status-external";
  // An unseen DONE stays visible after restart even without a PTY
  if (session.status === SessionStatus.DONE) return "status-done";
  if (!session.hasActivePty) return "status-closed";
  return `status-${session.status ?? SessionStatus.IDLE}`;
}

function refreshSessionIndicator(sessionId: string) {
  const session = sessions.get(sessionId);
  const indicator = document.getElementById(`sidebar-${sessionId}`)?.querySelector(".session-indicator");
  if (!session || !indicator) return;
  indicator.classList.remove(...STATUS_CLASSES);
  indicator.classList.add(indicatorStatusClass(session));
}

// For Claude sessions the tab activity/unread classes are derived from the hook-based status
function applyTabStatus(sessionId: string) {
  const session = sessions.get(sessionId);
  const tab = document.getElementById(`tab-${sessionId}`);
  if (!session || !tab || session.config.codingAgent !== "claude") return;
  tab.classList.toggle("activity", session.status === SessionStatus.RUNNING);
  tab.classList.toggle("unread", session.status === SessionStatus.WAITING || session.status === SessionStatus.DONE);
}

function updateSessionState(sessionId: string, _isActive: boolean) {
  refreshSessionIndicator(sessionId);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Non-blocking notification card in the top-right corner; closes by itself or on click
type ToastKind = "info" | "success" | "warning" | "error";
const TOAST_DURATION_MS: Record<ToastKind, number> = {info: 4000, success: 4000, warning: 5000, error: 8000};

function showToast(message: string, kind: ToastKind = "info"): void {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.setAttribute("role", kind === "error" ? "alert" : "status");
  toast.textContent = message;

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    toast.classList.add("toast-leaving");
    setTimeout(() => toast.remove(), 200);
  };
  let timer = setTimeout(close, TOAST_DURATION_MS[kind]);
  // Keep it open while hovered so long messages can be read
  toast.addEventListener("mouseenter", () => clearTimeout(timer));
  toast.addEventListener("mouseleave", () => {
    timer = setTimeout(close, 1500);
  });
  toast.addEventListener("click", close);

  container.appendChild(toast);
}

function addToSidebar(list: HTMLElement, sessionId: string, name: string, config: SessionConfig) {
  const isWorktree = config.sessionType === SessionType.WORKTREE;
  const applyMenuItem = isWorktree ? `<button class="session-menu-item apply-to-project-btn" data-id="${sessionId}">Apply to project</button>` : '';
  const skipMenuItem = config.codingAgent === "claude"
    ? `<button class="session-menu-item skip-permissions-btn" data-id="${sessionId}">Skip permissions: ${config.skipPermissions ? "on" : "off"}</button>`
    : '';
  const sess = sessions.get(sessionId);
  const moveMenuItem = sess && isLocalClaude(config) && !runtime[sessionId]?.externallyOpen
    && hasOtherDirectory(sess.meta.projectId, config.projectDir)
    ? `<button class="session-menu-item move-dir-btn" data-id="${sessionId}">Move to directory…</button>`
    : '';
  const forkMenuItem = isLocalClaude(config)
    ? `<button class="session-menu-item fork-session-btn" data-id="${sessionId}">Fork</button>`
    : '';
  const safeName = escapeHtml(name);

  const item = document.createElement("div");
  item.id = `sidebar-${sessionId}`;
  item.className = "session-list-item";
  if (runtime[sessionId]?.externallyOpen) item.title = "open elsewhere";
  item.innerHTML = `
    <div class="flex items-center space-x-2 flex-1 session-name-container">
      <span class="session-indicator status-closed"></span>
      <span class="truncate session-name-text" data-id="${sessionId}">${safeName}</span>
      <input type="text" class="session-name-input hidden" data-id="${sessionId}" value="${safeName}" />
    </div>
    <button class="session-rename-btn" data-id="${sessionId}" title="Rename" aria-label="Rename session"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg></button>
    <div class="relative">
      <button class="session-menu-btn" data-id="${sessionId}" title="Session options">⋯</button>
      <div class="session-menu hidden" data-id="${sessionId}">
        <button class="session-menu-item rename-session-btn" data-id="${sessionId}">Rename</button>
        ${forkMenuItem}
        ${moveMenuItem}
        ${skipMenuItem}
        ${applyMenuItem}
        <button class="session-menu-item delete-session-btn" data-id="${sessionId}">Delete</button>
      </div>
    </div>
  `;

  // Handle input blur and enter key
  const nameInput = item.querySelector(".session-name-input") as HTMLInputElement;
  nameInput?.addEventListener("blur", () => {
    finishEditingSessionName(sessionId);
  });

  nameInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      finishEditingSessionName(sessionId);
    } else if (e.key === "Escape") {
      cancelEditingSessionName(sessionId);
    }
  });

  // Click on item to activate session
  item.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("session-menu-btn") &&
        !target.closest(".session-rename-btn") &&
        !target.classList.contains("session-menu-item") &&
        !target.classList.contains("session-name-input") &&
        !target.closest(".session-menu")) {
      handleSessionClick(sessionId);
    }
  });

  // Menu button toggle
  const menuBtn = item.querySelector(".session-menu-btn");
  const menu = item.querySelector(".session-menu") as HTMLElement;

  menuBtn?.addEventListener("click", (e) => {
    e.stopPropagation();

    // Close all other menus
    document.querySelectorAll(".session-menu").forEach(m => {
      if (m !== menu) m.classList.add("hidden");
    });

    // Toggle this menu
    menu?.classList.toggle("hidden");
  });

  // Rename button
  // Pencil icon at the right end of the row: inline rename
  item.querySelector(".session-rename-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    startEditingSessionName(sessionId);
  });

  const renameBtn = item.querySelector(".rename-session-btn");
  renameBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    menu?.classList.add("hidden");
    startEditingSessionName(sessionId);
  });

  // Fork: new session that starts as a copy of this conversation
  const forkBtn = item.querySelector(".fork-session-btn");
  forkBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    menu?.classList.add("hidden");
    ipcRenderer.send("fork-session", sessionId);
  });

  // Move to directory (local Claude sessions; a running one restarts in the new directory)
  const moveBtn = item.querySelector(".move-dir-btn");
  moveBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    menu?.classList.add("hidden");
    showDirPickerFor(sessionId);
  });

  // Delete button
  const deleteBtn = item.querySelector(".delete-session-btn");
  deleteBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    menu?.classList.add("hidden");
    deleteSession(sessionId);
  });

  // Apply to project button (only for worktree sessions)
  const applyBtn = item.querySelector(".apply-to-project-btn");
  applyBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    menu?.classList.add("hidden");
    showApplyToProjectDialog(sessionId);
  });

  // Skip permissions toggle (Claude sessions only)
  const skipBtn = item.querySelector(".skip-permissions-btn");
  skipBtn?.addEventListener("click", async (e) => {
    e.stopPropagation();
    menu?.classList.add("hidden");
    const session = sessions.get(sessionId);
    if (!session) return;
    try {
      await ipcRenderer.invoke("set-skip-permissions", sessionId, !session.config.skipPermissions);
      session.config = { ...session.config, skipPermissions: !session.config.skipPermissions };
      renderSidebar();
    } catch (err) {
      console.error(`set-skip-permissions failed for session ${sessionId}:`, err);
    }
  });

  list.appendChild(item);
  refreshSessionIndicator(sessionId);
  if (sessionId === activeSessionId) item.classList.add("active");
}

function renderGroupSessions(container: HTMLElement, list: PersistedSession[]) {
  for (const ps of list) {
    const s = sessions.get(ps.id);
    if (s) addToSidebar(container, s.id, s.name, s.config);
  }
}

// Per-group sidebar search: an open search box per group id (value = query), and the
// box that had focus, so it can be focused again after the sidebar is rebuilt.
const groupSearch = new Map<string, string>();
let searchFocus: {pid: string; start: number; end: number} | null = null;
const SEARCH_ICON = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

function toggleGroupSearch(pid: string) {
  if (groupSearch.has(pid)) {
    groupSearch.delete(pid);
    searchFocus = null;
  } else {
    groupSearch.set(pid, "");
    collapsedProjects.set(pid, false);
    searchFocus = {pid, start: 0, end: 0};
  }
  renderSidebar();
}

function createGroupSearchBox(pid: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "group-search";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "group-search-input";
  input.placeholder = "Filter sessions…";
  input.value = groupSearch.get(pid) ?? "";
  input.dataset.searchPid = pid;
  input.addEventListener("click", e => e.stopPropagation());
  input.addEventListener("input", () => {
    groupSearch.set(pid, input.value);
    searchFocus = {pid, start: input.selectionStart ?? input.value.length, end: input.selectionEnd ?? input.value.length};
    renderSidebar();
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      e.preventDefault();
      toggleGroupSearch(pid);
    }
  });
  // A rebuild removes the box (which blurs it); keep the focus target in that case
  input.addEventListener("blur", () => {
    if (!sidebarRendering && searchFocus?.pid === pid) searchFocus = null;
  });
  row.appendChild(input);
  return row;
}

function restoreSearchFocus() {
  if (!searchFocus) return;
  const input = document.querySelector<HTMLInputElement>(`.group-search-input[data-search-pid="${CSS.escape(searchFocus.pid)}"]`);
  if (!input) return;
  input.focus();
  input.setSelectionRange(searchFocus.start, searchFocus.end);
}

// Recent sessions plus the collapsible "Older (n)" block of one sidebar group.
function renderGroupBody(group: SidebarGroup): HTMLElement {
  const pid = group.project.id;
  const query = groupSearch.get(pid) ?? "";
  const g = filterSidebarGroup(group, query);
  const body = document.createElement("div");
  body.className = "project-body";
  if (query.trim() && g.recent.length === 0) {
    const empty = document.createElement("div");
    empty.className = "group-search-empty";
    empty.textContent = "No matching sessions";
    body.appendChild(empty);
  }
  renderGroupSessions(body, g.recent);
  if (g.older.length > 0) {
    const open = olderExpanded.get(pid) === true;
    const olderHeader = document.createElement("div");
    olderHeader.className = "older-header";
    const olderChevron = document.createElement("span");
    olderChevron.className = "section-chevron";
    olderChevron.textContent = open ? "▾" : "▸";
    olderHeader.append(olderChevron, `Older (${g.older.length})`);
    olderHeader.addEventListener("click", () => {
      olderExpanded.set(pid, !open);
      renderSidebar();
    });
    body.appendChild(olderHeader);
    if (open) renderGroupSessions(body, g.older);
  }
  return body;
}

// SESSIONS section: standalone sessions without a project header of their own.
function renderStandaloneSection(g: SidebarGroup | undefined) {
  const list = document.getElementById("standalone-session-list");
  const waiting = document.getElementById("standalone-waiting");
  if (!list) return;
  list.innerHTML = "";
  if (waiting) {
    const count = g?.waitingCount ?? 0;
    waiting.textContent = count > 0 ? `· ${count} waiting` : "";
    waiting.classList.toggle("hidden", count === 0);
  }
  const collapsed = collapsedProjects.get(STANDALONE_PROJECT_ID) === true;
  const searchSlot = document.getElementById("standalone-search-slot");
  if (searchSlot) {
    searchSlot.innerHTML = "";
    if (groupSearch.has(STANDALONE_PROJECT_ID) && !collapsed) searchSlot.appendChild(createGroupSearchBox(STANDALONE_PROJECT_ID));
  }
  const chevron = document.getElementById("standalone-chevron");
  if (chevron) chevron.textContent = collapsed ? "▸" : "▾";
  list.classList.toggle("hidden", collapsed);
  if (g && !collapsed) list.appendChild(renderGroupBody(g));
}

document.getElementById("standalone-search-btn")?.addEventListener("click", e => {
  e.stopPropagation();
  toggleGroupSearch(STANDALONE_PROJECT_ID);
});

// MCP SERVERS header is an accordion too; its state is remembered per viewer
const MCP_COLLAPSED_KEY = "mcpCollapsed";

function setMcpCollapsed(collapsed: boolean) {
  document.getElementById("mcp-server-list")?.classList.toggle("hidden", collapsed);
  const chevron = document.getElementById("mcp-chevron");
  if (chevron) chevron.textContent = collapsed ? "▸" : "▾";
  try {
    localStorage.setItem(MCP_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch (error) {
    console.error("Error saving MCP section state:", error);
  }
}

(function initMcpToggle() {
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(MCP_COLLAPSED_KEY) === "1";
  } catch (error) {
    console.error("Error restoring MCP section state:", error);
  }
  setMcpCollapsed(collapsed);
  document.getElementById("mcp-toggle")?.addEventListener("click", () => {
    setMcpCollapsed(!document.getElementById("mcp-server-list")?.classList.contains("hidden"));
  });
})();

// OTHERS header works like a project accordion: click to collapse / expand
document.getElementById("standalone-toggle")?.addEventListener("click", () => {
  collapsedProjects.set(STANDALONE_PROJECT_ID, collapsedProjects.get(STANDALONE_PROJECT_ID) !== true);
  renderSidebar();
});

let sidebarRendering = false;
let sidebarRenderPending = false;

function renderSidebar() {
  const list = document.getElementById("session-list");
  if (!list) return;
  if (sidebarRendering) {
    sidebarRenderPending = true;
    return;
  }
  // Never destroy an inline rename or an open dropdown; re-render on the next event
  if (document.querySelector(".session-name-input:not(.hidden)") ||
      document.querySelector(".session-menu:not(.hidden)")) {
    sidebarRenderPending = true;
    return;
  }
  sidebarRenderPending = false;
  sidebarRendering = true;
  try {
    renderSidebarNow(list);
  } finally {
    sidebarRendering = false;
  }
  if (sidebarRenderPending) renderSidebar();
}

function renderSidebarNow(list: HTMLElement) {

  const metas: PersistedSession[] = Array.from(sessions.values()).map(s => ({
    ...s.meta,
    name: s.name,
    config: s.config,
    status: s.status,
  }));
  const known = new Set(projects.map(p => p.id));
  const orphans = metas.filter(m => !m.projectId || !known.has(m.projectId));
  const allProjects = [...projects];
  const allMetas = metas.filter(m => !orphans.includes(m));
  if (orphans.length > 0) {
    allProjects.push({ id: OTHER_PROJECT_ID, name: "Other", dirs: [] });
    allMetas.push(...orphans.map(o => ({ ...o, projectId: OTHER_PROJECT_ID })));
  }
  const now = Date.now();
  const groups = buildSidebar(allProjects, allMetas, now, 7, loadProjectOrder()).filter(
    g => g.project.id !== OTHER_PROJECT_ID || g.recent.length + g.older.length > 0,
  );
  const orderedIds = groups.map(g => g.project.id).filter(id => id !== OTHER_PROJECT_ID);

  list.innerHTML = "";
  for (const g of groups) {
    const pid = g.project.id;
    const collapsed = collapsedProjects.get(pid) === true;
    const group = document.createElement("div");
    group.className = "project-group";

    const header = document.createElement("div");
    header.className = "project-header";
    if (pid !== OTHER_PROJECT_ID) wireProjectReorder(header, pid, orderedIds);
    const waiting = g.waitingCount > 0 ? ` <span class="project-waiting">· ${g.waitingCount} waiting</span>` : "";
    header.innerHTML = `
      <span class="project-title truncate"><span class="section-chevron">${collapsed ? "▸" : "▾"}</span>${escapeHtml(g.project.name)}${waiting}</span>
      <button class="group-search-btn${groupSearch.has(pid) ? " active" : ""}" title="Search sessions" aria-label="Search sessions">${SEARCH_ICON}</button>
      <div class="relative">
        <button class="session-menu-btn project-menu-btn" title="Project options">⋯</button>
        <div class="session-menu hidden">
          <button class="session-menu-item edit-project-btn">Edit project</button>
        </div>
      </div>
      ${pid !== OTHER_PROJECT_ID ? `<button class="section-add-btn project-new-session-btn" title="New Session" aria-label="New Session">+</button>` : ""}
    `;
    header.addEventListener("click", () => {
      collapsedProjects.set(pid, !collapsed);
      renderSidebar();
    });
    header.querySelector(".group-search-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleGroupSearch(pid);
    });
    const pMenu = header.querySelector(".session-menu") as HTMLElement;
    header.querySelector(".project-menu-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".session-menu").forEach(m => {
        if (m !== pMenu) m.classList.add("hidden");
      });
      pMenu.classList.toggle("hidden");
    });
    header.querySelector(".project-new-session-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      openNewSessionDialog(pid).catch(error => console.error("Failed to open the new session dialog:", error));
    });
    header.querySelector(".edit-project-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      pMenu.classList.add("hidden");
      openProjectModal(g.project);
    });
    group.appendChild(header);

    if (!collapsed && groupSearch.has(pid)) group.appendChild(createGroupSearchBox(pid));
    if (!collapsed) group.appendChild(renderGroupBody(g));
    list.appendChild(group);
  }

  renderStandaloneSection(buildStandaloneGroup(projects, metas, now));

  const warnEl = document.getElementById("sync-warnings");
  if (warnEl) {
    warnEl.innerHTML = syncWarnings.map(w => `<div>${escapeHtml(w)}</div>`).join("");
    warnEl.classList.toggle("hidden", syncWarnings.length === 0);
  }
  document.getElementById("standalone-search-btn")?.classList.toggle("active", groupSearch.has(STANDALONE_PROJECT_ID));
  restoreSearchFocus();
}

function startEditingSessionName(sessionId: string) {
  const sidebarItem = document.getElementById(`sidebar-${sessionId}`);
  const nameText = sidebarItem?.querySelector(".session-name-text");
  const nameInput = sidebarItem?.querySelector(".session-name-input") as HTMLInputElement;

  if (nameText && nameInput) {
    nameText.classList.add("hidden");
    nameInput.classList.remove("hidden");
    nameInput.focus();
    nameInput.select();
  }
}

function finishEditingSessionName(sessionId: string) {
  const sidebarItem = document.getElementById(`sidebar-${sessionId}`);
  const nameText = sidebarItem?.querySelector(".session-name-text");
  const nameInput = sidebarItem?.querySelector(".session-name-input") as HTMLInputElement;
  const session = sessions.get(sessionId);

  if (nameInput?.classList.contains("hidden")) return; // already finished/cancelled
  if (nameText && nameInput && session) {
    const newName = nameInput.value.trim();
    if (newName && newName !== session.name) {
      // Update session name
      session.name = newName;
      nameText.textContent = newName;

      // Update tab name if exists
      const tab = document.getElementById(`tab-${sessionId}`);
      const tabName = tab?.querySelector(".tab-name");
      if (tabName) {
        tabName.textContent = newName;
        tabName.setAttribute("title", newName);
      }

      // Save to backend
      ipcRenderer.send("rename-session", sessionId, newName);
    }

    nameInput.classList.add("hidden");
    nameText.classList.remove("hidden");
    nameInput.blur();
  }
  renderSidebar();
}

function cancelEditingSessionName(sessionId: string) {
  const sidebarItem = document.getElementById(`sidebar-${sessionId}`);
  const nameText = sidebarItem?.querySelector(".session-name-text");
  const nameInput = sidebarItem?.querySelector(".session-name-input") as HTMLInputElement;
  const session = sessions.get(sessionId);

  if (nameInput?.classList.contains("hidden")) return;
  if (nameText && nameInput && session) {
    // Reset to original name
    nameInput.value = session.name;
    nameInput.classList.add("hidden");
    nameText.classList.remove("hidden");
    nameInput.blur();
  }
  renderSidebar();
}

function handleSessionClick(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (runtime[sessionId]?.externallyOpen) {
    showToast("This conversation is open elsewhere (VSCode/terminal). Close it there first.", "warning");
    return;
  }

  if (session.hasActivePty) {
    // Just switch to it
    switchToSession(sessionId);
  } else {
    // Reopen the session
    ipcRenderer.send("reopen-session", sessionId);
  }
}

function addTab(sessionId: string, name: string) {
  const tabsContainer = document.getElementById("tabs");
  if (!tabsContainer) return;

  const tab = document.createElement("div");
  tab.id = `tab-${sessionId}`;
  tab.className = "tab";
  tab.dataset.sessionId = sessionId;
  tab.draggable = true;
  tab.innerHTML = `
    <span class="unread-indicator"></span>
    <span class="tab-name" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
    <button class="tab-close-btn" data-id="${sessionId}">×</button>
  `;

  tab.addEventListener("click", (e) => {
    if (!(e.target as HTMLElement).classList.contains("tab-close-btn")) {
      switchToSession(sessionId);
    }
  });

  const closeBtn = tab.querySelector(".tab-close-btn");
  closeBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeSession(sessionId);
  });

  tab.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    openTabContextMenu(sessionId, e.clientX, e.clientY);
  });

  tab.addEventListener("dragstart", (e) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(SESSION_DRAG_MIME, sessionId);
    e.dataTransfer.effectAllowed = "move";
    tab.classList.add("dragging");
  });
  tab.addEventListener("dragend", () => {
    tab.classList.remove("dragging");
    clearDropMarkers();
  });

  // Follow the saved tab order (restored across restarts)
  paneState = {...paneState, tabOrder: ensureInTabOrder(paneState.tabOrder, sessionId)};
  savePaneState();
  const beforeId = tabInsertBefore(paneState.tabOrder, sessionId, openTabIds());
  const before = beforeId ? document.getElementById(`tab-${beforeId}`) : null;
  tabsContainer.insertBefore(tab, before);
}

function markSessionAsUnread(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Add unread indicator to tab
  const tab = document.getElementById(`tab-${sessionId}`);
  if (tab) {
    tab.classList.add("unread");
  }
}

function clearUnreadStatus(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Remove unread indicator from tab
  const tab = document.getElementById(`tab-${sessionId}`);
  if (tab) {
    tab.classList.remove("unread");
  }
}

function markSessionActivity(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Add activity indicator to tab
  const tab = document.getElementById(`tab-${sessionId}`);
  if (tab) {
    tab.classList.add("activity");
    tab.classList.remove("unread");
  }

  // Clear any existing timer
  const existingTimer = activityTimers.get(sessionId);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Set a new timer to remove activity after 1 second of no output
  const timer = setTimeout(() => {
    clearActivityStatus(sessionId);
  }, 1000);

  activityTimers.set(sessionId, timer);
}

function clearActivityStatus(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Remove activity indicator from tab, but keep unread if it's set
  const tab = document.getElementById(`tab-${sessionId}`);
  if (tab) {
    tab.classList.remove("activity");
    // If there's no unread status, transition to unread after activity ends
    if (!tab.classList.contains("unread") && !isShownInPane(sessionId)) {
      tab.classList.add("unread");
    }
  }

  // Clear the timer
  activityTimers.delete(sessionId);
}

type DirOccupancy =
  | {kind: "free"}
  | {kind: "agentyard"; sessionId: string; sessionName: string}
  | {kind: "external"};

interface DirInfo {
  dir: string;
  name: string;
  branch: string | null;
  occupancy: DirOccupancy;
}

// Pane header breadcrumbs: dir info per project, refreshed together and shared by panes of a project
let dirInfoCache = new Map<string, DirInfo[]>();
let breadcrumbRefreshSeq = 0;
let breadcrumbTimer: NodeJS.Timeout | null = null;
let dirPickerBusy = false;
let dirPickerCloser: (() => void) | null = null;
let dirPickerSessionId: string | null = null;

function isLocalClaude(config: SessionConfig): boolean {
  return config.sessionType === "local" && config.codingAgent === "claude";
}

async function fetchDirInfo(projectId: string | undefined): Promise<DirInfo[]> {
  if (!projectId) return [];
  try {
    return await ipcRenderer.invoke("get-dir-info", projectId) as DirInfo[];
  } catch (error) {
    console.error(`get-dir-info failed for project ${projectId}:`, error);
    return [];
  }
}

function closeDirPicker() {
  if (dirPickerCloser) dirPickerCloser();
}

// Re-render every pane header from the cache, then fetch dir info once per shown project;
// a newer refresh makes older results stale. Polls every 10 s while a pane shows a session.
async function refreshPaneBreadcrumbs(): Promise<void> {
  renderPaneBreadcrumbs();
  const shown = visibleSessions(paneState);
  if (shown.length === 0) {
    if (breadcrumbTimer) {
      clearInterval(breadcrumbTimer);
      breadcrumbTimer = null;
    }
    return;
  }
  if (!breadcrumbTimer) breadcrumbTimer = setInterval(() => refreshPaneBreadcrumbs(), 10000);

  const seq = ++breadcrumbRefreshSeq;
  const projectIds = Array.from(new Set(shown.flatMap(id => {
    const projectId = sessions.get(id)?.meta.projectId;
    return projectId ? [projectId] : [];
  })));
  const results = await Promise.all(projectIds.map(id => fetchDirInfo(id)));
  if (seq !== breadcrumbRefreshSeq) return; // stale result
  dirInfoCache = new Map(projectIds.map((id, idx) => [id, results[idx]]));
  renderPaneBreadcrumbs();
}

function renderPaneBreadcrumbs() {
  paneElements.forEach((pane, leafId) => {
    const id = paneSession(paneState, leafId);
    renderPaneBreadcrumb(pane, leafId, id ? sessions.get(id) : undefined);
  });
}

// Header breadcrumb: project › session › 📁 dir ▾  ⎇ branch. Rebuilt only when its content changes,
// so a refresh landing between mousedown and click does not swallow a click on 📁.
function renderPaneBreadcrumb(pane: HTMLElement, leafId: number, session: Session | undefined) {
  const header = pane.querySelector(".pane-header") as HTMLElement | null;
  const crumb = header?.querySelector(".pane-breadcrumb") as HTMLElement | null;
  if (!header || !crumb) return;
  header.querySelectorAll<HTMLElement>(".pane-session-action").forEach(btn => btn.classList.toggle("hidden", !session));

  if (!session) {
    if (crumb.dataset.sig === "empty") return;
    crumb.dataset.sig = "empty";
    const empty = document.createElement("span");
    empty.className = "breadcrumb-empty";
    empty.textContent = "Empty pane";
    crumb.replaceChildren(empty);
    return;
  }

  const projectId = session.meta.projectId;
  const dir = session.config.projectDir;
  const info = projectId ? dirInfoCache.get(projectId)?.find(i => i.dir === dir) : undefined;
  const projectName = projectId && isStandaloneProject(projectId)
    ? STANDALONE_PROJECT_NAME
    : projects.find(p => p.id === projectId)?.name ?? "";
  const dirName = dir ? (info?.name ?? path.basename(dir)) : "choose directory";
  const branch = info?.branch ?? session.meta.gitBranch ?? null;
  const dirMode = !isLocalClaude(session.config) || !hasOtherDirectory(projectId, dir) ? "text"
    : runtime[session.id]?.externallyOpen ? "external"
    : session.hasActivePty ? "active" : "free";

  const sig = JSON.stringify([session.id, projectName, session.name, dirName, dirMode, branch]);
  if (crumb.dataset.sig === sig) return;
  crumb.dataset.sig = sig;

  const nodes: HTMLElement[] = [];
  const addSep = () => {
    if (nodes.length === 0) return;
    const sep = document.createElement("span");
    sep.className = "breadcrumb-sep";
    sep.textContent = "›";
    nodes.push(sep);
  };
  const addPart = (text: string) => {
    addSep();
    const part = document.createElement("span");
    part.className = "breadcrumb-part";
    part.textContent = text;
    part.title = text;
    nodes.push(part);
    return part;
  };
  if (projectName) addPart(projectName);
  addPart(session.name).classList.add("breadcrumb-name");
  const dirLabel = `📁 ${dirName}`;
  if (dirMode === "text") {
    addPart(dirLabel).classList.add("breadcrumb-dir-text");
  } else {
    addSep();
    const btn = document.createElement("button");
    btn.className = "breadcrumb-dir";
    btn.draggable = false;
    btn.textContent = `${dirLabel} ▾`;
    btn.title = dir || "Choose a directory";
    if (dirMode === "external") {
      btn.disabled = true;
      btn.title = "Session is open elsewhere";
    } else if (dirMode === "active") {
      btn.title = `${dir} — pick another directory to restart the session there`;
    }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onPaneDirClick(leafId, session.id);
    });
    nodes.push(btn);
  }
  if (branch) {
    const branchEl = document.createElement("span");
    branchEl.className = "breadcrumb-branch";
    branchEl.textContent = `⎇ ${branch}`;
    branchEl.title = branch;
    nodes.push(branchEl);
  }
  crumb.replaceChildren(...nodes);
}

// Whether the session's project offers a directory other than the one it runs in;
// with a single directory there is nothing to switch to, so no picker is offered.
function hasOtherDirectory(projectId: string | undefined, currentDir: string): boolean {
  const dirs = projects.find(p => p.id === projectId)?.dirs ?? [];
  const current = currentDir ? path.resolve(currentDir) : "";
  return dirs.some(d => path.resolve(d) !== current);
}

// 📁 in a pane header: opens the picker; a running session is restarted only once a directory is picked
function onPaneDirClick(leafId: number, sessionId: string) {
  const current = sessions.get(sessionId);
  if (!current) return;
  void leafId; // the picker anchors to the pane that shows the session
  showDirPickerFor(sessionId);
}

async function openDirPicker(sessionId: string): Promise<void> {
  closeDirPicker();
  const session = sessions.get(sessionId);
  if (!session || !isLocalClaude(session.config)) return;
  if (runtime[sessionId]?.externallyOpen) return;

  const infos = await fetchDirInfo(session.meta.projectId);
  if (infos.length === 0) return;
  closeDirPicker(); // another picker may have opened while awaiting

  const current = session.config.projectDir;
  const popover = document.createElement("div");
  popover.className = "dir-picker";
  popover.innerHTML = infos.map((info, idx) => {
    let status: string;
    let disabled = false;
    if (info.dir === current) {
      status = "current";
      disabled = true;
    } else if (info.occupancy.kind === "free") {
      status = "free";
    } else if (info.occupancy.kind === "agentyard") {
      status = `in use: ${escapeHtml(info.occupancy.sessionName)}`;
    } else {
      status = "in use elsewhere";
    }
    const branch = info.branch ? `<span class="dir-picker-branch">⎇ ${escapeHtml(info.branch)}</span>` : "";
    return `<button class="dir-picker-row" data-idx="${idx}" ${disabled ? "disabled" : ""}>
      <span class="dir-picker-name">${escapeHtml(info.name)}</span>${branch}
      <span class="dir-picker-status">${status}</span></button>`;
  }).join("");

  // Anchored under the 📁 of the pane showing the session (looked up again: headers get rebuilt)
  const position = () => {
    const leafId = paneOfSession(paneState, sessionId);
    const pane = leafId !== null ? paneElements.get(leafId) : undefined;
    const anchor = pane?.querySelector<HTMLElement>(".pane-header .breadcrumb-dir");
    const rect = anchor ? anchor.getBoundingClientRect() : null;
    popover.style.top = `${rect ? rect.bottom + 2 : 48}px`;
    popover.style.left = `${rect ? rect.left : 320}px`;
  };
  position();
  document.body.appendChild(popover);
  window.addEventListener("resize", position);

  const onDocClick = (e: MouseEvent) => {
    if (!popover.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  function close() {
    popover.remove();
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", position);
    if (dirPickerCloser === close) {
      dirPickerCloser = null;
      dirPickerSessionId = null;
    }
    if (sidebarRenderPending) renderSidebar();
  }
  dirPickerCloser = close;
  dirPickerSessionId = sessionId;
  document.addEventListener("click", onDocClick, true);
  document.addEventListener("keydown", onKey);

  popover.querySelectorAll<HTMLButtonElement>(".dir-picker-row:not([disabled])").forEach(row => {
    row.addEventListener("click", async () => {
      if (dirPickerBusy) return;
      const info = infos[Number(row.dataset.idx)];
      dirPickerBusy = true;
      popover.querySelectorAll<HTMLButtonElement>(".dir-picker-row").forEach(r => r.disabled = true);
      try {
        // A running session is closed only now that a directory was picked, then reopened there
        const wasRunning = sessions.get(sessionId)?.hasActivePty === true;
        if (wasRunning) {
          const leafId = paneOfSession(paneState, sessionId);
          closeSession(sessionId);
          if (leafId !== null) commitPanes(assignSession(paneState, leafId, sessionId));
          syncActiveSession(false);
        }
        const result = await ipcRenderer.invoke("set-session-dir", sessionId, info.dir, wasRunning) as
          {ok: boolean; error?: string; warning?: string; session?: PersistedSession};
        close();
        if (!result.ok && wasRunning) ipcRenderer.send("reopen-session", sessionId);
        if (result.ok) {
          if (result.warning) showToast(result.warning, "warning");
          // Keep the local copy in step with the store, so the pane breadcrumb shows the new dir/branch.
          const moved = sessions.get(sessionId);
          if (moved && result.session) {
            moved.meta = result.session;
            moved.config = result.session.config;
          }
          refreshPaneBreadcrumbs();
          ipcRenderer.send("reopen-session", sessionId);
        } else {
          showToast(result.error ?? "Could not change directory", "error");
        }
      } catch (error) {
        close();
        showToast(`set-session-dir failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        dirPickerBusy = false;
      }
    });
  });
}

// Open the picker under the 📁 of the pane showing the session; a session in no pane is shown first.
async function showDirPickerFor(sessionId: string): Promise<void> {
  if (!sessions.has(sessionId)) return;
  if (paneOfSession(paneState, sessionId) === null) {
    commitPanes(showSession(paneState, sessionId));
    syncActiveSession(false);
  }
  await refreshPaneBreadcrumbs();
  if (paneOfSession(paneState, sessionId) === null) return; // moved out of the panes meanwhile
  await openDirPicker(sessionId);
}

window.addEventListener("focus", () => {
  refreshPaneBreadcrumbs();
});

ipcRenderer.on("session-needs-dir", (_event, sessionId: string) => {
  showDirPickerFor(sessionId);
});

function resetCreateButton() {
  const btn = document.getElementById("create-session") as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = false;
    btn.textContent = "Create Session";
    btn.classList.remove("loading");
  }
}

// Non-blocking notices from main (e.g. other agents already work in the directory)
ipcRenderer.on("session-warning", (_event, message: string) => {
  showToast(message, "warning");
});

ipcRenderer.on("session-error", async (_event, message: string) => {
  resetCreateButton();
  showToast(message, "error");
  // Keep the dialog open; refresh occupancy so the user can pick another directory
  const dialog = document.getElementById("config-modal");
  if (dialog && !dialog.classList.contains("hidden") && projectSelect?.value) {
    try {
      await loadDirectoryOptions(projectSelect.value);
    } catch (error) {
      console.error(`Failed to refresh directories for project ${projectSelect.value}:`, error);
    }
  }
});

// Split panes: a tree of panes, each showing one session's terminal; the focused pane decides activeSessionId
function loadPaneState(): PaneState {
  try {
    const raw = localStorage.getItem(PANE_STATE_KEY);
    return parsePaneState(raw ? JSON.parse(raw) : null);
  } catch (error) {
    console.error("Error restoring pane layout:", error);
    return createPaneState();
  }
}

function savePaneState() {
  try {
    localStorage.setItem(PANE_STATE_KEY, JSON.stringify(paneState));
  } catch (error) {
    console.error("Error saving pane layout:", error);
  }
}

// --- Tab context menu (right click), VS Code style ---
type ContextMenuItem = {label: string; run: () => void; disabled?: boolean} | "separator";
let contextMenu: HTMLElement | null = null;

function closeContextMenu() {
  contextMenu?.remove();
  contextMenu = null;
  document.removeEventListener("mousedown", onContextMenuOutside, true);
  document.removeEventListener("keydown", onContextMenuKey, true);
  window.removeEventListener("blur", closeContextMenu);
  window.removeEventListener("resize", closeContextMenu);
}

function onContextMenuOutside(e: MouseEvent) {
  if (!contextMenu?.contains(e.target as Node)) closeContextMenu();
}

function onContextMenuKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  closeContextMenu();
}

function openContextMenu(x: number, y: number, items: ContextMenuItem[]) {
  closeContextMenu();
  const menu = document.createElement("div");
  menu.className = "attach-menu context-menu";
  for (const entry of items) {
    if (entry === "separator") {
      const sep = document.createElement("div");
      sep.className = "context-menu-separator";
      menu.appendChild(sep);
      continue;
    }
    const item = document.createElement("button");
    item.className = "session-menu-item";
    item.textContent = entry.label;
    item.disabled = !!entry.disabled;
    item.addEventListener("click", () => {
      closeContextMenu();
      entry.run();
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  contextMenu = menu;
  // Keep the menu inside the window
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - menu.offsetHeight - 4))}px`;
  document.addEventListener("mousedown", onContextMenuOutside, true);
  document.addEventListener("keydown", onContextMenuKey, true);
  window.addEventListener("blur", closeContextMenu);
  window.addEventListener("resize", closeContextMenu);
}

function openTabContextMenu(sessionId: string, x: number, y: number) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const tabs = openTabIds();
  const index = tabs.indexOf(sessionId);
  const others = tabs.filter(id => id !== sessionId);
  const toTheRight = tabs.slice(index + 1);
  const inFocusedPane = paneSession(paneState, paneState.focused) === sessionId;
  const localClaude = isLocalClaude(session.config);
  const dir = session.worktreePath || session.config.projectDir;
  openContextMenu(x, y, [
    {label: "Close", run: () => closeSession(sessionId)},
    {label: "Close Others", run: () => others.forEach(closeSession), disabled: others.length === 0},
    {label: "Close to the Right", run: () => toTheRight.forEach(closeSession), disabled: toTheRight.length === 0},
    {label: "Close All", run: () => tabs.forEach(closeSession)},
    "separator",
    {label: "Split Right", run: () => splitPaneWith(paneState.focused, "right", sessionId), disabled: inFocusedPane},
    {label: "Split Down", run: () => splitPaneWith(paneState.focused, "bottom", sessionId), disabled: inFocusedPane},
    "separator",
    {label: "Rename…", run: () => startEditingTabName(sessionId)},
    {label: "Fork", run: () => ipcRenderer.send("fork-session", sessionId), disabled: !localClaude},
    {label: "Copy Directory Path", run: () => {
      clipboard.writeText(dir);
      showToast(`Copied ${dir}`, "info");
    }, disabled: !dir},
  ]);
}

// Inline rename on the tab itself (Enter saves, Escape cancels)
function startEditingTabName(sessionId: string) {
  const tab = document.getElementById(`tab-${sessionId}`);
  const nameEl = tab?.querySelector<HTMLElement>(".tab-name");
  const session = sessions.get(sessionId);
  if (!tab || !nameEl || !session) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "tab-name-input";
  input.value = session.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    if (save && newName && newName !== session.name) {
      session.name = newName;
      ipcRenderer.send("rename-session", sessionId, newName);
    }
    nameEl.textContent = session.name;
    nameEl.setAttribute("title", session.name);
    input.replaceWith(nameEl);
    renderSidebar();
    refreshPaneBreadcrumbs();
  };
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finish(true);
    else if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
  input.addEventListener("click", (e) => e.stopPropagation());
  input.addEventListener("mousedown", (e) => e.stopPropagation());
}

function openTabIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("#tabs .tab")).map(tab => tab.dataset.sessionId ?? "");
}

function isSessionDrag(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(SESSION_DRAG_MIME);
}

function isPaneDrag(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(PANE_DRAG_MIME);
}

// Files dragged in from the OS file manager (tabs and pane headers use their own MIME types)
function isFileDrag(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
}

// Visible in any pane counts as seen for the tab unread/activity marks
function isShownInPane(sessionId: string): boolean {
  return visibleSessions(paneState).includes(sessionId) && !!sessions.get(sessionId)?.element;
}

function clearDropMarkers() {
  document.querySelectorAll(".tab.drop-before, .tab.drop-after, .pane.drop-target").forEach(el => {
    el.classList.remove("drop-before", "drop-after", "drop-target");
  });
}

function warnPaneLimit() {
  showToast(`At most ${MAX_PANES} panes can be open.`, "warning");
}

// Pane DOM elements by leaf id; they survive tree changes, so terminals are only reparented
const paneElements = new Map<number, HTMLElement>();
let draggingPaneId: number | null = null;

function createPaneElement(leafId: number): HTMLElement {
  const pane = document.createElement("div");
  pane.className = "pane";
  pane.dataset.leafId = String(leafId);
  pane.appendChild(createPaneHeader(pane, leafId));
  const promptLine = document.createElement("div");
  promptLine.className = "pane-prompt empty";
  promptLine.innerHTML = `<span class="pane-prompt-glyph">❯</span><span class="pane-prompt-text"></span>
    <button class="pane-prompt-list" title="All prompts" disabled>▾</button>`;
  const listButton = promptLine.querySelector(".pane-prompt-list") as HTMLButtonElement;
  listButton.addEventListener("click", (e) => {
    e.stopPropagation();
    if (promptPickerLeafId === leafId) promptPickerCloser?.();
    else openPromptPicker(leafId, listButton);
  });
  promptLine.addEventListener("click", () => {
    const sessionId = paneSession(paneState, leafId);
    const sticky = sessionId ? stickyPrompts.get(sessionId) : undefined;
    const current = sticky?.currentIndex() ?? null;
    if (sticky && current !== null) scrollPaneToPrompt(sticky, current);
  });
  pane.appendChild(promptLine);
  const placeholder = document.createElement("div");
  placeholder.className = "pane-placeholder";
  pane.appendChild(placeholder);
  const preview = document.createElement("div");
  preview.className = "pane-drop-preview";
  pane.appendChild(preview);

  // Capture phase: the terminal inside handles the mouse itself
  pane.addEventListener("mousedown", () => focusPaneAt(leafId), true);
  placeholder.addEventListener("click", () => reopenPaneSession(leafId));
  pane.addEventListener("dragover", (e) => {
    if (isFileDrag(e)) {
      onFileDragOver(e, pane, leafId);
      return;
    }
    if (!isSessionDrag(e) && !isPaneDrag(e)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = "move";
    showDropPreview(pane, paneDropZone(e, pane, leafId));
  });
  pane.addEventListener("dragleave", (e) => {
    if (!pane.contains(e.relatedTarget as Node | null)) pane.classList.remove("drop-target");
  });
  pane.addEventListener("drop", (e) => {
    if (isFileDrag(e)) {
      onFileDrop(e, leafId);
      return;
    }
    if (!isSessionDrag(e) && !isPaneDrag(e)) return;
    e.preventDefault();
    const zone = paneDropZone(e, pane, leafId);
    clearDropMarkers();
    if (isPaneDrag(e)) {
      const from = Number(e.dataTransfer!.getData(PANE_DRAG_MIME));
      if (zone === "center") swapPanesAt(from, leafId);
      else movePaneAt(from, leafId, zone);
      return;
    }
    const sessionId = e.dataTransfer!.getData(SESSION_DRAG_MIME);
    if (zone === "center") dropSessionOnPane(leafId, sessionId);
    else splitPaneWith(leafId, zone, sessionId);
  });
  return pane;
}

// Edge zones split (tab) or move (pane header); none at the pane limit for tabs, none on the dragged pane itself
function paneDropZone(e: DragEvent, pane: HTMLElement, leafId: number): Side | "center" {
  const rect = pane.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top) / rect.height;
  const allowEdges = isPaneDrag(e) ? draggingPaneId !== leafId : canSplit(paneState);
  return dropZone(x, y, allowEdges);
}

function showDropPreview(pane: HTMLElement, zone: Side | "center") {
  if (!pane.classList.contains("drop-target")) {
    document.querySelectorAll(".pane.drop-target").forEach(el => el.classList.remove("drop-target"));
    pane.classList.add("drop-target");
  }
  const preview = pane.querySelector(".pane-drop-preview") as HTMLElement;
  preview.dataset.zone = zone;
}

// Thin strip above each pane: breadcrumb, drag handle (2+ panes) plus split buttons and close (2+ panes)
function createPaneHeader(pane: HTMLElement, leafId: number): HTMLElement {
  const header = document.createElement("div");
  header.className = "pane-header";
  header.innerHTML = `
    <span class="pane-breadcrumb"></span>
    <span class="pane-header-actions">
      <button class="pane-action pane-session-action" data-action="attach" title="Attach files or a clipboard image">+</button>
      <button class="pane-action pane-session-action" data-action="voice" title="Toggle Claude voice mode (/voice)">🎤</button>
      <button class="pane-action" data-action="right" title="Split right">◫</button>
      <button class="pane-action" data-action="down" title="Split down">⬒</button>
      <button class="pane-action" data-action="close" title="Close pane">×</button>
    </span>`;
  header.querySelectorAll<HTMLButtonElement>(".pane-action").forEach(btn => {
    btn.draggable = false;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      if (action === "attach" || action === "voice") focusPaneAt(leafId);
      if (action === "attach") openAttachMenu(btn, leafId);
      else if (action === "voice") toggleVoiceMode(leafId);
      else if (action === "close") closePaneAt(leafId);
      else splitPaneWith(leafId, action === "right" ? "right" : "bottom", null);
    });
  });
  // dragstart always targets the header itself, so remember where the press began:
  // a slightly moved click on a header button, the 📁 picker or the branch must not start a pane drag
  let pressedOnAction = false;
  header.addEventListener("mousedown", (e) => {
    pressedOnAction = !!(e.target as HTMLElement).closest(".pane-action, .breadcrumb-dir, .breadcrumb-branch");
  });
  header.addEventListener("dragstart", (e) => {
    if (!e.dataTransfer || paneTotal() < 2 || pressedOnAction) {
      e.preventDefault();
      return;
    }
    draggingPaneId = leafId;
    e.dataTransfer.setData(PANE_DRAG_MIME, String(leafId));
    e.dataTransfer.effectAllowed = "move";
    pane.classList.add("dragging");
  });
  header.addEventListener("dragend", () => {
    draggingPaneId = null;
    pane.classList.remove("dragging");
    clearDropMarkers();
  });
  return header;
}

// Attachments and voice: only for a live Claude session shown in the pane
function paneClaudeSession(leafId: number): Session | null {
  const id = paneSession(paneState, leafId);
  const session = id ? sessions.get(id) : undefined;
  if (!session || !session.terminal || !session.hasActivePty || session.config.codingAgent !== "claude") return null;
  return session;
}

// Bracketed paste of the paths, no Enter: Claude Code turns image paths into [Image #N]
function insertPathsIntoPane(leafId: number, paths: string[]) {
  const session = paneClaudeSession(leafId);
  if (!session) {
    showToast("This pane has no running Claude session", "warning");
    return;
  }
  const text = buildPathPaste(paths);
  if (!text) {
    showToast("No usable file path to insert", "warning");
    return;
  }
  ipcRenderer.send("session-input", session.id, text);
  session.terminal?.focus();
}

async function attachFilesToPane(leafId: number) {
  try {
    const result = await ipcRenderer.invoke("select-attachment-files") as
      { ok: true; paths: string[] } | { ok: false; error: string };
    if (!result.ok) {
      showToast(result.error, "error");
      return;
    }
    if (result.paths.length > 0) insertPathsIntoPane(leafId, result.paths);
  } catch (error) {
    showToast(`select-attachment-files failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function pasteClipboardImageToPane(leafId: number) {
  const session = paneClaudeSession(leafId);
  if (!session) return;
  try {
    const result = await ipcRenderer.invoke("save-clipboard-image", session.id) as
      { ok: true; path: string } | { ok: false; error: string; empty?: boolean };
    if (!result.ok) {
      showToast(result.error, result.empty ? "warning" : "error");
      return;
    }
    insertPathsIntoPane(leafId, [result.path]);
  } catch (error) {
    showToast(`save-clipboard-image failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

function toggleVoiceMode(leafId: number) {
  const session = paneClaudeSession(leafId);
  if (!session) return;
  ipcRenderer.send("session-input", session.id, "/voice\r");
  session.terminal?.focus();
  showToast("Toggled Claude voice mode — the terminal shows whether it is on (hold Space to talk)");
}

// "+" dropdown, fixed to the viewport so the pane's overflow does not clip it
let attachMenu: HTMLElement | null = null;

function closeAttachMenu() {
  attachMenu?.remove();
  attachMenu = null;
  document.removeEventListener("mousedown", onAttachMenuOutside, true);
  document.removeEventListener("keydown", onAttachMenuKey, true);
  window.removeEventListener("blur", closeAttachMenu);
  window.removeEventListener("resize", closeAttachMenu);
}

function onAttachMenuOutside(e: MouseEvent) {
  const target = e.target as Node;
  if (attachMenu?.contains(target) || (target as HTMLElement).closest?.('.pane-action[data-action="attach"]')) return;
  closeAttachMenu();
}

function onAttachMenuKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  e.stopPropagation();
  closeAttachMenu();
}

function openAttachMenu(button: HTMLElement, leafId: number) {
  const wasOpenHere = attachMenu?.dataset.leafId === String(leafId);
  closeAttachMenu();
  if (wasOpenHere || !paneClaudeSession(leafId)) return;

  const menu = document.createElement("div");
  menu.className = "attach-menu";
  menu.dataset.leafId = String(leafId);
  const items: Array<[string, () => void]> = [
    ["Attach file…", () => attachFilesToPane(leafId)],
    ["Paste image from clipboard", () => pasteClipboardImageToPane(leafId)],
  ];
  for (const [label, run] of items) {
    const item = document.createElement("button");
    item.className = "session-menu-item";
    item.textContent = label;
    item.addEventListener("click", () => {
      closeAttachMenu();
      run();
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  attachMenu = menu;

  const rect = button.getBoundingClientRect();
  const left = Math.min(rect.left, window.innerWidth - menu.offsetWidth - 4);
  menu.style.left = `${Math.max(4, left)}px`;
  menu.style.top = `${rect.bottom + 2}px`;
  document.addEventListener("mousedown", onAttachMenuOutside, true);
  document.addEventListener("keydown", onAttachMenuKey, true);
  window.addEventListener("blur", closeAttachMenu);
  window.addEventListener("resize", closeAttachMenu);
}

// OS file drops: highlight the whole pane, insert the files' paths into its session
function onFileDragOver(e: DragEvent, pane: HTMLElement, leafId: number) {
  e.preventDefault();
  if (!paneClaudeSession(leafId)) {
    e.dataTransfer!.dropEffect = "none";
    pane.classList.remove("drop-target");
    return;
  }
  e.dataTransfer!.dropEffect = "copy";
  showDropPreview(pane, "center");
}

function droppedFilePath(file: File): string {
  try {
    const filePath = webUtils.getPathForFile(file);
    if (filePath) return filePath;
  } catch (error) {
    console.error(`webUtils.getPathForFile failed for ${file.name}:`, error);
  }
  return (file as File & {path?: string}).path ?? "";
}

function onFileDrop(e: DragEvent, leafId: number) {
  e.preventDefault();
  clearDropMarkers();
  if (!paneClaudeSession(leafId)) {
    showToast("No running Claude session in this pane to attach files to", "warning");
    return;
  }
  focusPaneAt(leafId);
  const files = Array.from(e.dataTransfer?.files ?? []);
  const paths = files.map(droppedFilePath).filter(p => p !== "");
  if (paths.length < files.length) showToast("Some dropped items have no file path and were skipped", "warning");
  if (paths.length > 0) insertPathsIntoPane(leafId, paths);
}

function paneTotal(): number {
  return leaves(paneState.root).length;
}

// Splitter bars from splitterSpecs plus, in the linked 2×2 shape, a move handle where they cross
const SPLITTER_CLASSES = {x: "splitter-x", y: "splitter-y", xy: "splitter-xy"};

interface SplitDrag {
  path: string;
  start: number; // extent of the split along its axis, as fractions of the pane area
  size: number;
}

function buildSplitters(grid: HTMLElement) {
  grid.querySelectorAll(".pane-splitter").forEach(splitter => splitter.remove());
  for (const spec of splitterSpecs(paneState.root)) {
    const drag = {path: spec.path, start: spec.start, size: spec.size};
    const splitter = createSplitter(spec.axis, spec.axis === "x" ? {x: drag} : {y: drag});
    splitter.dataset.path = spec.path;
    grid.appendChild(splitter);
  }
  const cross = crossHandle(paneState);
  if (cross) {
    // The cross moves the root split and the (linked) child splits, all spanning the full area
    const handle = createSplitter("xy", {x: {path: cross.xPath, start: 0, size: 1}, y: {path: cross.yPath, start: 0, size: 1}});
    handle.textContent = "✥";
    grid.appendChild(handle);
  }
}

function createSplitter(kind: "x" | "y" | "xy", drags: {x?: SplitDrag; y?: SplitDrag}): HTMLElement {
  const splitter = document.createElement("div");
  splitter.className = `pane-splitter ${SPLITTER_CLASSES[kind]}`;
  splitter.title = "Drag to resize, double-click to reset";
  splitter.addEventListener("mousedown", (e) => startSplitDrag(e, splitter, drags));
  splitter.addEventListener("dblclick", () => {
    let next = paneState;
    if (drags.x) next = setRatio(next, drags.x.path, 0.5);
    if (drags.y) next = setRatio(next, drags.y.path, 0.5);
    commitPanes(next);
  });
  return splitter;
}

let splitRefitFrame = 0;

function scheduleRefit() {
  if (splitRefitFrame) return;
  splitRefitFrame = requestAnimationFrame(() => {
    splitRefitFrame = 0;
    window.dispatchEvent(new Event("resize"));
  });
}

function startSplitDrag(e: MouseEvent, splitter: HTMLElement, drags: {x?: SplitDrag; y?: SplitDrag}) {
  if (e.button !== 0) return; // only the primary button resizes
  const grid = document.getElementById("pane-grid");
  if (!grid) return;
  e.preventDefault();
  const rect = grid.getBoundingClientRect();
  splitter.classList.add("dragging");
  document.body.style.cursor = getComputedStyle(splitter).cursor;
  document.body.style.userSelect = "none";

  const onMove = (ev: MouseEvent) => {
    let next = paneState;
    if (drags.x) next = setRatio(next, drags.x.path, ((ev.clientX - rect.left) / rect.width - drags.x.start) / drags.x.size);
    if (drags.y) next = setRatio(next, drags.y.path, ((ev.clientY - rect.top) / rect.height - drags.y.start) / drags.y.size);
    paneState = next;
    applySplits(grid);
    scheduleRefit();
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
    splitter.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    savePaneState();
    scheduleRefit();
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

const pct = (fraction: number) => `${fraction * 100}%`;

// Panes are placed absolutely; inner edges give up 1px so a divider line shows between them
function applySplits(grid: HTMLElement) {
  for (const {id, rect} of paneRects(paneState.root)) {
    const pane = paneElements.get(id);
    if (!pane) continue;
    const rightGap = rect.left + rect.width < 0.9999 ? 1 : 0;
    const bottomGap = rect.top + rect.height < 0.9999 ? 1 : 0;
    pane.style.left = pct(rect.left);
    pane.style.top = pct(rect.top);
    pane.style.width = `calc(${pct(rect.width)} - ${rightGap}px)`;
    pane.style.height = `calc(${pct(rect.height)} - ${bottomGap}px)`;
  }
  const specs = new Map(splitterSpecs(paneState.root).map(spec => [spec.path, spec]));
  grid.querySelectorAll<HTMLElement>(".pane-splitter:not(.splitter-xy)").forEach(splitter => {
    const spec = specs.get(splitter.dataset.path ?? "");
    if (!spec) return;
    if (spec.axis === "x") {
      splitter.style.left = pct(spec.pos);
      splitter.style.top = pct(spec.from);
      splitter.style.height = pct(spec.to - spec.from);
    } else {
      splitter.style.top = pct(spec.pos);
      splitter.style.left = pct(spec.from);
      splitter.style.width = pct(spec.to - spec.from);
    }
  });
  const cross = crossHandle(paneState);
  const handle = grid.querySelector<HTMLElement>(".splitter-xy");
  if (cross && handle) {
    handle.style.left = pct(cross.x);
    handle.style.top = pct(cross.y);
  }
}

function applyPaneFocus() {
  paneElements.forEach((pane, id) => pane.classList.toggle("focused", id === paneState.focused));
}

// Sync the pane DOM with paneState; terminals are reparented, never recreated
function renderPanes() {
  const container = document.getElementById("session-container");
  const grid = document.getElementById("pane-grid");
  if (!container || !grid) return;
  const shown = new Set(visibleSessions(paneState));
  const treeLeaves = leaves(paneState.root);
  const leafIds = new Set(treeLeaves.map(l => l.id));

  // Hidden terminals wait outside the grid; panes that left the tree hand theirs back first
  sessions.forEach((session, id) => {
    if (!session.element || shown.has(id)) return;
    session.element.classList.remove("active");
    if (session.element.parentElement !== container) container.appendChild(session.element);
  });
  paneElements.forEach((pane, id) => {
    if (leafIds.has(id)) return;
    pane.querySelectorAll(".session-wrapper").forEach(el => container.appendChild(el));
    pane.remove();
    paneElements.delete(id);
  });

  for (const leafNode of treeLeaves) {
    let pane = paneElements.get(leafNode.id);
    if (!pane) {
      pane = createPaneElement(leafNode.id);
      paneElements.set(leafNode.id, pane);
      grid.appendChild(pane);
    }
    const session = leafNode.session ? sessions.get(leafNode.session) : undefined;
    const element = session?.element;
    if (element) {
      if (element.parentElement !== pane) pane.appendChild(element);
      element.classList.add("active");
      // First time on screen: open now so xterm measures a real cell size
      if (session?.terminal && !session.terminal.element) session.terminal.open(element);
    }
    const header = pane.querySelector(".pane-header") as HTMLElement;
    header.draggable = treeLeaves.length > 1;
    header.title = treeLeaves.length > 1 ? "Drag onto another pane: center swaps, edges move it there" : "";
    renderPaneBreadcrumb(pane, leafNode.id, session);
    renderPanePrompt(pane, session?.id);
    const canAttach = !!paneClaudeSession(leafNode.id);
    header.querySelectorAll<HTMLButtonElement>(".pane-session-action").forEach(btn => {
      btn.disabled = !canAttach;
    });
    const placeholder = pane.querySelector(".pane-placeholder") as HTMLElement;
    placeholder.classList.toggle("hidden", !!element);
    placeholder.classList.toggle("reopen", !element && !!session);
    placeholder.textContent = !element && session ? `${session.name} — click to open` : "Drop a tab here";
  }

  grid.classList.toggle("multi", treeLeaves.length > 1);
  buildSplitters(grid);
  applySplits(grid);
  applyPaneFocus();
  const template = templateOf(paneState.root);
  document.querySelectorAll<HTMLElement>(".layout-btn[data-layout]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.layout === template);
  });
  renderSplitLinkToggle();
  refreshPaneBreadcrumbs();
}

// 2×2 shape only: linked = both child splits move together, free = each on its own
function renderSplitLinkToggle() {
  const toggle = document.getElementById("split-link-toggle");
  if (!toggle) return;
  toggle.classList.toggle("hidden", !is2x2(paneState.root));
  toggle.classList.toggle("active", paneState.linkedSplits);
  toggle.title = paneState.linkedSplits
    ? "Linked splits: rows resize together (click for free)"
    : "Free splits: each row resizes on its own (click to link)";
}

function toggleLinkedSplits() {
  commitPanes(setLinkedSplits(paneState, !paneState.linkedSplits));
}

function refitVisibleTerminals() {
  for (const id of visibleSessions(paneState)) {
    const session = sessions.get(id);
    if (!session?.fitAddon || !session.element?.isConnected) continue;
    const proposedDimensions = session.fitAddon.proposeDimensions();
    if (proposedDimensions) {
      session.fitAddon.fit();
      ipcRenderer.send("session-resize", id, proposedDimensions.cols, proposedDimensions.rows);
    }
  }
}

function commitPanes(next: PaneState) {
  paneState = next;
  savePaneState();
  renderPanes();
  // Triggers refitVisibleTerminals (and keeps other resize listeners in step)
  window.dispatchEvent(new Event("resize"));
}

function clearActiveSession() {
  activeSessionId = null;
  closeDirPicker();
  ipcRenderer.send("session-viewed", null);
  const mcpSection = document.getElementById("mcp-section");
  if (mcpSection) {
    mcpSection.style.display = "none";
  }
}

// activeSessionId follows the focused pane; force re-runs the activation (e.g. a tab click)
function syncActiveSession(force: boolean) {
  const focusedId = focusedSession(paneState);
  const session = focusedId ? sessions.get(focusedId) : undefined;
  const liveId = session?.terminal ? focusedId : null;
  if (!force && liveId === activeSessionId) return;

  sessions.forEach((_s, id) => {
    document.getElementById(`tab-${id}`)?.classList.toggle("active", id === liveId);
    document.getElementById(`sidebar-${id}`)?.classList.toggle("active", id === liveId);
  });

  if (!liveId || !session || !session.terminal) {
    clearActiveSession();
    return;
  }

  activeSessionId = liveId;
  closeDirPicker();
  refreshPaneBreadcrumbs();

  // Show MCP section when a session is active
  const mcpSection = document.getElementById("mcp-section");
  if (mcpSection) {
    mcpSection.style.display = "block";
  }

  // Clear MCP servers from previous session and re-render
  mcpServers = [];
  renderMcpServers();

  // Load MCP servers for this session
  loadMcpServers();

  // Clear unread and activity status when switching to this session
  // Tell main which session is being viewed (any agent, so a stale Claude id is replaced)
  ipcRenderer.send("session-viewed", liveId);
  if (session.config.codingAgent === "claude") {
    applyTabStatus(liveId);
  } else {
    clearUnreadStatus(liveId);
    clearActivityStatus(liveId);
  }

  session.terminal.focus();
}

// Focus-only change: no DOM moves, so no refit
function focusPaneAt(leafId: number) {
  if (leafId === paneState.focused) return;
  paneState = focusPane(paneState, leafId);
  savePaneState();
  applyPaneFocus();
  syncActiveSession(false);
}

function swapPanesAt(from: number, to: number) {
  if (!Number.isInteger(from) || from === to) return;
  commitPanes(swapPanes(paneState, from, to));
  syncActiveSession(true);
}

function movePaneAt(from: number, to: number, side: Side) {
  if (!Number.isInteger(from) || from === to) return;
  commitPanes(movePane(paneState, from, to, side));
  syncActiveSession(true);
}

// Split a pane; the new half gets the dropped session (or stays empty) and focus
function splitPaneWith(leafId: number, side: Side, sessionId: string | null) {
  if (sessionId) {
    const session = sessions.get(sessionId);
    if (!session || !session.element || !session.terminal) return;
  }
  const next = splitPane(paneState, leafId, side, sessionId);
  if (!next) {
    warnPaneLimit();
    return;
  }
  if (next === paneState) return; // the pane's own session dropped on its edge
  commitPanes(next);
  syncActiveSession(true);
}

// Header ×: the pane goes away, its session (if any) just becomes hidden
function closePaneAt(leafId: number) {
  if (paneTotal() < 2) return;
  commitPanes(closePane(paneState, leafId));
  syncActiveSession(false);
}

// Placeholder of a session whose PTY is gone (e.g. after a restart): reopen it into this pane
function reopenPaneSession(leafId: number) {
  const id = paneSession(paneState, leafId);
  const session = id ? sessions.get(id) : undefined;
  if (!id || !session || session.element) return;
  handleSessionClick(id);
}

function dropSessionOnPane(leafId: number, sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session || !session.element || !session.terminal) return;
  commitPanes(assignSession(paneState, leafId, sessionId));
  syncActiveSession(true);
}

// Closed or deleted session (its tab is already gone); its pane stays, empty
function dropSessionFromPanes(sessionId: string) {
  commitPanes(removeSession(paneState, sessionId, openTabIds()));
  syncActiveSession(false);
}

function tabDropTarget(tabsContainer: HTMLElement, x: number): {tab: HTMLElement; after: boolean} | null {
  const tabs = Array.from(tabsContainer.querySelectorAll<HTMLElement>(".tab"));
  for (const tab of tabs) {
    const rect = tab.getBoundingClientRect();
    if (x < rect.left + rect.width / 2) return {tab, after: false};
  }
  const last = tabs[tabs.length - 1];
  return last ? {tab: last, after: true} : null;
}

function reorderTab(sessionId: string, target: {tab: HTMLElement; after: boolean}) {
  const dragged = document.getElementById(`tab-${sessionId}`);
  const targetId = target.tab.dataset.sessionId;
  if (!dragged || !targetId || targetId === sessionId) return;
  if (target.after) target.tab.after(dragged);
  else target.tab.before(dragged);
  paneState = {...paneState, tabOrder: moveTab(paneState.tabOrder, sessionId, targetId, target.after)};
  savePaneState();
}

(function initPanes() {
  const tabsContainer = document.getElementById("tabs");
  if (tabsContainer) {
    tabsContainer.addEventListener("dragover", (e) => {
      if (!isSessionDrag(e)) return;
      e.preventDefault();
      e.dataTransfer!.dropEffect = "move";
      const target = tabDropTarget(tabsContainer, e.clientX);
      clearDropMarkers();
      target?.tab.classList.add(target.after ? "drop-after" : "drop-before");
    });
    tabsContainer.addEventListener("dragleave", (e) => {
      if (!tabsContainer.contains(e.relatedTarget as Node | null)) clearDropMarkers();
    });
    tabsContainer.addEventListener("drop", (e) => {
      if (!isSessionDrag(e)) return;
      e.preventDefault();
      const target = tabDropTarget(tabsContainer, e.clientX);
      clearDropMarkers();
      const sessionId = e.dataTransfer!.getData(SESSION_DRAG_MIME);
      if (sessionId && target) reorderTab(sessionId, target);
    });
  }

  document.getElementById("split-link-toggle")?.addEventListener("click", toggleLinkedSplits);
  document.querySelectorAll<HTMLButtonElement>(".layout-btn[data-layout]").forEach(btn => {
    btn.addEventListener("click", () => {
      const layout = btn.dataset.layout as LayoutKind;
      // The active template is a no-op: no ratio reset or leaf renumbering
      if (!LAYOUTS.includes(layout) || templateOf(paneState.root) === layout) return;
      commitPanes(applyTemplate(paneState, layout));
      syncActiveSession(false);
    });
  });

  // A file dropped anywhere else must not make the window navigate to it
  document.addEventListener("dragover", (e) => {
    if (isFileDrag(e) && !e.defaultPrevented) {
      e.preventDefault();
      e.dataTransfer!.dropEffect = "none";
    }
  });
  document.addEventListener("drop", (e) => {
    if (isFileDrag(e)) e.preventDefault();
  });

  window.addEventListener("resize", refitVisibleTerminals);
  renderPanes();
})();

function switchToSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session || !session.element || !session.terminal || !session.fitAddon) return;
  commitPanes(showSession(paneState, sessionId));
  syncActiveSession(true);
}

function closeSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Remove terminal UI
  if (session.element) {
    session.element.remove();
  }
  if (session.terminal) {
    session.terminal.dispose();
  }

  // Remove tab
  document.getElementById(`tab-${sessionId}`)?.remove();

  // Update session state
  session.terminal = null;
  session.fitAddon = null;
  session.element = null;
  session.hasActivePty = false;

  // Update UI indicator
  updateSessionState(sessionId, false);

  // Close PTY in main process
  ipcRenderer.send("close-session", sessionId);

  dropSessionFromPanes(sessionId);
}

function deleteSession(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // Confirm deletion with different message based on session type
  const isWorktree = session.config.sessionType === SessionType.WORKTREE;
  const isLocalClaude = session.config.sessionType === SessionType.LOCAL && session.config.codingAgent === "claude";
  const message = isWorktree
    ? `Delete ${session.name}? This will remove the git worktree.`
    : isLocalClaude
      ? `Remove ${session.name} from Agentyard? The conversation file is kept.`
      : `Delete ${session.name}? This will remove the session.`;

  if (!confirm(message)) {
    return;
  }

  // Remove from UI
  if (session.element) {
    session.element.remove();
  }
  if (session.terminal) {
    session.terminal.dispose();
  }
  document.getElementById(`tab-${sessionId}`)?.remove();
  document.getElementById(`sidebar-${sessionId}`)?.remove();

  // Remove from sessions map
  sessions.delete(sessionId);

  // Delete in main process (handles worktree removal)
  ipcRenderer.send("delete-session", sessionId);

  dropSessionFromPanes(sessionId);
}

function showApplyToProjectDialog(sessionId: string) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const modal = document.getElementById("apply-to-project-modal");
  const branchName = document.getElementById("apply-branch-name");
  const parentBranch = document.getElementById("apply-parent-branch");

  if (branchName && session.config.branchName) {
    branchName.textContent = session.config.branchName;
  }
  if (parentBranch && session.config.parentBranch) {
    parentBranch.textContent = session.config.parentBranch;
  }

  // Store session ID for later use in confirm handler
  modal?.setAttribute("data-session-id", sessionId);

  modal?.classList.remove("hidden");
}

// Handle session output
ipcRenderer.on("session-output", (_event, sessionId: string, data: string) => {
  const session = sessions.get(sessionId);
  if (session && session.terminal) {
    // Filter out [3J (clear scrollback) to prevent viewport resets during interactive menus
    // Keep [2J (clear screen) which is needed for the menu redraw
    const filteredData = data.replace(/\x1b\[3J/g, '');

    session.terminal.write(filteredData);

    // Only mark as unread/activity if this is not the active session
    if (session.config.codingAgent !== "claude" && !isShownInPane(sessionId) && session.hasActivePty) {
      // Show activity spinner while output is coming in
      markSessionActivity(sessionId);

      // Check if Claude session is ready for input
      if (isClaudeSessionReady(filteredData)) {
        // Clear activity timer and set unread
        const existingTimer = activityTimers.get(sessionId);
        if (existingTimer) {
          clearTimeout(existingTimer);
          activityTimers.delete(sessionId);
        }

        const tab = document.getElementById(`tab-${sessionId}`);
        if (tab) {
          tab.classList.remove("activity");
          tab.classList.add("unread");
        }
      }
    }
  }
});

// Handle hook-based status updates from main
ipcRenderer.on("session-status", (_event, sessionId: string, status: SessionStatus) => {
  const session = sessions.get(sessionId);
  if (!session) return;
  session.status = status;
  session.meta = { ...session.meta, status };
  refreshSessionIndicator(sessionId);
  applyTabStatus(sessionId);
  renderSidebar();
});

// A hook event may follow a new prompt in the transcript: refresh that session's pane prompt line
ipcRenderer.on("session-prompts-changed", (_event, sessionId: string) => {
  const sticky = stickyPrompts.get(sessionId);
  if (!sticky) return;
  if (sessions.get(sessionId)?.terminal !== sticky.term) {
    stickyPrompts.delete(sessionId); // terminal was disposed or recreated
    return;
  }
  sticky.refreshPrompts();
});

// Handle session created
ipcRenderer.on("session-created", (_event, sessionId: string, persistedSession: any) => {
  const session = addSession(persistedSession, true);
  activateSession(sessionId);

  // Reset button state and close modal
  const createBtn = document.getElementById("create-session") as HTMLButtonElement;
  const modal = document.getElementById("config-modal");
  const parentBranchSelect = document.getElementById("parent-branch") as HTMLSelectElement;
  const branchNameInput = document.getElementById("branch-name") as HTMLInputElement;
  const setupCommandsTextarea = document.getElementById("setup-commands") as HTMLTextAreaElement;

  resetCreateButton();

  modal?.classList.add("hidden");

  // Reset form
  selectedDirectory = "";
  parentBranchSelect.innerHTML = '<option value="">Loading branches...</option>';
  if (branchNameInput) {
    branchNameInput.value = "";
  }
  if (setupCommandsTextarea) {
    setupCommandsTextarea.value = "";
  }

  // Reset validation state
  const branchNameError = document.getElementById("branch-name-error");
  const branchNameHelp = document.getElementById("branch-name-help");
  branchNameError?.classList.add("hidden");
  branchNameHelp?.classList.remove("hidden");
  existingBranches = [];
});

// Handle session reopened
ipcRenderer.on("session-reopened", (_event, sessionId: string) => {
  activateSession(sessionId);
});

// Handle session deleted
ipcRenderer.on("session-deleted", (_event, sessionId: string) => {
  const session = sessions.get(sessionId);
  if (session) {
    if (session.element) session.element.remove();
    if (session.terminal) session.terminal.dispose();
    document.getElementById(`tab-${sessionId}`)?.remove();
    document.getElementById(`sidebar-${sessionId}`)?.remove();
    sessions.delete(sessionId);
    renderSidebar();
    if (dirPickerSessionId === sessionId) closeDirPicker();
    dropSessionFromPanes(sessionId);
  }
});

// Load persisted sessions on startup
ipcRenderer.on("load-persisted-sessions", (_event, persistedSessions: PersistedSession[]) => {
  persistedSessions.forEach(ps => {
    addSession(ps, false, false);
  });
  renderSidebar();
  // Panes saved for sessions that no longer exist become empty
  paneState = pruneSessions(paneState, new Set(sessions.keys()));
  savePaneState();
  renderPanes();
});

ipcRenderer.on("projects-updated", (_event, updated: Project[]) => {
  projects = updated;
  renderSidebar();
});

ipcRenderer.on("sessions-updated", (_event, updated: PersistedSession[], updatedRuntime: Record<string, SessionRuntime>) => {
  runtime = updatedRuntime ?? {};
  for (const ps of updated) {
    const existing = sessions.get(ps.id);
    if (!existing) {
      addSession(ps, false, false);
      continue;
    }
    existing.meta = ps;
    existing.name = ps.name;
    existing.config = ps.config;
    if (ps.status !== undefined && !existing.hasActivePty) existing.status = ps.status;
    const tabName = document.getElementById(`tab-${ps.id}`)?.querySelector(".tab-name");
    if (tabName) {
      tabName.textContent = ps.name;
      tabName.setAttribute("title", ps.name);
    }
  }
  renderSidebar();
  renderPanes(); // placeholder names and pane breadcrumbs
});

ipcRenderer.on("sync-warnings", (_event, warnings: string[]) => {
  syncWarnings = warnings ?? [];
  renderSidebar();
});

// Modal handling
const modal = document.getElementById("config-modal");
const projectSelect = document.getElementById("session-project") as HTMLSelectElement;
const directorySelect = document.getElementById("session-directory") as HTMLSelectElement;
const createProjectFirstLink = document.getElementById("create-project-first") as HTMLAnchorElement;
const directorySelectGroup = document.getElementById("directory-select-group");
const parentBranchSelect = document.getElementById("parent-branch") as HTMLSelectElement;
const codingAgentSelect = document.getElementById("coding-agent") as HTMLSelectElement;
const skipPermissionsCheckbox = document.getElementById("skip-permissions") as HTMLInputElement;
const skipPermissionsGroup = skipPermissionsCheckbox?.parentElement?.parentElement;
const sessionTypeSelect = document.getElementById("session-type") as HTMLSelectElement;
const parentBranchGroup = document.getElementById("parent-branch-group");
const branchNameGroup = document.getElementById("branch-name-group");
const worktreeDescription = document.getElementById("worktree-description");
const localDescription = document.getElementById("local-description");
const cancelBtn = document.getElementById("cancel-session");
const createBtn = document.getElementById("create-session") as HTMLButtonElement;
const branchNameInput = document.getElementById("branch-name") as HTMLInputElement;
const branchNameError = document.getElementById("branch-name-error");
const branchNameHelp = document.getElementById("branch-name-help");

let selectedDirectory = "";
let existingBranches: string[] = [];

// Validate branch name
function validateBranchName(): boolean {
  const branchName = branchNameInput?.value.trim();

  if (!branchName) {
    // Empty branch name is allowed (it's optional)
    branchNameError?.classList.add("hidden");
    branchNameHelp?.classList.remove("hidden");
    return true;
  }

  // Check if branch already exists
  const branchExists = existingBranches.some(branch =>
    branch === branchName || branch === `origin/${branchName}`
  );

  if (branchExists) {
    branchNameError?.classList.remove("hidden");
    branchNameHelp?.classList.add("hidden");
    return false;
  } else {
    branchNameError?.classList.add("hidden");
    branchNameHelp?.classList.remove("hidden");
    return true;
  }
}

// Add input event listener for branch name validation
branchNameInput?.addEventListener("input", () => {
  validateBranchName();
});

// Toggle skip permissions checkbox visibility based on coding agent
codingAgentSelect?.addEventListener("change", () => {
  if (codingAgentSelect.value === "claude") {
    skipPermissionsGroup?.classList.remove("hidden");
  } else {
    skipPermissionsGroup?.classList.add("hidden");
  }
});

// Toggle parent branch and branch name visibility based on session type
sessionTypeSelect?.addEventListener("change", () => {
  const isWorktree = sessionTypeSelect.value === SessionType.WORKTREE;
  if (isWorktree) {
    parentBranchGroup?.classList.remove("hidden");
    branchNameGroup?.classList.remove("hidden");
    worktreeDescription?.style.setProperty("display", "block");
    localDescription?.style.setProperty("display", "none");
  } else {
    parentBranchGroup?.classList.add("hidden");
    branchNameGroup?.classList.add("hidden");
    worktreeDescription?.style.setProperty("display", "none");
    localDescription?.style.setProperty("display", "block");
  }
});

// SESSIONS "+": same dialog with the standalone project preselected
document.getElementById("new-standalone-session")?.addEventListener("click", () => {
  openNewSessionDialog(STANDALONE_PROJECT_ID).catch(error => console.error("Failed to open the new session dialog:", error));
});

async function openNewSessionDialog(projectId?: string): Promise<void> {
  modal?.classList.remove("hidden");

  // Load last used settings
  const lastSettings = await ipcRenderer.invoke("get-last-settings");

  // Populate project and directory (default: first free directory)
  dialogIncludesStandalone = !!projectId && isStandaloneProject(projectId);
  await populateProjectSelect(projectId ?? lastSettings.projectId, lastSettings.parentBranch);

  // Set last used session type (default to worktree if not set).
  // The scratch folder is not a git repository, so standalone sessions start as local.
  if (projectId && isStandaloneProject(projectId)) {
    sessionTypeSelect.value = SessionType.LOCAL;
  } else if (lastSettings.sessionType) {
    sessionTypeSelect.value = lastSettings.sessionType;
  } else {
    sessionTypeSelect.value = SessionType.WORKTREE;
  }

  // Show/hide parent branch, branch name, and descriptions based on session type
  const isWorktree = sessionTypeSelect.value === SessionType.WORKTREE;
  if (isWorktree) {
    parentBranchGroup?.classList.remove("hidden");
    branchNameGroup?.classList.remove("hidden");
    worktreeDescription?.style.setProperty("display", "block");
    localDescription?.style.setProperty("display", "none");
  } else {
    parentBranchGroup?.classList.add("hidden");
    branchNameGroup?.classList.add("hidden");
    worktreeDescription?.style.setProperty("display", "none");
    localDescription?.style.setProperty("display", "block");
  }

  // Set last used coding agent
  if (lastSettings.codingAgent) {
    codingAgentSelect.value = lastSettings.codingAgent;
  }

  // Set last used skip permissions setting and visibility
  if (lastSettings.skipPermissions !== undefined) {
    skipPermissionsCheckbox.checked = lastSettings.skipPermissions;
  }

  // Set last used setup commands
  const setupCommandsTextarea = document.getElementById("setup-commands") as HTMLTextAreaElement;
  if (lastSettings.setupCommands && setupCommandsTextarea) {
    setupCommandsTextarea.value = lastSettings.setupCommands.join("\n");
  }

  // Show/hide skip permissions based on coding agent
  if (lastSettings.codingAgent === "codex") {
    skipPermissionsGroup?.classList.add("hidden");
  } else {
    skipPermissionsGroup?.classList.remove("hidden");
  }
}

// Guards against out-of-order dir-info responses
let dirInfoRequestSeq = 0;
// Occupancy per directory of the selected project; empty when unknown (get-dir-info failed)
let dirOccupancy = new Map<string, string>();

// Fill the Directory select from get-dir-info of the chosen project.
// Occupied dirs are disabled; default is the first free dir, else the first one.
async function loadDirectoryOptions(projectId: string, parentBranch?: string): Promise<void> {
  const seq = ++dirInfoRequestSeq;
  directorySelect.innerHTML = "";
  selectedDirectory = "";
  dirOccupancy = new Map();
  let infos: DirInfo[] = [];
  try {
    infos = projectId ? await ipcRenderer.invoke("get-dir-info", projectId) : [];
  } catch (error) {
    console.error("Failed to load directory info:", error);
  }
  if (seq !== dirInfoRequestSeq) return;
  infos.forEach(i => dirOccupancy.set(i.dir, i.occupancy.kind));

  infos.forEach(info => {
    const option = document.createElement("option");
    option.value = info.dir;
    const inUse = info.occupancy.kind !== "free";
    option.textContent = info.name + (inUse ? " (in use)" : "");
    option.title = info.dir;
    directorySelect.appendChild(option);
  });

  const firstFree = infos.find(i => i.occupancy.kind === "free") ?? infos[0];
  if (firstFree) {
    directorySelect.value = firstFree.dir;
    selectedDirectory = firstFree.dir;
    await loadAndPopulateBranches(firstFree.dir, parentBranch);
    if (seq !== dirInfoRequestSeq) return;
  } else {
    parentBranchSelect.innerHTML = '<option value="">No git repository found</option>';
    existingBranches = [];
  }
  validateBranchName();
}

// Fill the Project select from `projects` (standalone last); shows the empty-state link when there are none.
// The built-in "Others" project is only offered when the dialog was opened from the OTHERS section,
// so the PROJECTS "+" keeps its "Create a project first" state when no real project exists.
let dialogIncludesStandalone = false;

async function populateProjectSelect(preferredId?: string, parentBranch?: string): Promise<void> {
  projectSelect.innerHTML = "";
  const ordered = [
    ...projects.filter(p => !isStandaloneProject(p)),
    ...(dialogIncludesStandalone ? projects.filter(p => isStandaloneProject(p)) : []),
  ];
  ordered.forEach(p => {
    const option = document.createElement("option");
    option.value = p.id;
    option.textContent = isStandaloneProject(p) ? `${p.name} (no project)` : p.name;
    projectSelect.appendChild(option);
  });

  const hasProjects = ordered.length > 0;
  projectSelect.classList.toggle("hidden", !hasProjects);
  createProjectFirstLink.classList.toggle("hidden", hasProjects);
  directorySelectGroup?.classList.toggle("hidden", !hasProjects);

  if (!hasProjects) {
    await loadDirectoryOptions("");
    return;
  }
  projectSelect.value = ordered.some(p => p.id === preferredId) ? (preferredId as string) : ordered[0].id;
  await loadDirectoryOptions(projectSelect.value, parentBranch);
}

projectSelect?.addEventListener("change", async () => {
  try {
    await loadDirectoryOptions(projectSelect.value);
  } catch (error) {
    console.error(`Failed to load directories for project ${projectSelect.value}:`, error);
  }
});

directorySelect?.addEventListener("change", async () => {
  selectedDirectory = directorySelect.value;
  if (selectedDirectory) {
    const seq = ++dirInfoRequestSeq;
    try {
      await loadAndPopulateBranches(selectedDirectory);
    } catch (error) {
      console.error(`Failed to load branches for ${selectedDirectory}:`, error);
      return;
    }
    if (seq !== dirInfoRequestSeq) return;
    validateBranchName();
  }
});

createProjectFirstLink?.addEventListener("click", (e) => {
  e.preventDefault();
  openProjectModal();
});

// Cancel button
cancelBtn?.addEventListener("click", () => {
  modal?.classList.add("hidden");
  selectedDirectory = "";
  parentBranchSelect.innerHTML = '<option value="">Loading branches...</option>';
  branchNameInput.value = "";
  branchNameError?.classList.add("hidden");
  branchNameHelp?.classList.remove("hidden");
  existingBranches = [];
});

// Create session button
createBtn?.addEventListener("click", () => {
  if (!selectedDirectory) {
    showToast("Please select a project and directory", "warning");
    return;
  }

  const sessionType = sessionTypeSelect.value as SessionType;

  // Validate parent branch is selected for worktree sessions
  if (sessionType === SessionType.WORKTREE && !parentBranchSelect.value) {
    showToast("Please select a parent branch for worktree session", "warning");
    return;
  }

  // Validate branch name doesn't already exist for worktree sessions
  if (sessionType === SessionType.WORKTREE && !validateBranchName()) {
    showToast("Cannot create worktree: branch already exists", "warning");
    return;
  }

  const setupCommandsTextarea = document.getElementById("setup-commands") as HTMLTextAreaElement;
  const setupCommandsText = setupCommandsTextarea?.value.trim();
  const setupCommands = setupCommandsText
    ? setupCommandsText.split("\n").filter(cmd => cmd.trim())
    : undefined;

  const branchNameInput = document.getElementById("branch-name") as HTMLInputElement;
  const branchName = branchNameInput?.value.trim() || undefined;

  const config: SessionConfig = {
    projectDir: selectedDirectory,
    sessionType,
    parentBranch: sessionType === SessionType.WORKTREE ? parentBranchSelect.value : undefined,
    branchName,
    codingAgent: codingAgentSelect.value,
    skipPermissions: codingAgentSelect.value === "claude" ? skipPermissionsCheckbox.checked : false,
    setupCommands,
  };

  // Show loading state
  if (createBtn) {
    createBtn.disabled = true;
    createBtn.innerHTML = '<span class="loading-spinner"></span> Creating...';
    createBtn.classList.add("loading");
  }

  // Save settings for next time
  // projectId travels beside the config (main strips it before persisting the session config)
  const request = {...config, projectId: projectSelect.value || undefined};
  ipcRenderer.send("save-settings", request);

  // Create the session
  ipcRenderer.send("create-session", request);
});

// Project modal
const projectModal = document.getElementById("project-modal");
const projectModalTitle = document.getElementById("project-modal-title");
const projectNameInput = document.getElementById("project-name") as HTMLInputElement;
const projectDirListEl = document.getElementById("project-dir-list");
const projectParentInput = document.getElementById("project-parent") as HTMLInputElement;
const projectPrefixInput = document.getElementById("project-prefix") as HTMLInputElement;
const projectScanResults = document.getElementById("project-scan-results");
const projectAddSelectedBtn = document.getElementById("project-add-selected");
const projectErrorEl = document.getElementById("project-error");
const projectSaveBtn = document.getElementById("project-save") as HTMLButtonElement;

const projectNameGroup = document.getElementById("project-name-group");
let editingProjectId = "";
let projectDraftDirs: string[] = [];

function showProjectError(message: string) {
  if (!projectErrorEl) return;
  projectErrorEl.textContent = message;
  projectErrorEl.classList.toggle("hidden", !message);
}

function renderProjectDirs() {
  if (!projectDirListEl) return;
  projectDirListEl.innerHTML = projectDraftDirs.map((dir, i) => `
    <div class="project-dir-row">
      <span title="${escapeHtml(dir)}">${escapeHtml(dir)}</span>
      <button class="project-dir-remove" data-index="${i}" title="Remove">×</button>
    </div>
  `).join("");
  projectDirListEl.querySelectorAll(".project-dir-remove").forEach(btn => {
    btn.addEventListener("click", () => {
      projectDraftDirs.splice(Number((btn as HTMLElement).dataset.index), 1);
      renderProjectDirs();
    });
  });
}

function clearScanResults() {
  if (projectScanResults) {
    projectScanResults.innerHTML = "";
    projectScanResults.classList.add("hidden");
  }
  projectAddSelectedBtn?.classList.add("hidden");
}

function openProjectModal(project?: Project): void {
  editingProjectId = project?.id ?? "";
  projectDraftDirs = project ? [...project.dirs] : [];
  const standalone = isStandaloneProject(project);
  if (projectModalTitle) {
    projectModalTitle.textContent = standalone ? "Session Directories" : project ? "Edit Project" : "New Project";
  }
  // The built-in project's name is fixed; main keeps it and re-adds the scratch folder if no directory is left.
  projectNameGroup?.classList.toggle("hidden", standalone);
  projectNameInput.value = project?.name ?? "";
  projectParentInput.value = "";
  projectPrefixInput.value = "";
  projectSaveBtn.disabled = false;
  showProjectError("");
  clearScanResults();
  renderProjectDirs();
  projectModal?.classList.remove("hidden");
}

function closeProjectModal() {
  projectModal?.classList.add("hidden");
}

document.getElementById("new-project")?.addEventListener("click", () => openProjectModal());

// SESSIONS section header ⋯ menu
const standaloneMenu = document.getElementById("standalone-menu");
document.getElementById("standalone-menu-btn")?.addEventListener("click", (e) => {
  e.stopPropagation();
  document.querySelectorAll(".session-menu").forEach(m => {
    if (m !== standaloneMenu) m.classList.add("hidden");
  });
  standaloneMenu?.classList.toggle("hidden");
});
document.getElementById("standalone-edit-dirs")?.addEventListener("click", (e) => {
  e.stopPropagation();
  standaloneMenu?.classList.add("hidden");
  const standalone = projects.find(p => isStandaloneProject(p));
  if (!standalone) {
    showToast("Standalone sessions are not loaded yet", "warning");
    return;
  }
  openProjectModal(standalone);
});
document.getElementById("project-cancel")?.addEventListener("click", closeProjectModal);

document.getElementById("project-add-folder")?.addEventListener("click", async () => {
  try {
    const dir = await ipcRenderer.invoke("select-directory");
    if (dir && !projectDraftDirs.includes(dir)) {
      projectDraftDirs.push(dir);
      renderProjectDirs();
    }
  } catch (error) {
    showProjectError(`Could not select folder: ${error instanceof Error ? error.message : String(error)}`);
  }
});

document.getElementById("project-parent-browse")?.addEventListener("click", async () => {
  try {
    const dir = await ipcRenderer.invoke("select-directory");
    if (dir) {
      projectParentInput.value = dir;
      clearScanResults();
    }
  } catch (error) {
    showProjectError(`Could not select folder: ${error instanceof Error ? error.message : String(error)}`);
  }
});

document.getElementById("project-scan")?.addEventListener("click", async () => {
  if (!projectScanResults) return;
  const parent = projectParentInput.value.trim();
  const prefix = projectPrefixInput.value.trim();
  showProjectError("");
  clearScanResults();
  if (!parent) {
    showProjectError("Select a parent folder first");
    return;
  }
  projectScanResults.classList.remove("hidden");
  let found: string[] = [];
  try {
    found = await ipcRenderer.invoke("scan-parent-dir", parent, prefix);
  } catch (error) {
    projectScanResults.innerHTML = `<div class="text-xs text-gray-500">${escapeHtml(`Scan failed: ${error instanceof Error ? error.message : String(error)}`)}</div>`;
    return;
  }
  if (!found || found.length === 0) {
    projectScanResults.innerHTML = '<div class="text-xs text-gray-500">No git repositories found</div>';
    return;
  }
  projectScanResults.innerHTML = found.map(dir => {
    const present = projectDraftDirs.includes(dir);
    return `<label class="${present ? "muted" : ""}">
      <input type="checkbox" class="form-checkbox scan-item" value="${escapeHtml(dir)}" checked ${present ? "disabled" : ""} />
      <span class="truncate" title="${escapeHtml(dir)}">${escapeHtml(path.basename(dir))}${present ? " (already added)" : ""}</span>
    </label>`;
  }).join("");
  projectAddSelectedBtn?.classList.remove("hidden");
});

projectAddSelectedBtn?.addEventListener("click", () => {
  projectScanResults?.querySelectorAll<HTMLInputElement>("input.scan-item:checked:not(:disabled)").forEach(cb => {
    if (!projectDraftDirs.includes(cb.value)) projectDraftDirs.push(cb.value);
  });
  renderProjectDirs();
  clearScanResults();
});

projectSaveBtn?.addEventListener("click", async () => {
  const name = isStandaloneProject(editingProjectId) ? STANDALONE_PROJECT_NAME : projectNameInput.value.trim();
  if (!name) {
    showProjectError("Project name is required");
    return;
  }
  showProjectError("");
  projectSaveBtn.disabled = true;
  const previousIds = new Set(projects.map(p => p.id));
  try {
    const result = await ipcRenderer.invoke("save-project", {id: editingProjectId, name, dirs: projectDraftDirs});
    if (!result?.ok) {
      showProjectError(result?.error || "Could not save project");
      return;
    }
    projects = await ipcRenderer.invoke("get-projects");
    renderSidebar();
    closeProjectModal();
    // Refresh the new-session dialog's project list when it is open
    if (modal && !modal.classList.contains("hidden")) {
      const saved = editingProjectId
        ? projects.find(p => p.id === editingProjectId)
        : projects.find(p => !previousIds.has(p.id));
      await populateProjectSelect(saved?.id ?? projectSelect.value);
    }
  } catch (error) {
    showProjectError(`Could not save project: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    projectSaveBtn.disabled = false;
  }
});

// MCP Server management functions
async function loadMcpServers() {
  // Only load MCP servers if there's an active session
  if (!activeSessionId) {
    return;
  }

  try {
    await ipcRenderer.invoke("list-mcp-servers", activeSessionId);
    // Results will come via mcp-servers-updated event
  } catch (error) {
    console.error("Failed to load MCP servers:", error);
  }
}

// Force immediate refresh of MCP servers after add/remove operations
async function refreshMcpServers() {
  if (!activeSessionId) {
    return;
  }

  // Show loading state on add button
  const addMcpServerBtn = document.getElementById("add-mcp-server");
  if (addMcpServerBtn) {
    addMcpServerBtn.innerHTML = '<span class="loading-spinner"></span>';
    addMcpServerBtn.classList.add("pointer-events-none");
  }

  try {
    // Trigger MCP list command
    await ipcRenderer.invoke("list-mcp-servers", activeSessionId);
    // Wait a bit for the poller to process and send results
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (error) {
    console.error("Failed to refresh MCP servers:", error);
  } finally {
    // Restore add button will happen via mcp-servers-updated event
  }
}

function renderMcpServers() {
  const list = document.getElementById("mcp-server-list");
  if (!list) return;

  list.innerHTML = "";

  mcpServers.forEach(server => {
    const item = document.createElement("div");
    item.className = "session-list-item";
    const indicatorClass = server.connected ? "active" : "disconnected";
    item.innerHTML = `
      <div class="flex items-center space-x-2 flex-1">
        <span class="session-indicator ${indicatorClass}"></span>
        <span class="truncate">${escapeHtml(server.name)}</span>
      </div>
      <button class="session-delete-btn mcp-remove-btn" data-name="${escapeHtml(server.name)}" title="Remove server">×</button>
    `;

    // Click to show details
    item.addEventListener("click", async (e) => {
      const target = e.target as HTMLElement;
      if (!target.classList.contains("mcp-remove-btn")) {
        await showMcpServerDetails(server.name);
      }
    });

    const removeBtn = item.querySelector(".mcp-remove-btn");
    removeBtn?.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (confirm(`Remove MCP server "${server.name}"?`)) {
        // Optimistically remove from UI
        mcpServers = mcpServers.filter(s => s.name !== server.name);
        renderMcpServers();

        try {
          await ipcRenderer.invoke("remove-mcp-server", server.name);
        } catch (error) {
          showToast(`Failed to remove server: ${error}`, "error");
          // Refresh to restore correct state on error
          await refreshMcpServers();
        }
      }
    });

    list.appendChild(item);
  });
}

async function showMcpServerDetails(name: string) {
  const detailsModal = document.getElementById("mcp-details-modal");
  const detailsTitle = document.getElementById("mcp-details-title");
  const detailsContent = document.getElementById("mcp-details-content");

  // Show modal immediately with loading state
  if (detailsTitle) {
    detailsTitle.textContent = name;
  }

  if (detailsContent) {
    detailsContent.innerHTML = '<div class="flex items-center justify-center py-8"><span class="loading-spinner" style="width: 24px; height: 24px; border-width: 3px;"></span></div>';
  }

  detailsModal?.classList.remove("hidden");

  try {
    const details = await ipcRenderer.invoke("get-mcp-server-details", name);

    if (detailsContent) {
      let html = "";
      if (details.scope) {
        html += `<div><strong>Scope:</strong> ${details.scope}</div>`;
      }
      if (details.status) {
        html += `<div><strong>Status:</strong> ${details.status}</div>`;
      }
      if (details.type) {
        html += `<div><strong>Type:</strong> ${details.type}</div>`;
      }
      if (details.url) {
        html += `<div><strong>URL:</strong> ${details.url}</div>`;
      }
      if (details.command) {
        html += `<div><strong>Command:</strong> ${details.command}</div>`;
      }
      if (details.args) {
        html += `<div><strong>Args:</strong> ${details.args}</div>`;
      }

      detailsContent.innerHTML = html;
    }

    // Store current server name for remove button
    const removeMcpDetailsBtn = document.getElementById("remove-mcp-details") as HTMLButtonElement;
    if (removeMcpDetailsBtn) {
      removeMcpDetailsBtn.dataset.serverName = name;
    }
  } catch (error) {
    console.error("Failed to get server details:", error);
    if (detailsContent) {
      detailsContent.innerHTML = `<div class="text-red-400">Failed to load server details</div>`;
    }
  }
}

// MCP Modal handling
const mcpModal = document.getElementById("mcp-modal");
const mcpNameInput = document.getElementById("mcp-name") as HTMLInputElement;
const mcpTypeSelect = document.getElementById("mcp-type") as HTMLSelectElement;
const mcpCommandInput = document.getElementById("mcp-command") as HTMLInputElement;
const mcpArgsInput = document.getElementById("mcp-args") as HTMLInputElement;
const mcpEnvInput = document.getElementById("mcp-env") as HTMLTextAreaElement;
const mcpUrlInput = document.getElementById("mcp-url") as HTMLInputElement;
const mcpHeadersInput = document.getElementById("mcp-headers") as HTMLTextAreaElement;
const mcpAlwaysAllowInput = document.getElementById("mcp-always-allow") as HTMLInputElement;
const localFields = document.getElementById("local-fields");
const remoteFields = document.getElementById("remote-fields");
const cancelMcpBtn = document.getElementById("cancel-mcp");
const addMcpBtn = document.getElementById("add-mcp") as HTMLButtonElement;

// Toggle fields based on server type
mcpTypeSelect?.addEventListener("change", () => {
  if (mcpTypeSelect.value === "local") {
    localFields!.style.display = "block";
    remoteFields!.style.display = "none";
  } else {
    localFields!.style.display = "none";
    remoteFields!.style.display = "block";
  }
});

// Add MCP server button - opens modal
document.getElementById("add-mcp-server")?.addEventListener("click", () => {
  mcpModal?.classList.remove("hidden");
  mcpNameInput.value = "";
  mcpTypeSelect.value = "local";
  mcpCommandInput.value = "";
  mcpArgsInput.value = "";
  mcpEnvInput.value = "";
  mcpUrlInput.value = "";
  mcpHeadersInput.value = "";
  mcpAlwaysAllowInput.value = "";
  localFields!.style.display = "block";
  remoteFields!.style.display = "none";
});

// Cancel MCP button
cancelMcpBtn?.addEventListener("click", () => {
  mcpModal?.classList.add("hidden");
});

// Add MCP button
addMcpBtn?.addEventListener("click", async () => {
  const name = mcpNameInput.value.trim();
  const serverType = mcpTypeSelect.value;

  if (!name) {
    showToast("Please enter a server name", "warning");
    return;
  }

  const config: any = {};

  if (serverType === "local") {
    config.type = "stdio";

    const command = mcpCommandInput.value.trim();
    const argsInput = mcpArgsInput.value.trim();

    if (!command) {
      showToast("Please enter a command", "warning");
      return;
    }

    config.command = command;
    if (argsInput) {
      config.args = argsInput.split(" ").filter(a => a.trim());
    }

    // Parse environment variables if provided
    const envInput = mcpEnvInput.value.trim();
    if (envInput) {
      try {
        config.env = JSON.parse(envInput);
      } catch (error) {
        showToast("Invalid JSON for environment variables", "warning");
        return;
      }
    }
  } else {
    // Remote server
    config.type = "sse";

    const url = mcpUrlInput.value.trim();

    if (!url) {
      showToast("Please enter a server URL", "warning");
      return;
    }

    config.url = url;

    // Parse headers if provided
    const headersInput = mcpHeadersInput.value.trim();
    if (headersInput) {
      try {
        config.headers = JSON.parse(headersInput);
      } catch (error) {
        showToast("Invalid JSON for headers", "warning");
        return;
      }
    }
  }

  // Parse always allow tools
  const alwaysAllowInput = mcpAlwaysAllowInput.value.trim();
  if (alwaysAllowInput) {
    config.alwaysAllow = alwaysAllowInput.split(",").map(t => t.trim()).filter(t => t);
  }

  // Show loading state
  const originalText = addMcpBtn.innerHTML;
  addMcpBtn.innerHTML = '<span class="loading-spinner"></span> Adding...';
  addMcpBtn.disabled = true;
  addMcpBtn.classList.add("opacity-50", "cursor-not-allowed");

  try {
    await ipcRenderer.invoke("add-mcp-server", name, config);
    mcpModal?.classList.add("hidden");
    // Force immediate refresh of MCP servers
    await refreshMcpServers();
  } catch (error) {
    console.error("Error adding server:", error);
    showToast(`Failed to add server: ${error}`, "error");
  } finally {
    // Reset button state
    addMcpBtn.innerHTML = originalText;
    addMcpBtn.disabled = false;
    addMcpBtn.classList.remove("opacity-50", "cursor-not-allowed");
  }
});

// MCP Details Modal handling
const closeMcpDetailsBtn = document.getElementById("close-mcp-details");
const removeMcpDetailsBtn = document.getElementById("remove-mcp-details") as HTMLButtonElement;
const mcpDetailsModal = document.getElementById("mcp-details-modal");

closeMcpDetailsBtn?.addEventListener("click", () => {
  mcpDetailsModal?.classList.add("hidden");
});

removeMcpDetailsBtn?.addEventListener("click", async () => {
  const serverName = removeMcpDetailsBtn.dataset.serverName;
  if (!serverName) return;

  if (confirm(`Remove MCP server "${serverName}"?`)) {
    // Close modal immediately
    mcpDetailsModal?.classList.add("hidden");

    // Optimistically remove from UI
    mcpServers = mcpServers.filter(s => s.name !== serverName);
    renderMcpServers();

    try {
      await ipcRenderer.invoke("remove-mcp-server", serverName);
    } catch (error) {
      showToast(`Failed to remove server: ${error}`, "error");
      // Refresh to restore correct state on error
      await refreshMcpServers();
    }
  }
});

// Listen for MCP polling started event
ipcRenderer.on("mcp-polling-started", (_event, sessionId: string) => {
  if (sessionId === activeSessionId) {
    const addMcpServerBtn = document.getElementById("add-mcp-server");
    if (addMcpServerBtn) {
      addMcpServerBtn.innerHTML = '<span class="loading-spinner"></span>';
      addMcpServerBtn.classList.add("pointer-events-none");
    }
  }
});

// Listen for MCP server updates from main process
ipcRenderer.on("mcp-servers-updated", (_event, sessionId: string, servers: McpServer[]) => {
  // Any finished poll ends the spinner, even if the focus moved to another session meanwhile
  const addMcpServerBtn = document.getElementById("add-mcp-server");
  if (addMcpServerBtn) {
    addMcpServerBtn.innerHTML = '+';
    addMcpServerBtn.classList.remove("pointer-events-none");
  }
  // The list itself is only shown for the active session
  if (sessionId === activeSessionId) {
    mcpServers = servers;
    renderMcpServers();
  }
});

// Settings Modal handling
const settingsModal = document.getElementById("settings-modal");
const openSettingsBtn = document.getElementById("open-settings");
const cancelSettingsBtn = document.getElementById("cancel-settings");
const resetSettingsBtn = document.getElementById("reset-settings");
const saveSettingsBtn = document.getElementById("save-settings");

const settingsTheme = document.getElementById("settings-theme") as HTMLSelectElement;
const settingsFontFamily = document.getElementById("settings-font-family") as HTMLSelectElement;
const settingsFontSize = document.getElementById("settings-font-size") as HTMLInputElement;
const settingsCursorBlink = document.getElementById("settings-cursor-blink") as HTMLInputElement;
const settingsWorktreeDir = document.getElementById("settings-worktree-dir") as HTMLInputElement;
const browseWorktreeDirBtn = document.getElementById("browse-worktree-dir");

// Load saved settings on startup
async function loadSettings() {
  const savedSettings = await ipcRenderer.invoke("get-terminal-settings");
  if (savedSettings) {
    terminalSettings = { ...DEFAULT_SETTINGS, ...savedSettings };
  }
}

// Populate settings form
function populateSettingsForm() {
  // Set theme
  settingsTheme.value = terminalSettings.theme;

  // Set font family - match against dropdown options
  const fontOptions = Array.from(settingsFontFamily.options);
  const matchingOption = fontOptions.find(opt => opt.value === terminalSettings.fontFamily);
  if (matchingOption) {
    settingsFontFamily.value = matchingOption.value;
  } else {
    // Default to first option (Menlo) if no match
    settingsFontFamily.selectedIndex = 0;
  }

  settingsFontSize.value = terminalSettings.fontSize.toString();
  settingsCursorBlink.checked = terminalSettings.cursorBlink;
  settingsWorktreeDir.value = terminalSettings.worktreeDir;
}

// Apply settings to all existing terminals
function applySettingsToAllTerminals() {
  const themeColors = THEME_PRESETS[terminalSettings.theme] || THEME_PRESETS["macos-dark"];

  sessions.forEach((session) => {
    if (session.terminal) {
      session.terminal.options.fontFamily = terminalSettings.fontFamily;
      session.terminal.options.fontSize = terminalSettings.fontSize;
      session.terminal.options.cursorBlink = terminalSettings.cursorBlink;
      session.terminal.options.theme = themeColors;

      // Refresh terminal to apply changes
      if (session.fitAddon) {
        session.fitAddon.fit();
      }
    }
  });
  refitVisibleTerminals();
}

// Open settings modal
openSettingsBtn?.addEventListener("click", async () => {
  populateSettingsForm();

  // Load and display app version
  const version = await ipcRenderer.invoke("get-app-version");
  const versionElement = document.getElementById("app-version");
  if (versionElement) {
    versionElement.textContent = `Agentyard v${version}`;
  }

  settingsModal?.classList.remove("hidden");
});

// Cancel settings
cancelSettingsBtn?.addEventListener("click", () => {
  settingsModal?.classList.add("hidden");
});

// Reset settings to default
resetSettingsBtn?.addEventListener("click", () => {
  terminalSettings = { ...DEFAULT_SETTINGS };
  populateSettingsForm();
});

// Browse worktree directory
browseWorktreeDirBtn?.addEventListener("click", async () => {
  const dir = await ipcRenderer.invoke("select-directory");
  if (dir) {
    settingsWorktreeDir.value = dir;
  }
});

// Save settings
saveSettingsBtn?.addEventListener("click", async () => {
  // Read values from form
  terminalSettings.theme = settingsTheme.value;
  terminalSettings.fontFamily = settingsFontFamily.value || DEFAULT_SETTINGS.fontFamily;
  terminalSettings.fontSize = parseInt(settingsFontSize.value) || DEFAULT_SETTINGS.fontSize;
  terminalSettings.cursorBlink = settingsCursorBlink.checked;
  terminalSettings.worktreeDir = settingsWorktreeDir.value || DEFAULT_SETTINGS.worktreeDir;

  // Save to electron-store
  await ipcRenderer.invoke("save-terminal-settings", terminalSettings);

  // Apply to all existing terminals
  applySettingsToAllTerminals();

  // Close modal
  settingsModal?.classList.add("hidden");
});

// Load settings on startup
loadSettings();

// Apply to Project Modal
const applyToProjectModal = document.getElementById("apply-to-project-modal");
const cancelApplyToProjectBtn = document.getElementById("cancel-apply-to-project");
const confirmApplyToProjectBtn = document.getElementById("confirm-apply-to-project");

cancelApplyToProjectBtn?.addEventListener("click", () => {
  applyToProjectModal?.classList.add("hidden");
});

confirmApplyToProjectBtn?.addEventListener("click", async () => {
  const sessionId = applyToProjectModal?.getAttribute("data-session-id");
  if (!sessionId) return;

  // Disable button during operation
  if (confirmApplyToProjectBtn) {
    confirmApplyToProjectBtn.textContent = "Applying...";
    confirmApplyToProjectBtn.setAttribute("disabled", "true");
  }

  try {
    const result = await ipcRenderer.invoke("apply-session-to-project", sessionId);

    if (result.success) {
      showToast(`Changes applied successfully to project directory.`, "success");
      applyToProjectModal?.classList.add("hidden");
    } else {
      showToast(`Failed to apply changes: ${result.error}`, "error");
    }
  } catch (error) {
    showToast(`Error applying changes: ${error}`, "error");
  } finally {
    // Re-enable button
    if (confirmApplyToProjectBtn) {
      confirmApplyToProjectBtn.textContent = "Apply Changes";
      confirmApplyToProjectBtn.removeAttribute("disabled");
    }
  }
});

// Sidebar show/hide (button at the left of the tab row, Ctrl+Shift+B); remembered per viewer.
// Ctrl+B is left to the terminal: Claude Code uses it to background a running command.
const SIDEBAR_HIDDEN_KEY = "sidebarHidden";

function setSidebarHidden(hidden: boolean) {
  document.body.classList.toggle("sidebar-hidden", hidden);
  document.getElementById("toggle-sidebar")?.classList.toggle("active", !hidden);
  try {
    localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? "1" : "0");
  } catch (error) {
    console.error("Error saving sidebar visibility:", error);
  }
  window.dispatchEvent(new Event("resize")); // refit the terminals to the new width
}

(function initSidebarToggle() {
  let hidden = false;
  try {
    hidden = localStorage.getItem(SIDEBAR_HIDDEN_KEY) === "1";
  } catch (error) {
    console.error("Error restoring sidebar visibility:", error);
  }
  setSidebarHidden(hidden);
  document.getElementById("toggle-sidebar")?.addEventListener("click", () => {
    setSidebarHidden(!document.body.classList.contains("sidebar-hidden"));
  });
  // Capture phase, so the shortcut works while a terminal has focus
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.code === "KeyB") {
      e.preventDefault();
      e.stopPropagation();
      setSidebarHidden(!document.body.classList.contains("sidebar-hidden"));
    }
  }, true);
})();

// Resizable sidebar (VSCode-like): drag the handle, double-click to reset; width is remembered
const SIDEBAR_DEFAULT_WIDTH = 256;
const SIDEBAR_MIN_WIDTH = 180;
const SIDEBAR_MAX_WIDTH = 640;
const SIDEBAR_WIDTH_KEY = "sidebarWidth";

function applySidebarWidth(width: number): number {
  const sidebar = document.querySelector(".sidebar") as HTMLElement | null;
  const clamped = Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
  if (sidebar) sidebar.style.width = `${clamped}px`;
  return clamped;
}

(function initSidebarResizer() {
  const resizer = document.getElementById("sidebar-resizer");
  if (!resizer) return;

  try {
    const saved = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (saved) applySidebarWidth(saved);
  } catch (error) {
    console.error("Error restoring sidebar width:", error);
  }

  let resizeFrame = 0;
  const refitTerminal = () => {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
      resizeFrame = 0;
      window.dispatchEvent(new Event("resize"));
    });
  };

  const saveWidth = (width: number) => {
    try {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width));
    } catch (error) {
      console.error("Error saving sidebar width:", error);
    }
  };

  resizer.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const sidebar = document.querySelector(".sidebar") as HTMLElement | null;
    if (!sidebar) return;
    const startX = e.clientX;
    const startWidth = sidebar.getBoundingClientRect().width;
    let width = startWidth;

    resizer.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      width = applySidebarWidth(startWidth + ev.clientX - startX);
      refitTerminal();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      resizer.classList.remove("dragging");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      saveWidth(width);
      refitTerminal();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  resizer.addEventListener("dblclick", () => {
    saveWidth(applySidebarWidth(SIDEBAR_DEFAULT_WIDTH));
    refitTerminal();
  });
})();

// Close session menus when clicking outside
document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  if (!target.closest(".session-menu") && !target.classList.contains("session-menu-btn")) {
    document.querySelectorAll(".session-menu").forEach(menu => {
      menu.classList.add("hidden");
    });
  }
  if (sidebarRenderPending) renderSidebar();
});
