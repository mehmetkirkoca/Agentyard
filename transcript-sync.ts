import * as fs from "fs";
import * as path from "path";
import { claudeProjectFolder, encodeProjectDir } from "./claude-paths";
import { adoptSidecar, adoptTranscript, inspectTranscript, relinkTranscript } from "./link-store";
import { ClaudeProcess } from "./process-scan";
import { computeDirOccupancy } from "./project-model";
import { readTranscriptMeta, resolveSessionTitle, TranscriptMeta } from "./transcript-meta";
import { PersistedSession, Project, SessionType } from "./types";

/**
 * A real transcript modified more recently than this is never adopted: it may
 * still be written by a process the scan failed to detect.
 */
export const ADOPT_MIN_AGE_MS = 120_000;

const TRANSCRIPT_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export interface SyncInput {
  projects: Project[];
  sessions: PersistedSession[];
  hidden: Set<string>;
  /** sessionUuids of Agentyard sessions whose PTY is open */
  openUuids: Set<string>;
  external: ClaudeProcess[];
  /** kept by the caller across ticks; updated in place */
  index: Map<string, TranscriptMeta>;
  centralDir: string;
  home: string;
  nextNumber: () => number;
  /** clock for the adoption age check; defaults to Date.now() */
  now?: number;
}

export interface SyncResult {
  sessions: PersistedSession[];
  changed: boolean;
  externallyOpen: Set<string>;
  warnings: string[];
  /** true when the whole tick aborted; externallyOpen is then meaningless */
  failed?: boolean;
}

interface Entry {
  /** lower-cased uuid: the identity used for every comparison */
  uuid: string;
  /** uuid as spelled on disk: used for every filesystem path */
  name: string;
  folder: string;
  file: string;
  dir: string;
  projectId: string;
  real: boolean;
  /** mtime of the transcript (symlinks followed); undefined when unreadable */
  mtimeMs?: number;
}

function isSameOrInside(child: string, parent: string): boolean {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function lowerSet(values: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const v of values) out.add(v.toLowerCase());
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function existsNoFollow(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Whether `p` is a real directory (not a symlink to one). */
function isRealDir(p: string): boolean {
  try {
    return fs.lstatSync(p).isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/** Newest mtime of a path and, for a real directory, everything below it (symlinks not followed). */
function newestMtime(p: string): number {
  const st = fs.lstatSync(p);
  let newest = st.mtimeMs;
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(p)) newest = Math.max(newest, newestMtime(path.join(p, name)));
  }
  return newest;
}

/** List the <uuid>.jsonl entries (real files and symlinks) of one Claude project folder. */
function scanFolder(folder: string, dir: string, projectId: string, warnings: string[]): Entry[] {
  let names: string[];
  try {
    names = fs.readdirSync(folder).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(`failed to read ${folder}: ${errMsg(err)}`);
    }
    return [];
  }

  const entries: Entry[] = [];
  for (const name of names) {
    const match = TRANSCRIPT_RE.exec(name);
    if (!match) continue;
    const uuid = match[1].toLowerCase();
    const file = path.join(folder, name);
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() && !st.isSymbolicLink()) continue;
      let mtimeMs: number | undefined;
      try {
        mtimeMs = fs.statSync(file).mtimeMs;
      } catch {
        // dangling link: reported when its metadata is read
      }
      entries.push({uuid, name: match[1], folder, file, dir, projectId, real: st.isFile(), mtimeMs});
    } catch (err) {
      warnings.push(`failed to inspect ${uuid} in ${folder}: ${errMsg(err)}`);
    }
  }
  return entries;
}

function newSession(entry: Entry, meta: TranscriptMeta, number: number): PersistedSession {
  return {
    id: `session-${entry.uuid}`,
    number,
    name: resolveSessionTitle(meta) ?? `Session ${number}`,
    config: {
      projectDir: entry.dir,
      sessionType: SessionType.LOCAL,
      codingAgent: "claude",
      skipPermissions: false,
    },
    createdAt: meta.mtimeMs,
    sessionUuid: entry.uuid,
    projectId: entry.projectId,
    origin: "imported",
    manualName: false,
    lastActivity: meta.mtimeMs,
    linkedDir: entry.dir,
    lastPrompt: meta.lastPrompt,
    lastSummary: meta.lastSummary,
    lastSummaryAt: meta.lastSummaryAt,
  };
}

