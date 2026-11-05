import * as fs from "fs";
import * as path from "path";
import {baseName, samePath} from "./renderer-path";

describe("baseName", () => {
  it("takes the last segment of a POSIX path", () => {
    expect(baseName("/a/b")).toBe("b");
  });

  it("takes the last segment of a Windows path", () => {
    expect(baseName("C:\\a\\b")).toBe("b");
  });

  it("ignores trailing separators", () => {
    expect(baseName("/a/b/")).toBe("b");
    expect(baseName("C:\\a\\b\\")).toBe("b");
  });

  it("returns a bare name unchanged", () => {
    expect(baseName("repo")).toBe("repo");
  });
});

describe("samePath", () => {
  it("ignores a trailing separator", () => {
    expect(samePath("/a/b/", "/a/b")).toBe(true);
  });

  it("tells different paths apart", () => {
    expect(samePath("/a/b", "/a/c")).toBe(false);
  });

  it("treats both separators alike", () => {
    expect(samePath("C:\\a\\b", "C:/a/b/")).toBe(true);
  });
});

// The renderer will run without Node, so every module it pulls in must be free of Node APIs
describe("renderer import graph", () => {
  const NODE_IMPORT = /(?:from\s+|require\()\s*["'](fs|os|path|child_process|electron|node:[a-z_/]+)["']/;
  const LOCAL_IMPORT = /(?:from\s+|require\()\s*["'](\.\/[^"']+)["']/g;

  function localImports(file: string): string[] {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    return [...source.matchAll(LOCAL_IMPORT)].map(m => `${m[1].replace(/^\.\//, "")}.ts`);
  }

  function reachable(entry: string): string[] {
    const seen = new Set<string>();
    const queue = localImports(entry);
    while (queue.length > 0) {
      const file = queue.pop() as string;
      if (seen.has(file)) continue;
      seen.add(file);
      queue.push(...localImports(file));
    }
    return [...seen].sort();
  }

  const modules = reachable("renderer.ts");

  it("finds the modules renderer.ts imports", () => {
    expect(modules).toEqual(expect.arrayContaining(["attach-paste.ts", "editor-presets.ts", "project-constants.ts", "prompt-choices.ts"]));
  });

  it.each(modules)("%s does not import a Node module", file => {
    const source = fs.readFileSync(path.join(__dirname, file), "utf8");
    const offending = source.split("\n").filter(line => NODE_IMPORT.test(line) && !/^\s*import\s+type\b/.test(line));
    expect(offending).toEqual([]);
  });
});
