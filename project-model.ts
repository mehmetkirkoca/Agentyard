import * as path from "path";
import { ClaudeProcess } from "./process-scan";
import { PersistedSession, Project, SessionType } from "./types";

export type Occupancy =
  | { kind: "free" }
  | { kind: "agentyard"; sessionId: string; sessionName: string }
  | { kind: "external" };

function sameDir(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function isLocalClaude(session: PersistedSession): boolean {
  return session.config.sessionType === SessionType.LOCAL && session.config.codingAgent === "claude";
}

export function findProjectForDir(projects: Project[], dir: string): Project | undefined {
  return projects.find(p => p.dirs.some(d => sameDir(d, dir)));
}

export function assignProjects(
  sessions: PersistedSession[],
  projects: Project[],
  newId: () => string,
): { sessions: PersistedSession[]; projects: Project[] } {
  const nextProjects: Project[] = projects.map(p => ({...p, dirs: [...p.dirs]}));

  const nextSessions = sessions.map(session => {
    const next: PersistedSession = {...session};
    if (!next.projectId) {
      const dir = next.config.projectDir;
      let project = findProjectForDir(nextProjects, dir);
      if (!project) {
        project = {id: newId(), name: path.basename(dir), dirs: [dir]};
        nextProjects.push(project);
      }
      next.projectId = project.id;
    }
    if (isLocalClaude(next) && !next.linkedDir) {
      next.linkedDir = next.config.projectDir;
    }
    return next;
  });

  return {sessions: nextSessions, projects: nextProjects};
}

export function canAddDir(
  projects: Project[],
  projectId: string,
  dir: string,
): { ok: true } | { ok: false; reason: string } {
  const owner = findProjectForDir(projects, dir);
  if (owner && owner.id !== projectId) {
    return {ok: false, reason: `already in project ${owner.name}`};
  }
  return {ok: true};
}

// ICU collation orders "_" before digits, so localeCompare puts "acme_deploy" before "acme1".
// Compare digit runs numerically and everything else by code point instead.
function naturalCompare(a: string, b: string): number {
  const ax = a.match(/\d+|\D+/g) ?? [];
  const bx = b.match(/\d+|\D+/g) ?? [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const x = ax[i];
    const y = bx[i];
    if (x === y) continue;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else {
      return x < y ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

export function filterRepoCandidates(
  entries: { name: string; isGitRepo: boolean }[],
  prefix: string,
): string[] {
  return entries
    .filter(e => e.isGitRepo && e.name.startsWith(prefix))
    .map(e => e.name)
    .sort(naturalCompare);
}

export function computeDirOccupancy(
  dirs: string[],
  running: { sessionId: string; sessionName: string; dir: string }[],
  external: ClaudeProcess[],
): Record<string, Occupancy> {
  const result: Record<string, Occupancy> = {};
  for (const dir of dirs) {
    const resolved = path.resolve(dir);
    const fleet = running.find(r => path.resolve(r.dir) === resolved);
    if (fleet) {
      result[dir] = {kind: "agentyard", sessionId: fleet.sessionId, sessionName: fleet.sessionName};
      continue;
    }
    const isExternal = external.some(p => {
      const cwd = path.resolve(p.cwd);
      return cwd === resolved || cwd.startsWith(resolved + path.sep);
    });
    result[dir] = isExternal ? {kind: "external"} : {kind: "free"};
  }
  return result;
}

export function firstFreeDir(dirs: string[], occ: Record<string, Occupancy>): string | undefined {
  return dirs.find(d => occ[d]?.kind === "free");
}

export function normalizeDirs(dirs: string[]): string[] {
  return [...new Set(dirs.map(d => path.resolve(d)))];
}

// Built-in project holding the project-independent sessions shown in the SESSIONS section.
export const STANDALONE_PROJECT_ID = "__standalone__";
export const STANDALONE_PROJECT_NAME = "Others";

export function isStandaloneProject(project: Pick<Project, "id"> | string | undefined): boolean {
  const id = typeof project === "string" ? project : project?.id;
  return id === STANDALONE_PROJECT_ID;
}

export function standaloneScratchDir(home: string): string {
  return path.join(home, "agentyard-scratch");
}

// Adds the built-in project when missing and repairs its name and empty dir list. Never mutates inputs.
export function ensureStandaloneProject(
  projects: Project[],
  home: string,
): { projects: Project[]; changed: boolean } {
  const existing = projects.find(isStandaloneProject);
  if (!existing) {
    const created: Project = {id: STANDALONE_PROJECT_ID, name: STANDALONE_PROJECT_NAME, dirs: [standaloneScratchDir(home)]};
    return {projects: [...projects, created], changed: true};
  }
  if (existing.name === STANDALONE_PROJECT_NAME && existing.dirs.length > 0) {
    return {projects, changed: false};
  }
  const repaired: Project = {
    ...existing,
    name: STANDALONE_PROJECT_NAME,
    dirs: existing.dirs.length > 0 ? [...existing.dirs] : [standaloneScratchDir(home)],
  };
  return {projects: projects.map(p => (p === existing ? repaired : p)), changed: true};
}
