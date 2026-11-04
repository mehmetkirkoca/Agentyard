// Opening a session's directory in the user's editor (pane breadcrumb button, editor in Settings)

import * as path from "path";

export interface EditorPreset {
  id: string;
  name: string;
  command: string;
  // Usual install places, for an app started from the desktop whose PATH lacks them; ~ = home
  paths: Record<string, string[]>;
}

export const DEFAULT_EDITOR_ID = "vscode";
export const CUSTOM_EDITOR_ID = "custom";
// "None" in Settings: the breadcrumb shows no editor button
export const NO_EDITOR_ID = "none";

export const EDITOR_PRESETS: EditorPreset[] = [
  {id: "vscode", name: "VS Code", command: "code", paths: {
    linux: ["/snap/bin/code", "/usr/bin/code", "/usr/local/bin/code", "/usr/share/code/bin/code"],
    darwin: ["/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", "/usr/local/bin/code", "/opt/homebrew/bin/code"],
  }},
  {id: "cursor", name: "Cursor", command: "cursor", paths: {
    linux: ["/usr/bin/cursor", "/usr/local/bin/cursor", "/opt/cursor/cursor", "~/.local/bin/cursor"],
    darwin: ["/Applications/Cursor.app/Contents/Resources/app/bin/cursor", "/usr/local/bin/cursor"],
  }},
  {id: "vscodium", name: "VSCodium", command: "codium", paths: {
    linux: ["/snap/bin/codium", "/usr/bin/codium", "/usr/local/bin/codium"],
    darwin: ["/Applications/VSCodium.app/Contents/Resources/app/bin/codium", "/usr/local/bin/codium", "/opt/homebrew/bin/codium"],
  }},
  {id: "zed", name: "Zed", command: "zed", paths: {
    linux: ["~/.local/bin/zed", "/usr/bin/zed", "/usr/local/bin/zed"],
    darwin: ["/Applications/Zed.app/Contents/MacOS/cli", "/usr/local/bin/zed", "/opt/homebrew/bin/zed"],
  }},
  {id: "sublime", name: "Sublime Text", command: "subl", paths: {
    linux: ["/snap/bin/subl", "/usr/bin/subl", "/opt/sublime_text/sublime_text"],
    darwin: ["/Applications/Sublime Text.app/Contents/SharedSupport/bin/subl", "/usr/local/bin/subl"],
  }},
  {id: "idea", name: "IntelliJ IDEA", command: "idea", paths: {
    linux: ["/snap/bin/intellij-idea-ultimate", "/snap/bin/intellij-idea-community", "~/.local/share/JetBrains/Toolbox/scripts/idea"],
    darwin: ["/usr/local/bin/idea", "~/Library/Application Support/JetBrains/Toolbox/scripts/idea"],
  }},
  {id: "webstorm", name: "WebStorm", command: "webstorm", paths: {
    linux: ["/snap/bin/webstorm", "~/.local/share/JetBrains/Toolbox/scripts/webstorm"],
    darwin: ["/usr/local/bin/webstorm", "~/Library/Application Support/JetBrains/Toolbox/scripts/webstorm"],
  }},
  {id: "phpstorm", name: "PhpStorm", command: "phpstorm", paths: {
    linux: ["/snap/bin/phpstorm", "~/.local/share/JetBrains/Toolbox/scripts/phpstorm"],
    darwin: ["/usr/local/bin/phpstorm", "~/Library/Application Support/JetBrains/Toolbox/scripts/phpstorm"],
  }},
  {id: "pycharm", name: "PyCharm", command: "pycharm", paths: {
    linux: ["/snap/bin/pycharm-professional", "/snap/bin/pycharm-community", "~/.local/share/JetBrains/Toolbox/scripts/pycharm"],
    darwin: ["/usr/local/bin/pycharm", "~/Library/Application Support/JetBrains/Toolbox/scripts/pycharm"],
  }},
];

function presetOf(id: string): EditorPreset {
  return EDITOR_PRESETS.find(p => p.id === id) ?? EDITOR_PRESETS[0];
}

// Shell-like split without a shell: spaces separate, '…' and "…" keep a part together
export function parseCommand(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let inPart = false;
  let quote: string | null = null;
  for (const ch of command) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === "'" || ch === "\"") {
      quote = ch;
      inPart = true;
    } else if (/\s/.test(ch)) {
      if (inPart) parts.push(current);
      current = "";
      inPart = false;
    } else {
      current += ch;
      inPart = true;
    }
  }
  if (inPart) parts.push(current);
  return parts;
}

export function editorName(editorId: string, customCommand: string): string {
  if (editorId !== CUSTOM_EDITOR_ID) return presetOf(editorId).name;
  const program = parseCommand(customCommand)[0];
  return program ? path.basename(program) : "custom editor";
}

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
