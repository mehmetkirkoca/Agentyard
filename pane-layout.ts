// Pure state for the split-pane tree and the tab order (no DOM here).
//
// The pane area is a binary tree: a leaf shows one session (or is empty), a split divides its
// area between two children. "row" puts the children side by side (vertical bar), "col"
// stacks them (horizontal bar). Leaf ids are stable, so the DOM can key panes by them.

export type LayoutKind = "single" | "columns" | "rows" | "grid";
export const LAYOUTS: LayoutKind[] = ["single", "columns", "rows", "grid"];

export type SplitDir = "row" | "col";
export type Side = "left" | "right" | "top" | "bottom";

export interface LeafNode {
  kind: "leaf";
  id: number;
  session: string | null;
  pinned?: boolean; // a newly opened session never replaces this pane's content
}

export interface SplitNode {
  kind: "split";
  dir: SplitDir;
  ratio: number; // share of the first child (a)
  a: PaneNode;
  b: PaneNode;
}

export type PaneNode = LeafNode | SplitNode;

export interface PaneState {
  root: PaneNode;
  focused: number; // leaf id
  tabOrder: string[];
  linkedSplits: boolean; // 2×2 shape: both child splits share one ratio
}

export const MAX_PANES = 8;
export const MIN_SPLIT = 0.15;
export const MAX_SPLIT = 0.85;
const MAX_DEPTH = MAX_PANES; // a valid tree with ≤ 8 leaves is never deeper

export function clampSplit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0.5;
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, value));
}

// Side shell panel under a pane's agent terminal: its share of the terminal area
// (pane minus the 44px header + prompt line and the 20px toolbar)
export const DEFAULT_SHELL_RATIO = 0.35;
const PANE_CHROME_TOP = 44;
const PANE_CHROME_BOTTOM = 20;

export function clampShellRatio(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_SHELL_RATIO;
  return Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, value));
}

// Splitter dragged to clientY in a pane at paneTop with paneHeight
export function shellRatioAt(paneTop: number, paneHeight: number, clientY: number): number {
  const area = paneHeight - PANE_CHROME_TOP - PANE_CHROME_BOTTOM;
  if (area <= 0) return DEFAULT_SHELL_RATIO;
  const areaBottom = paneTop + paneHeight - PANE_CHROME_BOTTOM;
  return clampShellRatio((areaBottom - clientY) / area);
}

function leaf(id: number, session: string | null = null): LeafNode {
  return {kind: "leaf", id, session};
}

function split(dir: SplitDir, a: PaneNode, b: PaneNode, ratio = 0.5): SplitNode {
  return {kind: "split", dir, ratio, a, b};
}

export function createPaneState(): PaneState {
  return {root: leaf(1), focused: 1, tabOrder: [], linkedSplits: true};
}

// ---- Tree queries ----

export function leaves(node: PaneNode): LeafNode[] {
  return node.kind === "leaf" ? [node] : [...leaves(node.a), ...leaves(node.b)];
}

export function paneTotal(state: PaneState): number {
  return leaves(state.root).length;
}

export function visibleSessions(state: PaneState): string[] {
  return leaves(state.root).flatMap(l => (l.session ? [l.session] : []));
}

export function paneSession(state: PaneState, leafId: number): string | null {
  return leaves(state.root).find(l => l.id === leafId)?.session ?? null;
}

export function focusedSession(state: PaneState): string | null {
  return paneSession(state, state.focused);
}

export function paneOfSession(state: PaneState, sessionId: string): number | null {
  return leaves(state.root).find(l => l.session === sessionId)?.id ?? null;
}

function hasLeaf(state: PaneState, leafId: number): boolean {
  return leaves(state.root).some(l => l.id === leafId);
}

function nextLeafId(root: PaneNode): number {
  return Math.max(0, ...leaves(root).map(l => l.id)) + 1;
}

function mapLeaves(node: PaneNode, fn: (l: LeafNode) => PaneNode): PaneNode {
  if (node.kind === "leaf") return fn(node);
  return {...node, a: mapLeaves(node.a, fn), b: mapLeaves(node.b, fn)};
}

