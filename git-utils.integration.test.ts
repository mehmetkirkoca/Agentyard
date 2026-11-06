import {execFileSync} from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {addWorktree, applyPatch, diffAgainstBranch} from "./git-utils";

// Real git and real simple-git: these guard what a hostile branch name can do
describe("git operations on hostile branch names", () => {
  let repo: string;
  const git = (...args: string[]) => execFileSync("git", args, {cwd: repo, encoding: "utf8", stdio: "pipe"});

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "agentyard-git-"));
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    fs.writeFileSync(path.join(repo, "a.txt"), "one\n");
    git("add", ".");
    git("commit", "-qm", "init");
  });

  afterEach(() => {
    fs.rmSync(repo, {recursive: true, force: true});
  });

  it("diffs against a branch whose name is a shell payload without running it", async () => {
    const canary = path.join(repo, "canary");
    const branch = `$(touch\${IFS}${canary})`;
    git("branch", branch);
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");

    const patch = await diffAgainstBranch(repo, branch);

    expect(fs.existsSync(canary)).toBe(false);
    expect(patch).toContain("+two");
    expect(patch.endsWith("\n")).toBe(true);
  });

  it("does not run a diff.external command from the repository's config", async () => {
    const canary = path.join(repo, "canary");
    const script = path.join(repo, "external-diff.sh");
    fs.writeFileSync(script, `#!/bin/sh\ntouch '${canary}'\n`, {mode: 0o755});
    git("config", "diff.external", script);
    const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");

    const patch = await diffAgainstBranch(repo, branch);

    expect(fs.existsSync(canary)).toBe(false);
    expect(patch).toContain("+two");
  });

  it("applies a patch from stdin to another checkout", async () => {
    const branch = git("rev-parse", "--abbrev-ref", "HEAD").trim();
    fs.writeFileSync(path.join(repo, "a.txt"), "two\n");
    const patch = await diffAgainstBranch(repo, branch);
    git("checkout", "--", "a.txt");

    await applyPatch(repo, patch);

    expect(fs.readFileSync(path.join(repo, "a.txt"), "utf8")).toBe("two\n");
  });

  it("rejects a patch that does not apply, keeping git's message", async () => {
    await expect(applyPatch(repo, "not a patch\n")).rejects.toThrow(/git apply|patch/i);
  });

  it("refuses to diff against a branch name that reads as an option", async () => {
    git("update-ref", "refs/heads/--output=pwned", "HEAD");
    await expect(diffAgainstBranch(repo, "--output=pwned")).rejects.toThrow(/invalid branch name/i);
    expect(fs.existsSync(path.join(repo, "pwned"))).toBe(false);
  });

  it("creates a worktree from a regular parent branch", async () => {
    const worktree = path.join(repo, "wt");
    await addWorktree(repo, "feature", worktree, "HEAD");
    expect(fs.existsSync(path.join(worktree, "a.txt"))).toBe(true);
    expect(git("branch", "--list", "feature")).toContain("feature");
  });

  it("refuses a worktree whose parent branch reads as an option", async () => {
    git("update-ref", "refs/heads/--lock", "HEAD");
    const worktree = path.join(repo, "wt");
    await expect(addWorktree(repo, "feature", worktree, "--lock")).rejects.toThrow(/invalid branch name/i);
    expect(fs.existsSync(worktree)).toBe(false);
  });
});
