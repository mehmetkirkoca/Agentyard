import {execFile} from "child_process";
import {simpleGit, SimpleGit} from "simple-git";

/**
 * Sort branches with main/master appearing first
 */
export function sortBranchesWithMainFirst(branches: string[]): string[] {
  return branches.sort((a, b) => {
    const aIsMainOrMaster = a === 'main' || a === 'master';
    const bIsMainOrMaster = b === 'main' || b === 'master';

    if (aIsMainOrMaster && !bIsMainOrMaster) return -1;
    if (!aIsMainOrMaster && bIsMainOrMaster) return 1;

    return 0;
  });
}

/**
 * Get git branches from a directory, sorted with main/master first
 */
export async function getBranches(dirPath: string): Promise<string[]> {
  try {
    const git = simpleGit(dirPath);
    const branchSummary = await git.branch();
    const branches = branchSummary.all;
    return sortBranchesWithMainFirst(branches);
  } catch (error) {
    console.error("Error getting branches:", error);
    return [];
  }
}

/**
 * Get the current branch of a directory; "" on error or detached HEAD
 */
export async function getCurrentBranch(dirPath: string): Promise<string> {
  try {
    const git = simpleGit(dirPath);
    const branch = (await git.revparse(["--abbrev-ref", "HEAD"])).trim();
    return branch === "HEAD" ? "" : branch;
  } catch (error) {
    console.error(`Error getting current branch for ${dirPath}:`, error);
    return "";
  }
}

// A ref can be named "--output=x" although `git branch` refuses to create one
function assertNotOption(branch: string): void {
  if (branch.startsWith("-")) throw new Error(`Invalid branch name: ${branch}`);
}

/**
 * The patch from a branch to the working tree. Runs without a shell: branch names come from the
 * repository and may hold shell syntax. A repository's own config must not run anything or change
 * the patch, so its external diff and textconv commands stay off.
 */
export async function diffAgainstBranch(dirPath: string, branch: string): Promise<string> {
  assertNotOption(branch);
  return simpleGit(dirPath).raw(["diff", "--no-ext-diff", "--no-textconv", "--end-of-options", branch, "--"]);
}

/**
 * Apply a patch to a directory. It goes through stdin, so it never sits in a shared temp folder.
 */
export function applyPatch(dirPath: string, patch: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["apply"], {cwd: dirPath}, (error) => (error ? reject(error) : resolve()));
    // git may exit before reading everything; its exit code above carries the reason
    child.stdin?.on("error", () => {});
    child.stdin?.end(patch);
  });
}

/**
 * Create a worktree on a new branch started from a parent branch
 */
export async function addWorktree(projectDir: string, branchName: string, worktreePath: string, parentBranch: string): Promise<void> {
  assertNotOption(parentBranch);
  await simpleGit(projectDir).raw(["worktree", "add", "-b", branchName, worktreePath, parentBranch]);
}
