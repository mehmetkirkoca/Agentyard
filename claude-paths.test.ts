import * as os from "os";
import {
  encodeProjectDir,
  claudeProjectFolder,
  appHome,
  centralSessionsDir,
  statusFilePath,
  hookSettingsPath,
} from "./claude-paths";

describe("encodeProjectDir", () => {
  it("replaces every non-alphanumeric character with a dash", () => {
    expect(encodeProjectDir("/home/user/code/acme_deploy")).toBe("-home-user-code-acme-deploy");
    expect(encodeProjectDir("/tmp/claude-1000/-home-x.y")).toBe("-tmp-claude-1000--home-x-y");
  });
});

describe("claude path helpers", () => {
  it("claudeProjectFolder points to ~/.claude/projects/<encoded>", () => {
    expect(claudeProjectFolder("/a/b", "/h")).toBe("/h/.claude/projects/-a-b");
  });

  it("defaults home to os.homedir() when omitted", () => {
    expect(claudeProjectFolder("/a/b")).toBe(`${os.homedir()}/.claude/projects/-a-b`);
    expect(appHome()).toBe(`${os.homedir()}/.agentyard`);
  });

  it("appHome points to <home>/.agentyard", () => {
    expect(appHome("/h")).toBe("/h/.agentyard");
  });

  it("centralSessionsDir points to <home>/.agentyard/sessions", () => {
    expect(centralSessionsDir("/h")).toBe("/h/.agentyard/sessions");
  });

  it("statusFilePath points to <home>/.agentyard/status/<uuid>.jsonl", () => {
    expect(statusFilePath("u1", "/h")).toBe("/h/.agentyard/status/u1.jsonl");
  });

  it("hookSettingsPath points to <home>/.agentyard/hooks/<uuid>.json", () => {
    expect(hookSettingsPath("u1", "/h")).toBe("/h/.agentyard/hooks/u1.json");
  });
});