/** Returns an updated copy, or null when nothing changed. */
function updateSession(session: PersistedSession, meta: TranscriptMeta): PersistedSession | null {
  const next: PersistedSession = {...session};
  let changed = false;
  // Legacy sessions have no flag and may carry a user-chosen name: only an explicit false is automatic.
  if (session.manualName === false) {
    const title = resolveSessionTitle(meta);
    if (title !== undefined && title !== session.name) {
      next.name = title;
      changed = true;
    }
  }
  const lastActivity = Math.max(session.lastActivity ?? 0, meta.mtimeMs);
  if (lastActivity !== session.lastActivity) {
    next.lastActivity = lastActivity;
    changed = true;
  }
  if (meta.lastPrompt !== session.lastPrompt) {
    next.lastPrompt = meta.lastPrompt;
    changed = true;
  }
  if (meta.lastSummary !== session.lastSummary || meta.lastSummaryAt !== session.lastSummaryAt) {
    next.lastSummary = meta.lastSummary;
    next.lastSummaryAt = meta.lastSummaryAt;
    changed = true;
  }
  return changed ? next : null;
}

/**
 * One sync pass over the Claude transcript folders of every project directory:
 * import unknown transcripts as sessions, refresh titles and activity, and move
 * closed real transcripts into the central store. Never throws; problems are
 * returned in `warnings`.
 *
 * Known residual risks:
 * - Claude processes running inside Agentyard PTYs are invisible to the process
 *   scan; they are protected only through `openUuids`.
 * - A process's argv uuid can be stale (e.g. after switching conversations with
 *   /resume), so the transcript it actually writes may not be the one marked.
 * - On EXDEV, adoption copies the transcript synchronously on the main thread;
 *   writes made during the copy would be lost (mitigated by ADOPT_MIN_AGE_MS).
 */
export function runSyncTick(input: SyncInput): SyncResult {
  const warnings: string[] = [];
  try {
    return syncTick(input, warnings);
  } catch (err) {
    warnings.push(`sync tick failed: ${errMsg(err)}`);
    return {sessions: input.sessions, changed: false, externallyOpen: new Set(), warnings, failed: true};
  }
}