// Path = "a"/"b" steps from the root ("" = root)
export function nodeAt(root: PaneNode, path: string): PaneNode | null {
  let node: PaneNode = root;
  for (const step of path) {
    if (node.kind !== "split") return null;
    node = step === "a" ? node.a : node.b;
  }
  return node;
}

function updateAt(root: PaneNode, path: string, fn: (n: PaneNode) => PaneNode): PaneNode {
  if (path === "") return fn(root);
  if (root.kind !== "split") return root;
  const [step, rest] = [path[0], path.slice(1)];
  return step === "a" ? {...root, a: updateAt(root.a, rest, fn)} : {...root, b: updateAt(root.b, rest, fn)};
}

// Root split whose two children are both splits in the perpendicular direction
export function is2x2(root: PaneNode): boolean {
  return root.kind === "split" &&
    root.a.kind === "split" && root.b.kind === "split" &&
    root.a.dir !== root.dir && root.b.dir !== root.dir;
}

// The template the tree currently matches exactly (for the layout button highlight)
export function templateOf(root: PaneNode): LayoutKind | null {
  if (root.kind === "leaf") return "single";
  const twoLeaves = root.a.kind === "leaf" && root.b.kind === "leaf";
  if (twoLeaves) return root.dir === "row" ? "columns" : "rows";
  if (is2x2(root) && leaves(root).length === 4) return "grid";
  return null;
}

// ---- Session placement ----

// Moving a session out of a pane on purpose also lifts that pane's pin
function clearSession(root: PaneNode, sessionId: string): PaneNode {
  return mapLeaves(root, l => (l.session === sessionId ? {...l, session: null, pinned: undefined} : l));
}

function setLeafSession(root: PaneNode, leafId: number, sessionId: string | null): PaneNode {
  return mapLeaves(root, l => (l.id === leafId ? {...l, session: sessionId} : l));
}

export function isPanePinned(state: PaneState, leafId: number): boolean {
  return leaves(state.root).find(l => l.id === leafId)?.pinned === true;
}

// Pin/unpin a pane; an empty pane cannot be newly pinned
export function togglePanePin(state: PaneState, leafId: number): PaneState {
  const target = leaves(state.root).find(l => l.id === leafId);
  if (!target || (!target.pinned && target.session === null)) return state;
  const pinned = target.pinned ? undefined : true;
  return {...state, root: mapLeaves(state.root, l => (l.id === leafId ? {...l, pinned} : l))};
}

// A pinned pane only takes a session while it is empty (or already shows that session)
export function canAssign(state: PaneState, leafId: number, sessionId: string): boolean {
  const target = leaves(state.root).find(l => l.id === leafId);
  if (!target) return false;
  return !target.pinned || target.session === null || target.session === sessionId;
}

export function focusPane(state: PaneState, leafId: number): PaneState {
  return hasLeaf(state, leafId) ? {...state, focused: leafId} : state;
}

// Put a session into a pane (moving it out of any other pane) and focus that pane
export function assignSession(state: PaneState, leafId: number, sessionId: string): PaneState {
  if (!canAssign(state, leafId, sessionId)) return state;
  const root = setLeafSession(clearSession(state.root, sessionId), leafId, sessionId);
  return {...state, root, focused: leafId};
}

// Opening a session (tab or sidebar click): focus the pane already showing it; otherwise fill
// the focused pane if it is empty, else the first empty pane; replace the focused pane only
// when every pane is occupied. Pinned panes are never chosen: a pinned focused pane hands the
// replacement to the first unpinned pane. With every pane pinned the state is returned unchanged.
export function showSession(state: PaneState, sessionId: string): PaneState {
  const existing = paneOfSession(state, sessionId);
  if (existing !== null) return focusPane(state, existing);
  const free = leaves(state.root).filter(leaf => !leaf.pinned);
  const focused = free.find(leaf => leaf.id === state.focused);
  if (focused && focused.session === null) return assignSession(state, focused.id, sessionId);
  const target = free.find(leaf => leaf.session === null) ?? focused ?? free[0];
  return target ? assignSession(state, target.id, sessionId) : state;
}

