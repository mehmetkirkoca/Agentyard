import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  applyModelLines,
  listSlashCommands,
  modelLabel,
  parseCommandDescription,
  parsePermissionMode,
  readSessionModel,
  SessionModel,
} from "./prompt-toolbar";

describe("parsePermissionMode", () => {
  it("reads the mode from Claude Code's footer line", () => {
    expect(parsePermissionMode(["❯ ", "⏵⏵ bypass permissions on (shift+tab to cycle)"])).toBe("bypassPermissions");
    expect(parsePermissionMode(["⏵⏵ accept edits on (shift+tab to cycle)"])).toBe("acceptEdits");
    expect(parsePermissionMode(["⏸ plan mode on (shift+tab to cycle)"])).toBe("plan");
    expect(parsePermissionMode(["⏵⏵ auto mode on"])).toBe("auto");
  });

  it("is manual when no mode line is shown", () => {
    expect(parsePermissionMode(["❯ ", "? for shortcuts", ""])).toBe("manual");
    expect(parsePermissionMode([])).toBe("manual");
  });

  it("uses the lowest matching line, so an echo higher up does not win", () => {
    expect(parsePermissionMode(["plan mode on", "❯ ", "⏵⏵ accept edits on"])).toBe("acceptEdits");
  });
});

describe("modelLabel", () => {
  it("turns model ids into short names", () => {
    expect(modelLabel("claude-opus-5-5")).toBe("Opus 5.5");
    expect(modelLabel("claude-fable-5-1")).toBe("Fable 5.1");
    expect(modelLabel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(modelLabel("claude-haiku-5-5[1m]")).toBe("Haiku 5.5");
  });

  it("keeps unknown ids as they are", () => {
    expect(modelLabel("gpt-x")).toBe("gpt-x");
    expect(modelLabel("")).toBe("");
  });
});

const assistant = (model: string, effort?: string) =>
  JSON.stringify({type: "assistant", message: {model, content: []}, ...(effort ? {effort} : {})});

describe("applyModelLines", () => {
  it("keeps the model and effort of the last assistant entry", () => {
    const m = applyModelLines({size: 0}, [
      assistant("claude-sonnet-5-5", "low"),
      JSON.stringify({type: "user", message: {content: "x"}}),
      assistant("claude-opus-5-5", "high"),
      "{broken",
    ]);
    expect(m).toEqual({size: 0, model: "claude-opus-5-5", effort: "high"});
  });

  it("ignores synthetic entries and keeps the previous effort when a line has none", () => {
    const m = applyModelLines({size: 0, model: "claude-opus-5-5", effort: "medium"}, [
      assistant("<synthetic>"),
      assistant("claude-opus-5-5"),
    ]);
    expect(m).toEqual({size: 0, model: "claude-opus-5-5", effort: "medium"});
  });
});

describe("readSessionModel", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "toolbar-")); });
  afterEach(() => fs.rmSync(dir, {recursive: true, force: true}));

  it("reads complete lines and continues from the previous offset", () => {
    const file = path.join(dir, "s.jsonl");
    fs.writeFileSync(file, assistant("claude-sonnet-5-5", "low") + "\n" + assistant("claude-opus-5-5", "high"));
    const first: SessionModel = readSessionModel(file);
    expect(first.model).toBe("claude-sonnet-5-5");
    fs.appendFileSync(file, "\n");
    const second = readSessionModel(file, first);
    expect(second).toMatchObject({model: "claude-opus-5-5", effort: "high"});
    expect(second.size).toBe(fs.statSync(file).size);
  });

  it("names the file on errors", () => {
    expect(() => readSessionModel(path.join(dir, "yok.jsonl"))).toThrow(/yok\.jsonl/);
  });
});

describe("parseCommandDescription", () => {
  it("takes the frontmatter description", () => {
    expect(parseCommandDescription("---\nname: x\ndescription: Commit mesajı oluştur\n---\nbody")).toBe("Commit mesajı oluştur");
    expect(parseCommandDescription("---\ndescription: \"Quoted\"\n---\n")).toBe("Quoted");
  });

  it("falls back to the first non-empty body line", () => {
    expect(parseCommandDescription("\n# Başlık\nmetin")).toBe("Başlık");
    expect(parseCommandDescription("")).toBe("");
  });
});

describe("listSlashCommands", () => {
  let home: string;
  let project: string;
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, text);
  };
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "home-"));
    project = fs.mkdtempSync(path.join(os.tmpdir(), "proj-"));
  });
  afterEach(() => {
    fs.rmSync(home, {recursive: true, force: true});
    fs.rmSync(project, {recursive: true, force: true});
  });

  it("collects built-ins, user and project commands and skills, and enabled plugins", () => {
    write(path.join(home, ".claude/commands/commit.md"), "---\ndescription: Commit yaz\n---\n");
    write(path.join(home, ".claude/skills/explorer/SKILL.md"), "---\nname: explorer\ndescription: Kodu gez\n---\n");
    fs.mkdirSync(path.join(home, ".claude/skills/no-skill-file"), {recursive: true});
    write(path.join(project, ".claude/commands/deploy.md"), "Deploy et");
    const pluginDir = path.join(home, "plugins/sp");
    write(path.join(pluginDir, "skills/brainstorming/SKILL.md"), "---\ndescription: Fikir\n---\n");
    write(path.join(pluginDir, "commands/plan.md"), "---\ndescription: Plan\n---\n");
    const offDir = path.join(home, "plugins/off");
    write(path.join(offDir, "skills/hidden/SKILL.md"), "---\ndescription: Gizli\n---\n");
    write(path.join(home, ".claude/plugins/installed_plugins.json"), JSON.stringify({
      version: 2,
      plugins: {
        "superpowers@market": [{installPath: pluginDir}],
        "off@market": [{installPath: offDir}],
      },
    }));
    write(path.join(home, ".claude/settings.json"), JSON.stringify({
      enabledPlugins: {"superpowers@market": true, "off@market": false},
    }));

    const commands = listSlashCommands({home, projectDir: project});
    const byName = new Map(commands.map(c => [c.name, c]));
    expect(byName.get("compact")?.source).toBe("built-in");
    expect(byName.get("commit")).toEqual({name: "commit", description: "Commit yaz", source: "user"});
    expect(byName.get("explorer")).toEqual({name: "explorer", description: "Kodu gez", source: "user"});
    expect(byName.get("deploy")).toEqual({name: "deploy", description: "Deploy et", source: "project"});
    expect(byName.get("superpowers:brainstorming")).toEqual({name: "superpowers:brainstorming", description: "Fikir", source: "plugin"});
    expect(byName.get("superpowers:plan")?.source).toBe("plugin");
    expect(byName.has("no-skill-file")).toBe(false);
    expect(byName.has("off:hidden")).toBe(false);
  });

  it("lets a project command override a user command of the same name and works without a project", () => {
    write(path.join(home, ".claude/commands/deploy.md"), "Kullanıcı");
    write(path.join(project, ".claude/commands/deploy.md"), "Proje");
    expect(listSlashCommands({home, projectDir: project}).filter(c => c.name === "deploy"))
      .toEqual([{name: "deploy", description: "Proje", source: "project"}]);
    expect(listSlashCommands({home}).find(c => c.name === "deploy")?.description).toBe("Kullanıcı");
  });
});