function syncTick(input: SyncInput, warnings: string[]): SyncResult {
  const now = input.now ?? Date.now();
  const sessions = [...input.sessions];
  let changed = false;

  const hidden = lowerSet(input.hidden);
  const openUuids = lowerSet(input.openUuids);

  // 1. Scan every project directory's folder once.
  const all: Entry[] = [];
  const folders = new Map<string, {dir: string; entries: Entry[]}>();
  for (const project of input.projects) {
    for (const dir of project.dirs) {
      const folder = path.resolve(claudeProjectFolder(dir, input.home));
      if (folders.has(folder)) continue;
      const entries = scanFolder(folder, dir, project.id, warnings);
      folders.set(folder, {dir, entries});
      all.push(...entries);
    }
  }

  // 2. Externally open. A process whose uuid is known marks exactly that uuid.
  // A folder whose directory runs uuid-less Claude processes is locked: nothing
  // in it is adopted this tick. For display, its K newest transcripts (real files
  // or links; K = number of such processes, ties at the cutoff included) are
  // marked open.
  const externallyOpen = new Set<string>();
  const anonymous: ClaudeProcess[] = [];
  for (const proc of input.external) {
    if (proc.sessionUuid) externallyOpen.add(proc.sessionUuid.toLowerCase());
    else anonymous.push(proc);
  }
  const lockedFolders = new Set<string>();
  for (const [folder, {dir, entries}] of folders) {
    const k = anonymous.filter(p => isSameOrInside(p.cwd, dir)).length;
    if (k === 0) continue;
    lockedFolders.add(folder);
    const candidates = entries
      .filter(e => e.mtimeMs !== undefined && !openUuids.has(e.uuid) && !externallyOpen.has(e.uuid))
      .sort((a, b) => b.mtimeMs! - a.mtimeMs!);
    if (candidates.length === 0) continue;
    const cutoff = candidates[Math.min(k, candidates.length) - 1].mtimeMs!;
    for (const e of candidates) {
      if (e.mtimeMs! >= cutoff) externallyOpen.add(e.uuid);
    }
  }

  // Group by uuid; a uuid that is a real file in several folders is left alone.
  const byUuid = new Map<string, Entry[]>();
  for (const e of all) {
    if (hidden.has(e.uuid)) continue;
    const list = byUuid.get(e.uuid) ?? [];
    list.push(e);
    byUuid.set(e.uuid, list);
  }

  const indexById = new Map(sessions.map((s, i) => [s.sessionUuid.toLowerCase(), i]));

  for (const [uuid, entries] of byUuid) {
    const reals = entries.filter(e => e.real);
    if (reals.length > 1) {
      warnings.push(`duplicate transcript ${uuid} in ${reals.map(e => e.folder).join(", ")}`);
      continue;
    }
    const entry = reals[0] ?? entries[0];

    try {
      // 3. Metadata (incremental, follows symlinks).
      const meta = readTranscriptMeta(entry.file, input.index.get(uuid));
      input.index.set(uuid, meta);

      // 4. Session record.
      const at = indexById.get(uuid);
      if (at === undefined) {
        sessions.push(newSession(entry, meta, input.nextNumber()));
        indexById.set(uuid, sessions.length - 1);
        changed = true;
      } else {
        const updated = updateSession(sessions[at], meta);
        if (updated) {
          sessions[at] = updated;
          changed = true;
        }
      }

      // 5. Centralize closed real transcripts.
      if (entry.real) {
        const names = new Set([entry.name, uuid]);
        const inCentral = [...names].some(
          n => existsNoFollow(path.join(input.centralDir, `${n}.jsonl`)) || existsNoFollow(path.join(input.centralDir, n)),
        );
        if (inCentral) {
          warnings.push(`link for ${uuid} became a real file in ${entry.folder}`);
        } else if (
          !lockedFolders.has(entry.folder) &&
          !openUuids.has(uuid) &&
          !externallyOpen.has(uuid) &&
          entry.mtimeMs !== undefined &&
          now - entry.mtimeMs >= ADOPT_MIN_AGE_MS
        ) {
          adoptTranscript(entry.folder, entry.name, input.centralDir);
        }
      } else if (
        isRealDir(path.join(entry.folder, entry.name)) &&
        inspectTranscript(entry.folder, entry.name, input.centralDir) === "link-ok"
      ) {
        // 6. A sidecar Claude created after adoption: centralize it too.
        const sidecar = path.join(entry.folder, entry.name);
        if (existsNoFollow(path.join(input.centralDir, entry.name))) {
          warnings.push(`sidecar for ${uuid} is a real directory in ${entry.folder} and also exists centrally`);
        } else if (
          !lockedFolders.has(entry.folder) &&
          !openUuids.has(uuid) &&
          !externallyOpen.has(uuid) &&
          entry.mtimeMs !== undefined &&
          now - Math.max(entry.mtimeMs, newestMtime(sidecar)) >= ADOPT_MIN_AGE_MS
        ) {
          adoptSidecar(entry.folder, entry.name, input.centralDir);
        }
      }
    } catch (err) {
      warnings.push(`sync failed for ${uuid} in ${entry.folder}: ${errMsg(err)}`);
    }
  }

  return {sessions, changed, externallyOpen, warnings};
}

/**
 * Move a session's transcript link from the Claude folder of its linked
 * directory to the folder of `dir`. A real transcript is adopted into the
 * central store first; a missing link is recreated from the central store.
 * Never overwrites anything in the target folder. Call only for sessions that
 * are not running anywhere.
 */
