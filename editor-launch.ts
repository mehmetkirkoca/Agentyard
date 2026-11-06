// Opening a session's directory in the user's editor (pane breadcrumb button, editor in Settings)

import * as path from "path";
import {CUSTOM_EDITOR_ID, EditorPreset, NO_EDITOR_ID, parseCommand, presetOf} from "./editor-presets";
export * from "./editor-presets";

// A program path is taken as is; a bare name is looked up on PATH, then in the fallback places
function resolveProgram(program: string, fallbacks: string[], pathEnv: string | undefined, exists: (p: string) => boolean): string | null {
  if (program.includes("/")) return exists(program) ? program : null;
  const onPath = (pathEnv ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, program));
  return [...onPath, ...fallbacks].find(exists) ?? null;
}

export interface EditorLaunchInput {
  editorId: string;
  customCommand: string;
  dir: string;
  pathEnv: string | undefined;
  platform: string;
  home: string;
  exists: (p: string) => boolean;
}

export type EditorLaunch = {ok: true; file: string; args: string[]} | {ok: false; error: string};

// Program and arguments to run without a shell, so a directory with spaces or quotes stays one argument
export function buildEditorLaunch(input: EditorLaunchInput): EditorLaunch {
  const {editorId, customCommand, dir, pathEnv, platform, home, exists} = input;
  if (editorId === NO_EDITOR_ID) return {ok: false, error: "The editor button is turned off in Settings"};
  if (editorId === CUSTOM_EDITOR_ID) {
    const [program, ...rest] = parseCommand(customCommand);
    if (!program) return {ok: false, error: "Set a custom editor command in Settings"};
    const file = resolveProgram(program, [], pathEnv, exists);
    if (!file) return {ok: false, error: `${program} was not found`};
    const hasDir = rest.some(arg => arg.includes("{dir}"));
    const args = hasDir ? rest.map(arg => arg.split("{dir}").join(dir)) : [...rest, dir];
    return {ok: true, file, args};
  }
  const preset = presetOf(editorId);
  const fallbacks = (preset.paths[platform] ?? []).map(p => (p.startsWith("~/") ? path.join(home, p.slice(2)) : p));
  const file = resolveProgram(preset.command, fallbacks, pathEnv, exists);
  if (!file) return {ok: false, error: `${preset.name} (${preset.command}) was not found`};
  return {ok: true, file, args: [dir]};
}

// Electron editors (VS Code, Cursor, VSCodium): this app's ELECTRON_* variables (e.g.
// ELECTRON_RUN_AS_NODE) would change how they start; harmless to drop for the others
export function editorEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("ELECTRON_")));
}
