import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {ensurePrivateDir, writePrivateFile} from "./private-files";

describe("private files", () => {
  let root: string;
  const modeOf = (p: string) => fs.statSync(p).mode & 0o777;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "agentyard-private-"));
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  it("creates a missing folder for the owner only", () => {
    const dir = path.join(root, "new");
    ensurePrivateDir(dir);
    expect(modeOf(dir)).toBe(0o700);
  });

  it("tightens a folder that already exists", () => {
    const dir = path.join(root, "open");
    fs.mkdirSync(dir, {mode: 0o775});
    fs.chmodSync(dir, 0o775);
    ensurePrivateDir(dir);
    expect(modeOf(dir)).toBe(0o700);
  });

  it("writes a new file for the owner only", () => {
    const file = path.join(root, "secret.json");
    writePrivateFile(file, "{}");
    expect(modeOf(file)).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toBe("{}");
  });

  it("tightens a file that already exists when rewriting it", () => {
    const file = path.join(root, "secret.json");
    fs.writeFileSync(file, "old", {mode: 0o664});
    fs.chmodSync(file, 0o664);
    writePrivateFile(file, Buffer.from("new"));
    expect(modeOf(file)).toBe(0o600);
    expect(fs.readFileSync(file, "utf8")).toBe("new");
  });
});