// Swap the contents of two panes (an empty target just receives the session); focus follows it
export function swapPanes(state: PaneState, from: number, to: number): PaneState {
  if (from === to || !hasLeaf(state, from) || !hasLeaf(state, to)) return state;
  // The pin travels with the content
  const a = leaves(state.root).find(l => l.id === from)!;
  const b = leaves(state.root).find(l => l.id === to)!;
  const root = mapLeaves(state.root, l => {
    if (l.id === from) return {...l, session: b.session, pinned: b.pinned};
    if (l.id === to) return {...l, session: a.session, pinned: a.pinned};
    return l;
  });
  return {...state, root, focused: to};
}

// Closed or deleted session: its pane stays (empty, keeping its pin); an unpinned focused pane
// that lost it gets the first open tab not visible elsewhere
export function removeSession(state: PaneState, sessionId: string, openTabs: string[]): PaneState {
  const wasFocused = focusedSession(state) === sessionId && !isPanePinned(state, state.focused);
  let root = mapLeaves(state.root, l => (l.session === sessionId ? {...l, session: null} : l));
  if (wasFocused) {
    const shown = new Set(leaves(root).flatMap(l => (l.session ? [l.session] : [])));
    const next = openTabs.find(id => id !== sessionId && !shown.has(id));
    if (next) root = setLeafSession(root, state.focused, next);
  }
  return {...state, root, tabOrder: state.tabOrder.filter(id => id !== sessionId)};
}

// Session taken out on purpose (moved to another workspace): its pane empties and loses its pin,
// nothing refills it and the focus stays
export function evictSession(state: PaneState, sessionId: string): PaneState {
  return {
    ...state,
    root: clearSession(state.root, sessionId),
    tabOrder: state.tabOrder.filter(id => id !== sessionId),
  };
}

// Drop ids of sessions that no longer exist (e.g. deleted while the app was closed)
export function pruneSessions(state: PaneState, known: Set<string>): PaneState {
  return {
    ...state,
    root: mapLeaves(state.root, l => (l.session !== null && !known.has(l.session) ? {...l, session: null} : l)),
    tabOrder: state.tabOrder.filter(id => known.has(id)),
  };
}

// ---- Splitting and closing ----

export function canSplit(state: PaneState): boolean {
  return paneTotal(state) < MAX_PANES;
}

// Split a pane towards `side`; the new pane gets `sessionId` (moved from any other pane) and focus.
// Returns null when the pane limit is reached.
export function splitPane(state: PaneState, leafId: number, side: Side, sessionId: string | null): PaneState | null {
  if (!hasLeaf(state, leafId)) return null;
  // Dropping a pane's own session on its edge changes nothing (instead of leaving that half empty)
  if (sessionId !== null && paneSession(state, leafId) === sessionId) return state;
  if (!canSplit(state)) return null;
  const base = sessionId ? clearSession(state.root, sessionId) : state.root;
  const id = nextLeafId(base);
  const fresh = leaf(id, sessionId);
  const dir: SplitDir = side === "left" || side === "right" ? "row" : "col";
  const first = side === "left" || side === "top";
  const root = mapLeaves(base, l => (l.id === leafId ? split(dir, first ? fresh : l, first ? l : fresh) : l));
  return normalizeLinked({...state, root, focused: id});
}

// Remove a pane; its sibling takes the space. The last pane cannot be closed.
export function closePane(state: PaneState, leafId: number): PaneState {
  return normalizeLinked(removePane(state, leafId));
}

