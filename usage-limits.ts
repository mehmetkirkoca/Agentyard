/** One usage window of an AI tool's account: how much of it is used, and when it starts over. */
export interface LimitWindow {
  usedPercent: number;
  /** epoch ms; unknown when the tool does not say */
  resetsAt?: number;
}

/** A tool's account limits as last read. Account-wide: every session of the tool shares them. */
export interface ToolLimits {
  tool: "claude";
  /** epoch ms of the reading */
  readAt: number;
  fiveHour?: LimitWindow;
  week?: LimitWindow;
}

/** A reading older than this shows grey: the tool may have been used elsewhere since. */
export const STALE_AFTER_MS = 30 * 60_000;

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

function epochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function limitWindow(value: unknown): LimitWindow | undefined {
  if (!isObj(value) || typeof value.used_percentage !== "number" || !Number.isFinite(value.used_percentage)) return undefined;
  const window: LimitWindow = {usedPercent: Math.min(100, Math.max(0, value.used_percentage))};
  const resetsAt = epochMs(value.resets_at);
  if (resetsAt !== undefined) window.resetsAt = resetsAt;
  return window;
}

/**
 * Claude Code's status line JSON (what it passes on stdin to the statusLine command): its
 * `rate_limits.five_hour` and `rate_limits.seven_day`. Undefined when neither window is usable.
 */
export function parseClaudeLimits(text: string, readAt: number): ToolLimits | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const rateLimits = isObj(json) ? json.rate_limits : undefined;
  if (!isObj(rateLimits)) return undefined;
  const fiveHour = limitWindow(rateLimits.five_hour);
  const week = limitWindow(rateLimits.seven_day);
  if (!fiveHour && !week) return undefined;
  return {tool: "claude", readAt, ...(fiveHour ? {fiveHour} : {}), ...(week ? {week} : {})};
}

export type LimitLevel = "ok" | "warn" | "high";

/** Bar colour: below 50% ok, below 80% warn, from 80% high. */
export function limitLevel(percent: number): LimitLevel {
  return percent >= 80 ? "high" : percent >= 50 ? "warn" : "ok";
}

/**
 * What a window's bar shows now: "reset" once its reset time has passed (the reading no longer
 * holds), "stale" for an old reading, else "live".
 */
export function windowView(window: LimitWindow, readAt: number, now: number): {state: "live" | "stale" | "reset"; level: LimitLevel; percent: number} {
  if (window.resetsAt !== undefined && now >= window.resetsAt) return {state: "reset", level: "ok", percent: 0};
  const state = now - readAt > STALE_AFTER_MS ? "stale" : "live";
  return {state, level: limitLevel(window.usedPercent), percent: window.usedPercent};
}

/** "1h 20m", "25m", "<1m", "2d 3h"; "now" once passed */
export function formatResetIn(resetsAt: number, now: number): string {
  const minutes = Math.floor((resetsAt - now) / 60_000);
  if (resetsAt <= now) return "now";
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** "just now", "2m ago", "3h ago", "2d ago" */
export function formatAgo(timestamp: number, now: number): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
