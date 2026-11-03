// Pure state for workspaces (no DOM here).
//
// A workspace is a named group of tabs with its own pane layout. Every session belongs to at most
// one workspace; the record survives closing its tab, so it reopens where it was. A session with no
// record has never been opened in any workspace: the sidebar filter counts it as Default, and
// opening it records it in the active workspace.

import {
  createPaneState,
  ensureInTabOrder,
  evictSession,
  PaneState,
  parsePaneState,
  pruneSessions,
  removeSession,
} from "./pane-layout";

export const DEFAULT_WORKSPACE_ID = "default";
export const DEFAULT_WORKSPACE_NAME = "Default";

export interface Workspace {
  id: string;
  name: string;
  panes: PaneState;
}

export interface WorkspaceState {
  workspaces: Workspace[]; // [0] is always Default
  activeId: string;
  membership: Record<string, string>; // sessionId → workspaceId (explicit records only)
  sidebarFilter: boolean;
}

export function createWorkspaceState(panes: PaneState = createPaneState()): WorkspaceState {
  return {
    workspaces: [{id: DEFAULT_WORKSPACE_ID, name: DEFAULT_WORKSPACE_NAME, panes}],
    activeId: DEFAULT_WORKSPACE_ID,
    membership: {},
    sidebarFilter: false,
  };
}

function find(state: WorkspaceState, id: string): Workspace | undefined {
  return state.workspaces.find(w => w.id === id);
}

export function activeWorkspace(state: WorkspaceState): Workspace {
  return find(state, state.activeId) ?? state.workspaces[0];
}

function mapPanes(state: WorkspaceState, fn: (panes: PaneState, w: Workspace) => PaneState): WorkspaceState {
  return {...state, workspaces: state.workspaces.map(w => ({...w, panes: fn(w.panes, w)}))};
}

export function withActivePanes(state: WorkspaceState, panes: PaneState): WorkspaceState {
  return mapPanes(state, (p, w) => (w.id === state.activeId ? panes : p));
}

// ---- Workspace list ----

export function nextWorkspaceName(state: WorkspaceState): string {
  const names = new Set(state.workspaces.map(w => w.name));
  let n = 2;
  while (names.has(`Workspace ${n}`)) n++;
  return `Workspace ${n}`;
}

export function addWorkspace(state: WorkspaceState, id: string, name: string): WorkspaceState {
  if (!id || find(state, id)) return state;
  const workspace: Workspace = {id, name: name.trim() || nextWorkspaceName(state), panes: createPaneState()};
  return {...state, workspaces: [...state.workspaces, workspace], activeId: id};
}

export function renameWorkspace(state: WorkspaceState, id: string, name: string): WorkspaceState {
  const trimmed = name.trim();
  if (!trimmed || !find(state, id)) return state;
  return {...state, workspaces: state.workspaces.map(w => (w.id === id ? {...w, name: trimmed} : w))};
}

export function switchWorkspace(state: WorkspaceState, id: string): WorkspaceState {
  if (id === state.activeId || !find(state, id)) return state;
  return {...state, activeId: id};
}

// Default stays; the deleted workspace's members are written to Default explicitly (so they reopen
// there) and its tabs join Default's tab row, not its panes
export function deleteWorkspace(state: WorkspaceState, id: string): WorkspaceState {
  const doomed = find(state, id);
  if (!doomed || id === DEFAULT_WORKSPACE_ID) return state;
  const membership: Record<string, string> = {};
  for (const [sessionId, wsId] of Object.entries(state.membership)) {
    membership[sessionId] = wsId === id ? DEFAULT_WORKSPACE_ID : wsId;
  }
  const workspaces = state.workspaces.filter(w => w.id !== id).map(w => {
    if (w.id !== DEFAULT_WORKSPACE_ID) return w;
    const tabOrder = doomed.panes.tabOrder.reduce(ensureInTabOrder, w.panes.tabOrder);
    return {...w, panes: {...w.panes, tabOrder}};
  });
  const activeId = state.activeId === id ? DEFAULT_WORKSPACE_ID : state.activeId;
  return {...state, workspaces, membership, activeId};
}

// ---- Membership ----

export function workspaceOf(state: WorkspaceState, sessionId: string): string | null {
  return state.membership[sessionId] ?? null;
}