function removePane(state: PaneState, leafId: number): PaneState {
  if (state.root.kind === "leaf" || !hasLeaf(state, leafId)) return state;
  let sibling: PaneNode | null = null;
  const remove = (node: PaneNode): PaneNode => {
    if (node.kind === "leaf") return node;
    if (node.a.kind === "leaf" && node.a.id === leafId) return (sibling = node.b);
    if (node.b.kind === "leaf" && node.b.id === leafId) return (sibling = node.a);
    return {...node, a: remove(node.a), b: remove(node.b)};
  };
  const root = remove(state.root);
  const focused = state.focused === leafId && sibling ? leaves(sibling)[0].id : state.focused;
  return {...state, root, focused};
}

// Move a pane next to another one (dragging its header onto an edge); the pane count is unchanged
export function movePane(state: PaneState, from: number, to: number, side: Side): PaneState {
  if (from === to || !hasLeaf(state, from) || !hasLeaf(state, to)) return state;
  const session = paneSession(state, from);
  const pinned = isPanePinned(state, from);
  // Normalised once at the end (by splitPane), not for the intermediate tree
  const closed = removePane(state, from);
  const moved = splitPane(closed, to, side, session);
  if (!moved) return state;
  // The new pane takes over the pin (an empty pinned pane included)
  return pinned ? {...moved, root: mapLeaves(moved.root, l => (l.id === moved.focused ? {...l, pinned: true} : l))} : moved;
}

// ---- Ratios ----

export function setRatio(state: PaneState, path: string, value: number): PaneState {
  const ratio = clampSplit(value);
  const linkedChild = state.linkedSplits && is2x2(state.root) && (path === "a" || path === "b");
  const paths = linkedChild ? ["a", "b"] : [path];
  let root = state.root;
  for (const p of paths) {
    root = updateAt(root, p, n => (n.kind === "split" ? {...n, ratio} : n));
  }
  return {...state, root};
}

// Linked 2×2 invariant: the second child split follows the first. Every tree mutation that can
// produce the 2×2 shape (split, close, move, parse, linking) goes through here.
export function normalizeLinked(state: PaneState): PaneState {
  const root = state.root;
  if (!state.linkedSplits || !is2x2(root) || root.kind !== "split") return state;
  if (root.a.kind !== "split" || root.b.kind !== "split" || root.a.ratio === root.b.ratio) return state;
  return {...state, root: {...root, b: {...root.b, ratio: root.a.ratio}}};
}

export function setLinkedSplits(state: PaneState, linked: boolean): PaneState {
  return normalizeLinked({...state, linkedSplits: linked});
}

// ---- Templates (layout buttons) ----

function buildTemplate(layout: LayoutKind, slots: (string | null)[]): PaneNode {
  const at = (i: number) => leaf(i + 1, slots[i] ?? null);
  if (layout === "columns") return split("row", at(0), at(1));
  if (layout === "rows") return split("col", at(0), at(1));
  if (layout === "grid") return split("col", split("row", at(0), at(1)), split("row", at(2), at(3)));
  return at(0);
}

// Rebuild the tree to a template, keeping as many shown sessions as fit, in order
export function applyTemplate(state: PaneState, layout: LayoutKind): PaneState {
  const focusedId = focusedSession(state);
  // A single pane keeps what the focused pane shows
  const keep = layout === "single" ? [focusedId] : visibleSessions(state);
  const pinnedSessions = new Set(leaves(state.root).flatMap(l => (l.pinned && l.session ? [l.session] : [])));
  const root = mapLeaves(buildTemplate(layout, keep),
    l => (l.session && pinnedSessions.has(l.session) ? {...l, pinned: true} : l));
  const focusLeaf = leaves(root).find(l => l.session !== null && l.session === focusedId);
  return {...state, root, focused: focusLeaf ? focusLeaf.id : 1};
}

// ---- Geometry ----

export interface PaneRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const FULL: PaneRect = {left: 0, top: 0, width: 1, height: 1};

function childRects(node: SplitNode, rect: PaneRect): [PaneRect, PaneRect] {
  if (node.dir === "row") {
    const w = rect.width * node.ratio;
    return [{...rect, width: w}, {...rect, left: rect.left + w, width: rect.width - w}];
  }
  const h = rect.height * node.ratio;
  return [{...rect, height: h}, {...rect, top: rect.top + h, height: rect.height - h}];
}

