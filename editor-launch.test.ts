import {buildEditorLaunch, EDITOR_PRESETS, editorEnv, editorName, NO_EDITOR_ID, parseCommand} from "./editor-launch";

const only = (...paths: string[]) => (p: string) => paths.includes(p);
const base = {dir: "/work/my app", pathEnv: "/usr/bin:/home/u/bin", platform: "linux", home: "/home/u", customCommand: ""};

describe("presets", () => {
  it("lists VS Code first and gives every preset a command", () => {
    expect(EDITOR_PRESETS[0]).toMatchObject({id: "vscode", name: "VS Code", command: "code"});
    expect(EDITOR_PRESETS.map(p => p.id)).toEqual(
      ["vscode", "cursor", "vscodium", "zed", "sublime", "idea", "webstorm", "phpstorm", "pycharm"]);
    for (const preset of EDITOR_PRESETS) expect(preset.command).toBeTruthy();
  });

  it("names the selected editor; custom uses its program name", () => {
    expect(editorName("cursor", "")).toBe("Cursor");
    expect(editorName("custom", "/usr/bin/kate --new {dir}")).toBe("kate");
    expect(editorName("custom", "  ")).toBe("custom editor");
    expect(editorName("nope", "")).toBe("VS Code");
  });
});

describe("buildEditorLaunch: presets", () => {
  it("prefers the command on PATH and passes the directory as one argument", () => {
    const launch = buildEditorLaunch({...base, editorId: "vscode", exists: only("/home/u/bin/code", "/snap/bin/code")});
    expect(launch).toEqual({ok: true, file: "/home/u/bin/code", args: ["/work/my app"]});
  });

  it("falls back to the usual install places, ~ included (app started from the desktop)", () => {
    expect(buildEditorLaunch({...base, editorId: "vscode", exists: only("/snap/bin/code")}))
      .toEqual({ok: true, file: "/snap/bin/code", args: ["/work/my app"]});
    expect(buildEditorLaunch({...base, editorId: "zed", exists: only("/home/u/.local/bin/zed")}))
      .toEqual({ok: true, file: "/home/u/.local/bin/zed", args: ["/work/my app"]});
    const mac = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
    expect(buildEditorLaunch({...base, platform: "darwin", editorId: "vscode", exists: only(mac)}))
      .toEqual({ok: true, file: mac, args: ["/work/my app"]});
  });

  it("says which editor is missing", () => {
    expect(buildEditorLaunch({...base, editorId: "cursor", exists: only()}))
      .toEqual({ok: false, error: "Cursor (cursor) was not found"});
  });

  it("treats an unknown editor id as VS Code", () => {
    expect(buildEditorLaunch({...base, editorId: "gone", exists: only("/usr/bin/code")}))
      .toEqual({ok: true, file: "/usr/bin/code", args: ["/work/my app"]});
  });
});

describe("buildEditorLaunch: custom", () => {
  const custom = (customCommand: string, exists = only("/usr/bin/kate", "/opt/my editor/run")) =>
    buildEditorLaunch({...base, editorId: "custom", customCommand, exists});

  it("puts the directory where {dir} is, without splitting it", () => {
    expect(custom("kate --new {dir}")).toEqual({ok: true, file: "/usr/bin/kate", args: ["--new", "/work/my app"]});
    expect(custom("kate --path={dir}")).toEqual({ok: true, file: "/usr/bin/kate", args: ["--path=/work/my app"]});
  });

  it("appends the directory when there is no {dir}", () => {
    expect(custom("kate -n")).toEqual({ok: true, file: "/usr/bin/kate", args: ["-n", "/work/my app"]});
  });

  it("accepts an absolute program path with spaces when quoted", () => {
    expect(custom(`"/opt/my editor/run" {dir}`)).toEqual({ok: true, file: "/opt/my editor/run", args: ["/work/my app"]});
  });

  it("reports an empty command and a missing program", () => {
    expect(custom("   ")).toEqual({ok: false, error: "Set a custom editor command in Settings"});
    expect(custom("nvim-qt {dir}")).toEqual({ok: false, error: "nvim-qt was not found"});
  });
});

describe("buildEditorLaunch: turned off", () => {
  it("opens nothing when the button is turned off in Settings", () => {
    expect(NO_EDITOR_ID).toBe("none");
    expect(buildEditorLaunch({...base, editorId: NO_EDITOR_ID, exists: only("/usr/bin/code")}))
      .toEqual({ok: false, error: "The editor button is turned off in Settings"});
  });
});

describe("parseCommand", () => {
  it("splits on spaces and keeps quoted parts together", () => {
    expect(parseCommand(`a  'b c' "d e" f`)).toEqual(["a", "b c", "d e", "f"]);
    expect(parseCommand("")).toEqual([]);
  });

  it("takes an unterminated quote to the end", () => {
    expect(parseCommand(`a "b c`)).toEqual(["a", "b c"]);
  });
});

describe("editorEnv", () => {
  it("drops this app's Electron variables so an Electron editor starts as itself", () => {
    const env = editorEnv({PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1", ELECTRON_NO_ATTACH_CONSOLE: "1", HOME: "/h"});
    expect(env).toEqual({PATH: "/usr/bin", HOME: "/h"});
  });
});
