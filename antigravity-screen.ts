/** agy's execution modes, in its Shift+Tab order. */
export type AgyMode = "default" | "accept-edits" | "plan";

export const AGY_MODES: {mode: AgyMode; label: string; icon: string}[] = [
  {mode: "default", label: "Default", icon: "✋"},
  {mode: "accept-edits", label: "Accept edits", icon: "✎"},
  {mode: "plan", label: "Plan", icon: "⏸"},
];

export const AGY_EFFORTS = ["low", "medium", "high"];

// The right end of agy's last footer row: "[accept-edits · |plan · ]<Model name> · <effort>", set
// off from the hints on its left ("? for shortcuts", "esc to cancel") by a run of spaces. The model
// name starts with a letter and has no run of spaces, so neither the hint nor a prompt echo ("> …")
// is taken for it.
const FOOTER_RE = /(?:^|\s{2,})(?:(accept-edits|plan) · )?([A-Za-z](?:[^·\s]| (?! ))*?) · (low|medium|high)\s*$/;

/** Mode, model and effort from agy's footer (the last lines of the screen); the lowest match wins. */
export function parseAgyFooter(lines: string[]): {mode: AgyMode; model: string; effort: string} | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = FOOTER_RE.exec(lines[i]);
    if (match) return {mode: (match[1] as AgyMode | undefined) ?? "default", model: match[2].trim(), effort: match[3]};
  }
  return undefined;
}

/** A model family: `/model <base>-<effort>` selects it with one of its efforts. */
export interface AgyModelFamily {
  base: string;
  label: string;
  efforts: string[];
}

// One row of `agy models`: "<id>-<effort>\t<Label> (<Effort>)"
const MODEL_ROW_RE = /^([a-z0-9.-]+?)-(low|medium|high)\t(.+?) \((?:Low|Medium|High)\)\s*$/;

/** Families from `agy models` output, in its order, each with its efforts low → high. */
export function groupAgyModels(output: string): AgyModelFamily[] {
  const families = new Map<string, AgyModelFamily>();
  for (const line of output.split("\n")) {
    const match = MODEL_ROW_RE.exec(line.trim());
    if (!match) continue;
    const [, base, effort, label] = match;
    const family = families.get(base) ?? {base, label, efforts: []};
    if (!family.efforts.includes(effort)) family.efforts.push(effort);
    families.set(base, family);
  }
  for (const family of families.values()) {
    family.efforts.sort((a, b) => AGY_EFFORTS.indexOf(a) - AGY_EFFORTS.indexOf(b));
  }
  return [...families.values()];
}

/** The families agy 1.4.12 offers, for when `agy models` cannot be read. */
export const AGY_FALLBACK_MODELS: AgyModelFamily[] = [
  {base: "gemini-4-argon", label: "Gemini 4 Argon", efforts: ["low", "medium", "high"]},
  {base: "gemini-3.8-flash", label: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"]},
  {base: "claude-opus-5-5", label: "Claude Opus 5.5", efforts: ["low", "medium", "high"]},
  {base: "claude-sonnet-5-5", label: "Claude Sonnet 5.5", efforts: ["low", "medium", "high"]},
  {base: "gpt-oss-120b", label: "GPT-OSS 120B", efforts: ["medium"]},
];

/** The /model command for a family, keeping the current effort when the family offers it. */
export function agyModelCommand(family: AgyModelFamily, effort: string): string {
  const chosen = family.efforts.includes(effort) ? effort : (family.efforts.includes("medium") ? "medium" : family.efforts[0]);
  return `/model ${family.base}-${chosen}`;
}

/** Efforts the effort menu offers for the current model: its family's, or all when it is not known. */
export function agyEffortsFor(families: AgyModelFamily[], modelLabel: string | undefined): string[] {
  return families.find(f => f.label === modelLabel)?.efforts ?? AGY_EFFORTS;
}
