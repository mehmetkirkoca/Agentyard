import { isStandaloneProject } from "./project-model";
import { PersistedSession, Project, SessionStatus } from "./types";

export interface SidebarGroup {
  project: Project;
  waitingCount: number;
  recent: PersistedSession[];
  older: PersistedSession[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function activity(session: PersistedSession): number {
  return session.lastActivity ?? session.createdAt;
}

function isAttention(status?: SessionStatus): boolean {
  return status === SessionStatus.WAITING || status === SessionStatus.DONE;
}

function buildGroup(
  project: Project,
  sessions: PersistedSession[],
  now: number,
  staleDays: number,
): SidebarGroup {
  const own = sessions
    .filter(s => s.projectId === project.id)
    .sort((a, b) => activity(b) - activity(a));
  const isOlder = (s: PersistedSession) =>
    now - activity(s) > staleDays * DAY_MS &&
    s.status !== SessionStatus.RUNNING &&
    !isAttention(s.status);
  return {
    project,
    waitingCount: own.filter(s => isAttention(s.status)).length,
    recent: own.filter(s => !isOlder(s)),
    older: own.filter(isOlder),
  };
}

// Project groups for the PROJECTS section; the built-in standalone project is left out.
export function buildSidebar(
  projects: Project[],
  sessions: PersistedSession[],
  now: number,
  staleDays = 7,
): SidebarGroup[] {
  return projects
    .filter(p => !isStandaloneProject(p))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(project => buildGroup(project, sessions, now, staleDays));
}

// The SESSIONS section group; undefined when the built-in standalone project is not loaded yet.
export function buildStandaloneGroup(
  projects: Project[],
  sessions: PersistedSession[],
  now: number,
  staleDays = 7,
): SidebarGroup | undefined {
  const project = projects.find(p => isStandaloneProject(p));
  return project ? buildGroup(project, sessions, now, staleDays) : undefined;
}

function searchKey(text: string): string {
  return text.toLocaleLowerCase("tr");
}

/**
 * Sidebar search inside one group: keep sessions whose name contains the query
 * (case-insensitive, Turkish casing). Matches from "Older" are listed inline so
 * they are visible without expanding it. The waiting counter stays the group's.
 */
export function filterSidebarGroup(group: SidebarGroup, query: string): SidebarGroup {
  const q = searchKey(query.trim());
  if (!q) return group;
  const matches = (session: PersistedSession) => searchKey(session.name).includes(q);
  return {...group, recent: [...group.recent, ...group.older].filter(matches), older: []};
}
