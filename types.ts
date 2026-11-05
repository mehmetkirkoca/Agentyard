export enum SessionType {
  WORKTREE = "worktree",
  LOCAL = "local"
}

export interface SessionConfig {
  projectDir: string;
  sessionType: SessionType;
  parentBranch?: string;
  branchName?: string;
  codingAgent: string;
  skipPermissions: boolean;
  setupCommands?: string[];
}

export interface Project {
  id: string;
  name: string;
  dirs: string[];
}

export enum SessionStatus {
  RUNNING = "running",
  WAITING = "waiting",
  DONE = "done",
  IDLE = "idle"
}

// "fleetcode": stored by sessions created before the rename to Agentyard
export type SessionOrigin = "agentyard" | "fleetcode" | "imported";

export interface PersistedSession {
  id: string;
  number: number;
  name: string;
  config: SessionConfig;
  worktreePath?: string;
  createdAt: number;
  sessionUuid: string;
  mcpConfigPath?: string;
  gitBranch?: string;
  projectId?: string;
  origin?: SessionOrigin;
  manualName?: boolean;
  lastActivity?: number;
  status?: SessionStatus;
  linkedDir?: string;
  /** a fork's source conversation; used until the fork's own transcript exists */
  forkedFrom?: string;
  /** Antigravity: agy's own conversation id, learned from its first hook event */
  agentConversationId?: string;
  /** Antigravity fork: how many prompts the original (forkedFrom) had when forked */
  forkedPromptCount?: number;
  /** Listed under the group's "Archive" until unarchived by hand, even while it runs */
  archived?: boolean;
  /** Claude: what the session is about now, read from its transcript (hover card, sidebar filter) */
  lastPrompt?: string;
  lastSummary?: string;
  lastSummaryAt?: number;
}

export interface SessionRuntime {
  externallyOpen: boolean;
}