// Pane rectangles as fractions of the pane area, in leaf order
export function paneRects(root: PaneNode): {id: number; rect: PaneRect}[] {
  const out: {id: number; rect: PaneRect}[] = [];
  const walk = (node: PaneNode, rect: PaneRect) => {
    if (node.kind === "leaf") {
      out.push({id: node.id, rect});
      return;
    }
    const [ra, rb] = childRects(node, rect);
    walk(node.a, ra);
    walk(node.b, rb);
  };
  walk(root, FULL);
  return out;
}

// A splitter bar: axis "x" is a vertical bar at x = pos spanning y from..to ("y" the other way).
// start/size: the split's own extent along the axis, to turn a pointer position into a ratio.
export interface SplitterSpec {
  path: string;
  axis: "x" | "y";
  pos: number;
  from: number;
  to: number;
  start: number;
  size: number;
}

export function splitterSpecs(root: PaneNode): SplitterSpec[] {
  const out: SplitterSpec[] = [];
  const walk = (node: PaneNode, rect: PaneRect, path: string) => {
    if (node.kind === "leaf") return;
    if (node.dir === "row") {
      out.push({path, axis: "x", pos: rect.left + rect.width * node.ratio, from: rect.top,
        to: rect.top + rect.height, start: rect.left, size: rect.width});
    } else {
      out.push({path, axis: "y", pos: rect.top + rect.height * node.ratio, from: rect.left,
        to: rect.left + rect.width, start: rect.top, size: rect.height});
    }
    const [ra, rb] = childRects(node, rect);
    walk(node.a, ra, path + "a");
    walk(node.b, rb, path + "b");
  };
  walk(root, FULL, "");
  return out;
}

// Linked 2×2: a handle where the bars cross moves the root split and both child splits
export function crossHandle(state: PaneState): {x: number; y: number; xPath: string; yPath: string} | null {
  const root = state.root;
  if (!state.linkedSplits || !is2x2(root) || root.kind !== "split" || root.a.kind !== "split") return null;
  if (root.dir === "col") return {x: root.a.ratio, y: root.ratio, xPath: "a", yPath: ""};
  return {x: root.ratio, y: root.a.ratio, xPath: "", yPath: "a"};
}

// Pointer position inside a pane (fractions) → drop zone; edges are the outer 25%
export function dropZone(x: number, y: number, allowEdges: boolean): Side | "center" {
  if (!allowEdges) return "center";
  const edges: [Side, number][] = [["left", x], ["right", 1 - x], ["top", y], ["bottom", 1 - y]];
  const [side, distance] = edges.reduce((best, cur) => (cur[1] < best[1] ? cur : best));
  return distance < 0.25 ? side : "center";
}

// ---- Tab order ----

export function ensureInTabOrder(order: string[], sessionId: string): string[] {
  return order.includes(sessionId) ? order : [...order, sessionId];
}

// Id of the existing tab a new tab must be inserted before (null = append), following the saved order
export function tabInsertBefore(order: string[], sessionId: string, presentTabs: string[]): string | null {
  const pos = order.indexOf(sessionId);
  if (pos < 0) return null;
  const later = new Set(order.slice(pos + 1));
  return presentTabs.find(id => later.has(id)) ?? null;
}

// Move a tab before (or after) another tab; targetId null moves it to the end
export function moveTab(order: string[], sessionId: string, targetId: string | null, after = false): string[] {
  if (sessionId === targetId) return order;
  const rest = order.filter(id => id !== sessionId);
  if (targetId === null) return [...rest, sessionId];
  const idx = rest.indexOf(targetId);
  if (idx < 0) return [...rest, sessionId];
  rest.splice(after ? idx + 1 : idx, 0, sessionId);
  return rest;
}

// ---- Persistence ----

