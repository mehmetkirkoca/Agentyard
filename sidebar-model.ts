import { isStandaloneProject } from "./project-constants";
import { PersistedSession, Project, SessionStatus } from "./types";

export interface SidebarGroup {
  project: Project;
  waitingCount: number;
  recent: PersistedSession[];
  older: PersistedSession[];
  archived: PersistedSession[];
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
  // Favorites first, each part by activity
  const own = sessions
    .filter(s => s.projectId === project.id)
    .sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || activity(b) - activity(a));
  const isOlder = (s: PersistedSession) =>
    !s.favorite &&
    now - activity(s) > staleDays * DAY_MS &&
    s.status !== SessionStatus.RUNNING &&
    !isAttention(s.status);
  const listed = own.filter(s => !s.archived);
  return {
    project,
    // An archived session counts only while it really waits: "done" would never clear there
    waitingCount: own.filter(s => (s.archived ? s.status === SessionStatus.WAITING : isAttention(s.status))).length,
    recent: listed.filter(s => !isOlder(s)),
    older: listed.filter(isOlder),
    archived: own.filter(s => s.archived),
  };
}

// Project groups for the PROJECTS section; the built-in standalone project is left out.
// `order` (project ids, from drag & drop) wins; projects not in it follow, sorted by name.
export function buildSidebar(
  projects: Project[],
  sessions: PersistedSession[],
  now: number,
  staleDays = 7,
  order: string[] = [],
): SidebarGroup[] {
  const rank = (p: Project) => {
    const i = order.indexOf(p.id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return projects
    .filter(p => !isStandaloneProject(p))
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .map(project => buildGroup(project, sessions, now, staleDays));
}

// New project order after dropping `movedId` before (or after) `targetId`.
export function moveProjectInOrder(order: string[], movedId: string, targetId: string, after: boolean): string[] {
  if (movedId === targetId) return order;
  const rest = order.filter(id => id !== movedId);
  const index = rest.indexOf(targetId);
  if (index === -1) return [...rest, movedId];
  rest.splice(after ? index + 1 : index, 0, movedId);
  return rest;
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
 * Sidebar search inside one group: keep sessions whose name, last prompt or last summary contains
 * the query (case-insensitive, Turkish casing). Matches from "Older" and "Archive" are listed inline so
 * they are visible without expanding it. The waiting counter stays the group's.
 */
export function filterSidebarGroup(group: SidebarGroup, query: string): SidebarGroup {
  const q = searchKey(query.trim());
  if (!q) return group;
  const matches = (session: PersistedSession) =>
    [session.name, session.lastPrompt, session.lastSummary].some(text => text && searchKey(text).includes(q));
  return {...group, recent: [...group.recent, ...group.older, ...group.archived].filter(matches), older: [], archived: []};
}

/** "just now", "5m ago", "3h ago", "2d ago" */
export function formatAge(timestamp: number, now: number): string {
  const minutes = Math.floor((now - timestamp) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