// First open (joins the active workspace) and "Move to workspace": out of every other workspace,
// into the target's tab order (not its panes)
export function moveSessionTo(state: WorkspaceState, sessionId: string, targetId: string): WorkspaceState {
  if (!find(state, targetId)) return state;
  const moved = mapPanes(state, (p, w) =>
    w.id === targetId ? {...p, tabOrder: ensureInTabOrder(p.tabOrder, sessionId)} : evictSession(p, sessionId));
  return {...moved, membership: {...state.membership, [sessionId]: targetId}};
}

// Closed tab: the session leaves the panes but keeps its record. Only the active workspace refills
// its focused pane from the open tabs.
export function removeSessionFromWorkspaces(state: WorkspaceState, sessionId: string, activeOpenTabs: string[]): WorkspaceState {
  return mapPanes(state, (p, w) => removeSession(p, sessionId, w.id === state.activeId ? activeOpenTabs : []));
}

// Deleted session
export function forgetSession(state: WorkspaceState, sessionId: string): WorkspaceState {
  const membership = {...state.membership};
  delete membership[sessionId];
  return {...mapPanes(state, p => evictSession(p, sessionId)), membership};
}

export function pruneWorkspaces(state: WorkspaceState, known: Set<string>): WorkspaceState {
  const membership = Object.fromEntries(Object.entries(state.membership).filter(([id]) => known.has(id)));
  return {...mapPanes(state, p => pruneSessions(p, known)), membership};
}

// ---- Sidebar ----

export function setSidebarFilter(state: WorkspaceState, on: boolean): WorkspaceState {
  return state.sidebarFilter === on ? state : {...state, sidebarFilter: on};
}

export function showsInSidebar(state: WorkspaceState, sessionId: string): boolean {
  return !state.sidebarFilter || (workspaceOf(state, sessionId) ?? DEFAULT_WORKSPACE_ID) === state.activeId;
}

export function waitingByWorkspace(state: WorkspaceState, waitingIds: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of waitingIds) {
    const wsId = workspaceOf(state, id) ?? DEFAULT_WORKSPACE_ID;
    counts.set(wsId, (counts.get(wsId) ?? 0) + 1);
  }
  return counts;
}

// ---- Persistence ----

// Validate a stored value; without one, the legacy single pane layout becomes the Default workspace
export function parseWorkspaceState(raw: unknown, legacyPanes: unknown): WorkspaceState {
  const obj = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
  if (!obj || !Array.isArray(obj.workspaces)) return createWorkspaceState(parsePaneState(legacyPanes));

  const workspaces: Workspace[] = [];
  for (const entry of obj.workspaces) {
    if (!entry || typeof entry !== "object") continue;
    const w = entry as Record<string, unknown>;
    if (typeof w.id !== "string" || !w.id || workspaces.some(x => x.id === w.id)) continue;
    if (typeof w.name !== "string" || !w.name.trim()) continue;
    workspaces.push({id: w.id, name: w.name.trim(), panes: parsePaneState(w.panes)});
  }
  const defaultIndex = workspaces.findIndex(w => w.id === DEFAULT_WORKSPACE_ID);
  const fallback = {id: DEFAULT_WORKSPACE_ID, name: DEFAULT_WORKSPACE_NAME, panes: createPaneState()};
  const def = defaultIndex >= 0 ? workspaces.splice(defaultIndex, 1)[0] : fallback;
  workspaces.unshift(def);

  const ids = new Set(workspaces.map(w => w.id));
  const membership: Record<string, string> = {};
  const rawMembership = obj.membership && typeof obj.membership === "object" ? obj.membership as Record<string, unknown> : {};
  for (const [sessionId, wsId] of Object.entries(rawMembership)) {
    if (typeof wsId !== "string") continue;
    membership[sessionId] = ids.has(wsId) ? wsId : DEFAULT_WORKSPACE_ID;
  }

  // A recorded session lives in its own workspace's panes only
  const repaired = workspaces.map(w => {
    let panes = w.panes;
    for (const [sessionId, wsId] of Object.entries(membership)) {
      if (wsId !== w.id) panes = evictSession(panes, sessionId);
    }
    return {...w, panes};
  });

  const activeId = typeof obj.activeId === "string" && ids.has(obj.activeId) ? obj.activeId : DEFAULT_WORKSPACE_ID;
  return {workspaces: repaired, activeId, membership, sidebarFilter: obj.sidebarFilter === true};
}
