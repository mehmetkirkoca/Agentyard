// Editor presets and display names, free of Node APIs so the renderer can use them

import {baseName} from "./renderer-path";

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

export function presetOf(id: string): EditorPreset {
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
  return program ? baseName(program) : "custom editor";
}