export function moveSessionLink(session: PersistedSession, dir: string, home: string, centralDir: string): void {
  const uuid = session.sessionUuid;
  const fromDir = session.linkedDir || session.config.projectDir;
  const toFolder = path.resolve(claudeProjectFolder(dir, home));
  const fromFolder = fromDir ? path.resolve(claudeProjectFolder(fromDir, home)) : undefined;
  if (fromFolder === toFolder) return;

  for (const name of [`${uuid}.jsonl`, uuid]) {
    if (existsNoFollow(path.join(toFolder, name))) {
      throw new Error(`Target ${toFolder} already has ${name}`);
    }
  }

  const state = fromFolder ? inspectTranscript(fromFolder, uuid, centralDir) : "missing";
  if (state === "link-foreign") throw new Error(`Unexpected link for ${uuid}`);

  if (state === "missing") {
    const centralFile = path.join(centralDir, `${uuid}.jsonl`);
    const centralSidecar = path.join(centralDir, uuid);
    if (!existsNoFollow(centralFile)) throw new Error(`Transcript ${uuid} not found`);
    const created: string[] = [];
    try {
      fs.mkdirSync(toFolder, {recursive: true});
      fs.symlinkSync(path.resolve(centralFile), path.join(toFolder, `${uuid}.jsonl`));
      created.push(path.join(toFolder, `${uuid}.jsonl`));
      // Always link a central sidecar, so one Claude creates later lands centrally.
      fs.mkdirSync(centralSidecar, {recursive: true});
      fs.symlinkSync(path.resolve(centralSidecar), path.join(toFolder, uuid), "dir");
      created.push(path.join(toFolder, uuid));
    } catch (err) {
      for (const link of created) {
        try {
          fs.unlinkSync(link);
        } catch {
          /* best effort: only links we created */
        }
      }
      throw new Error(`failed to link ${uuid} in ${toFolder}: ${errMsg(err)}`);
    }
    return;
  }

  if (state === "real") adoptTranscript(fromFolder!, uuid, centralDir);
  else if (isRealDir(path.join(fromFolder!, uuid))) adoptSidecar(fromFolder!, uuid, centralDir);
  relinkTranscript(fromFolder!, toFolder, uuid, centralDir);
}

/**
 * Whether the session's transcript exists anywhere Agentyard looks: the central
 * store or the Claude folder of any of `dirs`. An Agentyard session whose Claude
 * never wrote anything has none.
 */
export function transcriptExists(uuid: string, dirs: string[], home: string, centralDir: string): boolean {
  if (existsNoFollow(path.join(centralDir, `${uuid}.jsonl`))) return true;
  return dirs.some(d => d && existsNoFollow(path.join(claudeProjectFolder(d, home), `${uuid}.jsonl`)));
}

export interface RelocateInput {
  uuid: string;
  /** directory the session is about to run in */
  dir: string;
  home: string;
  centralDir: string;
  /** fresh process scan */
  external: ClaudeProcess[];
  now: number;
}

/**
 * Bring a transcript that lives outside the session's own folders back into
 * Agentyard's layout: central store plus links in the folder of `dir`. Claude
 * moves a transcript to a worktree's folder after EnterWorktree; left there it
 * is not seen by the sync, and exiting that worktree session later replaces the
 * directory's link with the file, which splits the session. Call only when
 * transcriptExists is false.
 *
 * Returns whether `claude --resume` can open the transcript. A readable link
 * elsewhere is reported as found and left alone. Throws, moving nothing, when
 * the transcript may still be written or is ambiguous.
 */