// Rebuilds a stored tree with fresh sequential leaf ids; null when malformed or too big
function parseNode(raw: unknown, depth: number, ctx: {next: number; seen: Set<string>; idMap: Map<number, number>}): PaneNode | null {
  if (!raw || typeof raw !== "object" || depth > MAX_DEPTH) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.kind === "leaf") {
    const id = ctx.next++;
    if (typeof obj.id === "number" && !ctx.idMap.has(obj.id)) ctx.idMap.set(obj.id, id);
    let session = typeof obj.session === "string" && obj.session ? obj.session : null;
    if (session && ctx.seen.has(session)) session = null;
    if (session) ctx.seen.add(session);
    return obj.pinned === true ? {...leaf(id, session), pinned: true} : leaf(id, session);
  }
  if (obj.kind === "split" && (obj.dir === "row" || obj.dir === "col")) {
    const a = parseNode(obj.a, depth + 1, ctx);
    const b = a ? parseNode(obj.b, depth + 1, ctx) : null;
    return a && b ? split(obj.dir, a, b, clampSplit(obj.ratio)) : null;
  }
  return null;
}

function parseTabOrder(raw: unknown): string[] {
  const tabOrder: string[] = [];
  if (Array.isArray(raw)) {
    for (const id of raw) {
      if (typeof id === "string" && id && !tabOrder.includes(id)) tabOrder.push(id);
    }
  }
  return tabOrder;
}

// Format before the tree: {layout, panes[], focused index, splits{columns, rows, gridTop|gridX, gridBottom, gridY}}
function parseLegacy(obj: Record<string, unknown>): {root: PaneNode; focused: number} {
  const layout = LAYOUTS.includes(obj.layout as LayoutKind) ? obj.layout as LayoutKind : "single";
  const rawPanes = Array.isArray(obj.panes) ? obj.panes : [];
  const slots: (string | null)[] = [];
  for (let i = 0; i < 4; i++) {
    const value = rawPanes[i];
    slots.push(typeof value === "string" && value && !slots.includes(value) ? value : null);
  }
  let root = buildTemplate(layout, slots);
  const s = obj.splits && typeof obj.splits === "object" ? obj.splits as Record<string, unknown> : {};
  if (layout === "columns") root = {...root as SplitNode, ratio: clampSplit(s.columns)};
  if (layout === "rows") root = {...root as SplitNode, ratio: clampSplit(s.rows)};
  if (layout === "grid") {
    const g = root as SplitNode;
    root = {
      ...g,
      ratio: clampSplit(s.gridY),
      a: {...g.a as SplitNode, ratio: clampSplit(s.gridTop ?? s.gridX)},
      b: {...g.b as SplitNode, ratio: clampSplit(s.gridBottom ?? s.gridX)},
    };
  }
  const count = leaves(root).length;
  const index = Number.isInteger(obj.focused) && (obj.focused as number) >= 0 && (obj.focused as number) < count
    ? obj.focused as number
    : 0;
  return {root, focused: index + 1};
}

// Validate a stored value; anything malformed falls back to defaults
export function parsePaneState(raw: unknown): PaneState {
  if (!raw || typeof raw !== "object") return createPaneState();
  const obj = raw as Record<string, unknown>;
  const linkedSplits = typeof obj.linkedSplits === "boolean" ? obj.linkedSplits : true;
  const tabOrder = parseTabOrder(obj.tabOrder);

  let root: PaneNode;
  let focused: number;
  if ("root" in obj) {
    const ctx = {next: 1, seen: new Set<string>(), idMap: new Map<number, number>()};
    const parsed = parseNode(obj.root, 0, ctx);
    if (!parsed || leaves(parsed).length > MAX_PANES) return {...createPaneState(), tabOrder, linkedSplits};
    root = parsed;
    focused = typeof obj.focused === "number" ? ctx.idMap.get(obj.focused) ?? 1 : 1;
  } else {
    ({root, focused} = parseLegacy(obj));
  }
  // linkedSplits is re-applied so a linked 2×2 starts aligned
  return normalizeLinked({root, focused, tabOrder, linkedSplits});
}
