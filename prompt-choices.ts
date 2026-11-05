// Model, effort and permission-mode choices and their parsers, free of Node APIs for the renderer

/** Claude Code permission modes, as --permission-mode names them. */
export type PermissionMode = "manual" | "acceptEdits" | "plan" | "auto" | "bypassPermissions" | "dontAsk";

/** Modes offered in the toolbar menu, in Shift+Tab order of the footer text Claude Code shows. */
export const PERMISSION_MODES: {mode: PermissionMode; label: string; icon: string}[] = [
  {mode: "manual", label: "Manual", icon: "✋"},
  {mode: "acceptEdits", label: "Accept edits", icon: "✎"},
  {mode: "plan", label: "Plan", icon: "⏸"},
  {mode: "auto", label: "Auto", icon: "⏵"},
  {mode: "bypassPermissions", label: "Bypass", icon: "⏵⏵"},
];

const MODE_FOOTERS: [RegExp, PermissionMode][] = [
  [/bypass permissions on/i, "bypassPermissions"],
  [/accept edits on/i, "acceptEdits"],
  [/plan mode on/i, "plan"],
  [/auto mode on/i, "auto"],
  [/don'?t ask (mode )?on/i, "dontAsk"],
];

/**
 * The permission mode shown in Claude Code's footer (the last lines of the terminal).
 * The lowest matching line wins; no mode line means manual.
 */
export function parsePermissionMode(lines: string[]): PermissionMode {
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const [pattern, mode] of MODE_FOOTERS) {
      if (pattern.test(lines[i])) return mode;
    }
  }
  return "manual";
}

/** Models offered in the toolbar menu; the alias is what /model takes. */
export const MODEL_CHOICES: {alias: string; label: string}[] = [
  {alias: "fable", label: "Fable 5.1"},
  {alias: "opus", label: "Opus 5.5"},
  {alias: "sonnet", label: "Sonnet 5.5"},
  {alias: "haiku", label: "Haiku 5.5"},
];

/** Gemini CLI model aliases (what `/model set` and `-m` take); Gemini resolves them to a concrete model. */
export const GEMINI_MODEL_CHOICES: {alias: string; label: string}[] = [
  {alias: "auto", label: "Auto"},
  {alias: "pro", label: "Pro"},
  {alias: "flash", label: "Flash"},
  {alias: "flash-lite", label: "Flash Lite"},
];

/** Gemini CLI approval modes, as --approval-mode names them. */
export type GeminiApprovalMode = "default" | "auto_edit" | "plan" | "yolo";

/** Modes offered in the toolbar menu: Shift+Tab cycles the first three, Ctrl+Y toggles YOLO. */
export const GEMINI_PERMISSION_MODES: {mode: GeminiApprovalMode; label: string; icon: string}[] = [
  {mode: "default", label: "Default", icon: "✋"},
  {mode: "auto_edit", label: "Auto edit", icon: "✎"},
  {mode: "plan", label: "Plan", icon: "⏸"},
  {mode: "yolo", label: "YOLO", icon: "⏵⏵"},
];

// The mode line above Gemini CLI's input box starts with the mode name, then the key hint for the
// next one; anchored at the line start so text typed in the input box below never matches
const GEMINI_MODE_FOOTERS: [RegExp, GeminiApprovalMode][] = [
  [/^\s*YOLO\s+Ctrl\+Y\b/i, "yolo"],
  [/^\s*auto-accept edits\s+Shift\+Tab to/i, "auto_edit"],
  [/^\s*plan\s+Shift\+Tab to manual/i, "plan"],
  [/^\s*Shift\+Tab to accept edits/i, "default"],
];

/**
 * The approval mode shown on Gemini CLI's mode line (the last lines of the terminal). The lowest
 * matching line wins; undefined when no mode line is on screen (e.g. while a dialog is open).
 */
export function parseGeminiApprovalMode(lines: string[]): GeminiApprovalMode | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const [pattern, mode] of GEMINI_MODE_FOOTERS) {
      if (pattern.test(lines[i])) return mode;
    }
  }
  return undefined;
}

/**
 * Next key toward `target` from `current`: Ctrl+Y toggles YOLO (and leaves it for default),
 * Shift+Tab cycles default -> auto_edit -> plan -> default. Null when already there.
 */
export function geminiModeKey(current: GeminiApprovalMode, target: GeminiApprovalMode): "\x19" | "\x1b[Z" | null {
  if (current === target) return null;
  if (current === "yolo" || target === "yolo") return "\x19";
  return "\x1b[Z";
}

export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

/** "claude-opus-5-5" -> "Opus 5.5"; unknown ids are returned unchanged. */
export function modelLabel(id: string): string {
  const geminiAlias = GEMINI_MODEL_CHOICES.find(c => c.alias === id);
  if (geminiAlias) return geminiAlias.label;
  // "gemini-3.5-flash-lite" -> "Gemini 3.5 Flash Lite"
  if (id.toLowerCase().startsWith("gemini")) {
    return id
      .split("-")
      .map(part => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  const match = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id);
  if (!match) return id;
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  return `${family} ${match[2]}.${match[3]}`;
}

export interface SlashCommand {
  name: string;
  description: string;
  source: "built-in" | "user" | "project" | "plugin";
}