export function relocateForeignTranscript(input: RelocateInput): boolean {
  const {uuid, dir, home, centralDir, external, now} = input;
  const projectsDir = path.join(home, ".claude", "projects");
  let folderNames: string[];
  try {
    folderNames = fs.readdirSync(projectsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }

  const reals: string[] = [];
  let readable = false;
  for (const name of folderNames) {
    const file = path.join(projectsDir, name, `${uuid}.jsonl`);
    if (!fs.existsSync(file)) continue;
    readable = true;
    if (fs.lstatSync(file).isFile()) reals.push(path.join(projectsDir, name));
  }
  if (reals.length > 1) throw new Error(`Transcript ${uuid} exists in several folders: ${reals.join(", ")}`);
  if (reals.length === 0) return readable;

  const folder = reals[0];
  // A folder name cannot be decoded to its directory, so compare encoded paths. A
  // subdirectory shares the prefix; so may a sibling, which only delays the move.
  const folderName = path.basename(folder);
  const writing = external.some(p => {
    if (p.sessionUuid) return p.sessionUuid.toLowerCase() === uuid.toLowerCase();
    const encoded = encodeProjectDir(path.resolve(p.cwd));
    return encoded === folderName || encoded.startsWith(`${folderName}-`);
  });
  if (writing) throw new Error(`A Claude may be writing transcript ${uuid} in ${folder}; close it first`);
  const mtimeMs = pendingAdoptionMtime(folder, uuid, centralDir);
  if (mtimeMs !== null && now - mtimeMs < ADOPT_MIN_AGE_MS) {
    throw new Error("Conversation is still being written; try again shortly");
  }

  const target = path.resolve(claudeProjectFolder(dir, home));
  for (const name of [`${uuid}.jsonl`, uuid]) {
    if (existsNoFollow(path.join(target, name))) throw new Error(`Target ${target} already has ${name}`);
  }
  adoptTranscript(folder, uuid, centralDir);
  relinkTranscript(folder, target, uuid, centralDir);
  return true;
}

/**
 * Newest mtime of the parts of a transcript in `folder` that a move would have
 * to adopt (a real <uuid>.jsonl and/or a real <uuid>/ sidecar), or null when
 * nothing there is real.
 */
export function pendingAdoptionMtime(folder: string, uuid: string, centralDir: string): number | null {
  const file = path.join(folder, `${uuid}.jsonl`);
  const sidecar = path.join(folder, uuid);
  const fileReal = inspectTranscript(folder, uuid, centralDir) === "real";
  const sidecarReal = isRealDir(sidecar);
  if (!fileReal && !sidecarReal) return null;
  let newest = 0;
  if (fileReal) newest = fs.lstatSync(file).mtimeMs;
  if (sidecarReal) newest = Math.max(newest, newestMtime(sidecar));
  return newest;
}

export interface SessionGateInput {
  /** fresh process scan */
  external: ClaudeProcess[];
  /** Agentyard sessions whose PTY is open or still closing */
  running: {sessionId: string; sessionName: string; dir: string}[];
  /** the session being launched or moved; never counts against itself */
  sessionId: string;
  /** its transcript uuid, when it has one */
  sessionUuid?: string;
  /** directory whose Claude folder holds the transcript now, when it differs from targetDir */
  sourceDir?: string;
  /** directory Claude will run in */
  targetDir: string;
}

/**
 * Last check before a local Claude session is launched (create, reopen) or its
 * transcript is moved (directory switch). Several sessions may share a directory,
 * so an occupied target only produces a warning. Refuses when:
 * - an external Claude has this session's uuid on its command line (two writers);
 * - a Claude without a known uuid runs in the source directory of a move: it may
 *   be writing this transcript via -c or /resume.
 */
export function checkSessionGate(
  input: SessionGateInput,
): {ok: true; warning?: string} | {ok: false; error: string} {
  const uuid = input.sessionUuid?.toLowerCase();
  if (uuid && input.external.some(p => p.sessionUuid?.toLowerCase() === uuid)) {
    return {ok: false, error: "Session is open elsewhere"};
  }
  const target = path.resolve(input.targetDir);
  if (input.sourceDir && path.resolve(input.sourceDir) !== target) {
    const src = path.resolve(input.sourceDir);
    if (input.external.some(p => !p.sessionUuid && isSameOrInside(p.cwd, src))) {
      return {ok: false, error: `Directory ${input.sourceDir} has an unidentified Claude; close it first`};
    }
  }
  const activeAgents =
    input.external.filter(p => isSameOrInside(p.cwd, target)).length +
    input.running.filter(r => r.sessionId !== input.sessionId && path.resolve(r.dir) === target).length;
  if (activeAgents > 0) {
    return {ok: true, warning: `${input.targetDir} already has ${activeAgents} active agent${activeAgents === 1 ? "" : "s"}`};
  }
  return {ok: true};
}

export interface AdoptForMoveInput {
  /** directory whose Claude folder holds the real transcript */
  srcDir: string;
  /** fresh process scan */
  external: ClaudeProcess[];
  /** mtime of the real transcript */
  mtimeMs: number;
  now: number;
  /** the session's own Claude wrote it last and has been stopped and exited, so a fresh mtime is safe */
  writerStopped?: boolean;
}

/**
 * Whether a real transcript may be adopted to move a session to another
 * directory. A Claude without a known uuid in the source directory may be
 * writing this transcript, so it blocks the move; identified agents (external
 * with another uuid, other Agentyard sessions) write their own transcripts.
 */
export function canAdoptForMove(input: AdoptForMoveInput): {ok: true} | {ok: false; error: string} {
  const src = path.resolve(input.srcDir);
  if (input.external.some(p => !p.sessionUuid && isSameOrInside(p.cwd, src))) {
    return {ok: false, error: `Directory ${input.srcDir} has an active Claude; close it first`};
  }
  if (!input.writerStopped && input.now - input.mtimeMs < ADOPT_MIN_AGE_MS) {
    return {ok: false, error: "Conversation is still being written; try again shortly"};
  }
  return {ok: true};
}
