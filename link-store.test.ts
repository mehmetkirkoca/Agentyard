import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { adoptSidecar, adoptTranscript, inspectTranscript, relinkTranscript } from "./link-store";

// Spy on the real module object: `import * as fs` yields a getter-only copy under esModuleInterop.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const rawFs: typeof fs = require("fs");

const UUID = "11111111-2222-3333-4444-555555555555";

let root: string;
let folder: string;
let central: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "link-store-"));
  folder = path.join(root, "projects", "a");
  central = path.join(root, "central");
  fs.mkdirSync(folder, { recursive: true });
});

afterEach(() => {
  jest.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function writeTranscript(dir: string, withSidecar: boolean): void {
  fs.writeFileSync(path.join(dir, `${UUID}.jsonl`), "line1\nline2\n");
  if (withSidecar) {
    fs.mkdirSync(path.join(dir, UUID, "subagents"), { recursive: true });
    fs.writeFileSync(path.join(dir, UUID, "subagents", "a.jsonl"), "sub");
  }
}

function exdev(): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error("EXDEV: cross-device link not permitted");
  e.code = "EXDEV";
  return e;
}

describe("inspectTranscript", () => {
  it("returns each state", () => {
    fs.mkdirSync(central, { recursive: true });
    expect(inspectTranscript(folder, UUID, central)).toBe("missing");

    const file = path.join(folder, `${UUID}.jsonl`);
    fs.writeFileSync(file, "x");
    expect(inspectTranscript(folder, UUID, central)).toBe("real");
    fs.unlinkSync(file);

    fs.writeFileSync(path.join(central, `${UUID}.jsonl`), "x");
    fs.symlinkSync(path.join(central, `${UUID}.jsonl`), file);
    expect(inspectTranscript(folder, UUID, central)).toBe("link-ok");
    fs.unlinkSync(file);

    fs.writeFileSync(path.join(root, "other.jsonl"), "x");
    fs.symlinkSync(path.join(root, "other.jsonl"), file);
    expect(inspectTranscript(folder, UUID, central)).toBe("link-foreign");
  });
});

describe("adoptTranscript", () => {
  it("moves file and sidecar dir and leaves links", () => {
    writeTranscript(folder, true);
    adoptTranscript(folder, UUID, central);

    const f = path.join(folder, `${UUID}.jsonl`);
    const d = path.join(folder, UUID);
    expect(fs.lstatSync(f).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(d).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(f)).toBe(path.join(central, `${UUID}.jsonl`));
    expect(fs.readlinkSync(d)).toBe(path.join(central, UUID));
    expect(fs.readFileSync(f, "utf8")).toBe("line1\nline2\n");
    expect(fs.readFileSync(path.join(central, UUID, "subagents", "a.jsonl"), "utf8")).toBe("sub");
    expect(fs.lstatSync(path.join(central, `${UUID}.jsonl`)).isFile()).toBe(true);
    expect(inspectTranscript(folder, UUID, central)).toBe("link-ok");
  });

  it("works without a sidecar dir and links an empty central one", () => {
    writeTranscript(folder, false);
    adoptTranscript(folder, UUID, central);
    expect(fs.readlinkSync(path.join(folder, UUID))).toBe(path.join(central, UUID));
    expect(fs.readdirSync(path.join(central, UUID))).toEqual([]);
    expect(inspectTranscript(folder, UUID, central)).toBe("link-ok");
  });

  it("a sidecar created after adoption lands centrally", () => {
    writeTranscript(folder, false);
    adoptTranscript(folder, UUID, central);
    fs.mkdirSync(path.join(folder, UUID, "subagents"), { recursive: true });
    fs.writeFileSync(path.join(folder, UUID, "subagents", "late.jsonl"), "late");
    expect(fs.readFileSync(path.join(central, UUID, "subagents", "late.jsonl"), "utf8")).toBe("late");
  });

  it("removes the central sidecar it created when its link fails", () => {
    writeTranscript(folder, false);
    const real = fs.symlinkSync;
    let calls = 0;
    jest.spyOn(rawFs, "symlinkSync").mockImplementation(((t: string, p: string, type?: any) => {
      if (++calls === 2) throw new Error("EPERM: second");
      return real(t, p, type);
    }) as any);
    expect(() => adoptTranscript(folder, UUID, central)).toThrow(/second/);
    jest.restoreAllMocks();

    expect(fs.lstatSync(path.join(folder, `${UUID}.jsonl`)).isFile()).toBe(true);
    expect(fs.existsSync(path.join(folder, UUID))).toBe(false);
    expect(fs.existsSync(path.join(central, UUID))).toBe(false);
    expect(fs.existsSync(path.join(central, `${UUID}.jsonl`))).toBe(false);
  });

  it("refuses when central already has uuid", () => {
    writeTranscript(folder, false);
    fs.mkdirSync(central, { recursive: true });
    fs.writeFileSync(path.join(central, `${UUID}.jsonl`), "existing");
    expect(() => adoptTranscript(folder, UUID, central)).toThrow(`central already has ${UUID}`);
    const f = path.join(folder, `${UUID}.jsonl`);
    expect(fs.lstatSync(f).isFile()).toBe(true);
    expect(fs.readFileSync(f, "utf8")).toBe("line1\nline2\n");
    expect(fs.readFileSync(path.join(central, `${UUID}.jsonl`), "utf8")).toBe("existing");
  });

  it("refuses when central has only the sidecar dir", () => {
    writeTranscript(folder, false);
    fs.mkdirSync(path.join(central, UUID), { recursive: true });
    expect(() => adoptTranscript(folder, UUID, central)).toThrow(`central already has ${UUID}`);
    expect(fs.lstatSync(path.join(folder, `${UUID}.jsonl`)).isFile()).toBe(true);
  });

  it("refuses when the source is not a real file", () => {
    expect(() => adoptTranscript(folder, UUID, central)).toThrow();
    fs.writeFileSync(path.join(root, "o.jsonl"), "x");
    fs.symlinkSync(path.join(root, "o.jsonl"), path.join(folder, `${UUID}.jsonl`));
    expect(() => adoptTranscript(folder, UUID, central)).toThrow();
    expect(fs.existsSync(path.join(central, `${UUID}.jsonl`))).toBe(false);
  });

  it("falls back to copy-verify-remove on EXDEV", () => {
    writeTranscript(folder, true);
    const spy = jest.spyOn(rawFs, "renameSync").mockImplementation(() => {
      throw exdev();
    });
    adoptTranscript(folder, UUID, central);
    expect(spy).toHaveBeenCalled();
    jest.restoreAllMocks();

    const f = path.join(folder, `${UUID}.jsonl`);
    expect(fs.lstatSync(f).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(folder, UUID)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(f, "utf8")).toBe("line1\nline2\n");
    expect(fs.readFileSync(path.join(central, UUID, "subagents", "a.jsonl"), "utf8")).toBe("sub");
  });

  it("keeps the source when the EXDEV copy fails size verification", () => {
    writeTranscript(folder, false);
    jest.spyOn(rawFs, "renameSync").mockImplementation(() => {
      throw exdev();
    });
    // Simulate a truncated copy.
    jest.spyOn(rawFs, "copyFileSync").mockImplementation((_s, d) => {
      fs.writeFileSync(d as string, "li");
    });
    expect(() => adoptTranscript(folder, UUID, central)).toThrow(/size/);
    jest.restoreAllMocks();
    const f = path.join(folder, `${UUID}.jsonl`);
    expect(fs.lstatSync(f).isFile()).toBe(true);
    expect(fs.readFileSync(f, "utf8")).toBe("line1\nline2\n");
  });

  it("leaves the transcript reachable when symlink creation fails", () => {
    writeTranscript(folder, true);
    jest.spyOn(rawFs, "symlinkSync").mockImplementation(() => {
      throw new Error("EPERM: boom");
    });
    expect(() => adoptTranscript(folder, UUID, central)).toThrow(/EPERM/);
    jest.restoreAllMocks();

    const f = path.join(folder, `${UUID}.jsonl`);
    expect(fs.lstatSync(f).isFile()).toBe(true);
    expect(fs.readFileSync(f, "utf8")).toBe("line1\nline2\n");
    expect(fs.readFileSync(path.join(folder, UUID, "subagents", "a.jsonl"), "utf8")).toBe("sub");
    expect(fs.existsSync(path.join(central, `${UUID}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(central, UUID))).toBe(false);
  });

  it("restores everything when the second symlink fails", () => {
    writeTranscript(folder, true);
    const real = fs.symlinkSync;
    let calls = 0;
    jest.spyOn(rawFs, "symlinkSync").mockImplementation(((t: string, p: string, type?: any) => {
      if (++calls === 2) throw new Error("EPERM: second");
      return real(t, p, type);
    }) as any);
    expect(() => adoptTranscript(folder, UUID, central)).toThrow(/second/);
    jest.restoreAllMocks();

    const f = path.join(folder, `${UUID}.jsonl`);
    expect(fs.lstatSync(f).isFile()).toBe(true);
    expect(fs.lstatSync(path.join(folder, UUID)).isDirectory()).toBe(true);
    expect(fs.readFileSync(f, "utf8")).toBe("line1\nline2\n");
  });
});

describe("adoptTranscript hardening", () => {
  const content = "line1\nline2\n";

  it("restores the file when the sidecar move (not symlink) fails", () => {
    writeTranscript(folder, true);
    const real = rawFs.renameSync;
    jest.spyOn(rawFs, "renameSync").mockImplementation(((a: string, b: string) => {
      if (a === path.join(folder, UUID)) throw new Error("EIO: sidecar");
      return real(a, b);
    }) as any);
    expect(() => adoptTranscript(folder, UUID, central)).toThrow(/sidecar/);
    jest.restoreAllMocks();

    const f = path.join(folder, `${UUID}.jsonl`);
    expect(fs.lstatSync(f).isFile()).toBe(true);
    expect(fs.readFileSync(f, "utf8")).toBe(content);
    expect(fs.existsSync(path.join(central, `${UUID}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(central, UUID))).toBe(false);
    expect(fs.lstatSync(path.join(folder, UUID)).isDirectory()).toBe(true);
  });

  it("rolls back through the EXDEV path when symlink creation fails", () => {
    writeTranscript(folder, true);
    jest.spyOn(rawFs, "renameSync").mockImplementation(() => {
      throw exdev();
    });
    jest.spyOn(rawFs, "symlinkSync").mockImplementation(() => {
      throw new Error("EPERM: boom");
    });
    expect(() => adoptTranscript(folder, UUID, central)).toThrow(/EPERM/);
    jest.restoreAllMocks();

    const f = path.join(folder, `${UUID}.jsonl`);
    expect(fs.lstatSync(f).isFile()).toBe(true);
    expect(fs.readFileSync(f, "utf8")).toBe(content);
    expect(fs.readFileSync(path.join(folder, UUID, "subagents", "a.jsonl"), "utf8")).toBe("sub");
    expect(fs.existsSync(path.join(central, `${UUID}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(central, UUID))).toBe(false);
  });

  it("never overwrites an existing destination during an EXDEV rollback", () => {
    writeTranscript(folder, false);
    const f = path.join(folder, `${UUID}.jsonl`);
    jest.spyOn(rawFs, "renameSync").mockImplementation(() => {
      throw exdev();
    });
    jest.spyOn(rawFs, "symlinkSync").mockImplementation(() => {
      fs.writeFileSync(f, "intruder");
      throw new Error("EPERM: boom");
    });
    expect(() => adoptTranscript(folder, UUID, central)).toThrow(/rollback problems/);
    jest.restoreAllMocks();

    expect(fs.readFileSync(f, "utf8")).toBe("intruder");
    // The verified central copy is kept, so the user's data is not lost.
    expect(fs.readFileSync(path.join(central, `${UUID}.jsonl`), "utf8")).toBe(content);
  });

  it("reverts an EXDEV sidecar move whose source removal fails midway", () => {
    writeTranscript(folder, true);
    jest.spyOn(rawFs, "renameSync").mockImplementation(() => {
      throw exdev();
    });
    const realRm = rawFs.rmSync;
    const srcDir = path.join(folder, UUID);
    jest.spyOn(rawFs, "rmSync").mockImplementation(((p: string, o: any) => {
      if (p === srcDir) {
        realRm(path.join(srcDir, "subagents", "a.jsonl"));
        throw new Error("EBUSY: midway");
      }
      return realRm(p, o);
    }) as any);
    expect(() => adoptTranscript(folder, UUID, central)).toThrow(/midway/);
    jest.restoreAllMocks();

    const f = path.join(folder, `${UUID}.jsonl`);
    expect(fs.lstatSync(f).isFile()).toBe(true);
    expect(fs.readFileSync(f, "utf8")).toBe(content);
    expect(fs.readFileSync(path.join(srcDir, "subagents", "a.jsonl"), "utf8")).toBe("sub");
    expect(fs.existsSync(path.join(central, `${UUID}.jsonl`))).toBe(false);
    expect(fs.existsSync(path.join(central, UUID))).toBe(false);
  });
});

describe("relinkTranscript", () => {
  let other: string;
  beforeEach(() => {
    other = path.join(root, "projects", "b");
  });

  it("moves links between folders", () => {
    writeTranscript(folder, true);
    adoptTranscript(folder, UUID, central);
    relinkTranscript(folder, other, UUID, central);

    expect(fs.existsSync(path.join(folder, `${UUID}.jsonl`))).toBe(false);
    expect(() => fs.lstatSync(path.join(folder, UUID))).toThrow();
    expect(inspectTranscript(other, UUID, central)).toBe("link-ok");
    expect(fs.lstatSync(path.join(other, UUID)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(other, `${UUID}.jsonl`), "utf8")).toBe("line1\nline2\n");
  });

  it("does nothing when folders are equal", () => {
    writeTranscript(folder, false);
    adoptTranscript(folder, UUID, central);
    relinkTranscript(folder, folder, UUID, central);
    expect(inspectTranscript(folder, UUID, central)).toBe("link-ok");
  });

  it("refuses when target has real file", () => {
    writeTranscript(folder, false);
    adoptTranscript(folder, UUID, central);
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, `${UUID}.jsonl`), "precious");
    expect(() => relinkTranscript(folder, other, UUID, central)).toThrow(`target already has ${UUID}`);
    expect(fs.readFileSync(path.join(other, `${UUID}.jsonl`), "utf8")).toBe("precious");
    expect(inspectTranscript(folder, UUID, central)).toBe("link-ok");
  });

  it("refuses when source is a real file", () => {
    writeTranscript(folder, false);
    expect(() => relinkTranscript(folder, other, UUID, central)).toThrow("source is not a link");
    expect(fs.lstatSync(path.join(folder, `${UUID}.jsonl`)).isFile()).toBe(true);
    expect(fs.existsSync(path.join(other, `${UUID}.jsonl`))).toBe(false);
  });

  it("refuses when sidecar source is a real directory", () => {
    writeTranscript(folder, true);
    adoptTranscript(folder, UUID, central);
    fs.unlinkSync(path.join(folder, UUID));
    fs.mkdirSync(path.join(folder, UUID));
    expect(() => relinkTranscript(folder, other, UUID, central)).toThrow("source is not a link");
    expect(inspectTranscript(folder, UUID, central)).toBe("link-ok");
  });

  it("gives the target a central sidecar link when the source has none", () => {
    fs.mkdirSync(central, { recursive: true });
    fs.writeFileSync(path.join(central, `${UUID}.jsonl`), "data");
    fs.symlinkSync(path.join(central, `${UUID}.jsonl`), path.join(folder, `${UUID}.jsonl`));
    relinkTranscript(folder, other, UUID, central);

    expect(inspectTranscript(other, UUID, central)).toBe("link-ok");
    expect(fs.readlinkSync(path.join(other, UUID))).toBe(path.join(central, UUID));
    expect(fs.existsSync(path.join(folder, `${UUID}.jsonl`))).toBe(false);
  });
});

describe("adoptSidecar", () => {
  function linkedTranscript(): void {
    fs.mkdirSync(central, { recursive: true });
    fs.writeFileSync(path.join(central, `${UUID}.jsonl`), "data");
    fs.symlinkSync(path.join(central, `${UUID}.jsonl`), path.join(folder, `${UUID}.jsonl`));
  }

  it("moves a late real sidecar into central and links it", () => {
    linkedTranscript();
    fs.mkdirSync(path.join(folder, UUID, "subagents"), { recursive: true });
    fs.writeFileSync(path.join(folder, UUID, "subagents", "a.jsonl"), "sub");

    adoptSidecar(folder, UUID, central);

    expect(fs.readlinkSync(path.join(folder, UUID))).toBe(path.join(central, UUID));
    expect(fs.readFileSync(path.join(central, UUID, "subagents", "a.jsonl"), "utf8")).toBe("sub");
    expect(inspectTranscript(folder, UUID, central)).toBe("link-ok");
  });

  it("refuses when central already has the sidecar", () => {
    linkedTranscript();
    fs.mkdirSync(path.join(folder, UUID));
    fs.writeFileSync(path.join(folder, UUID, "x"), "mine");
    fs.mkdirSync(path.join(central, UUID));

    expect(() => adoptSidecar(folder, UUID, central)).toThrow(`central already has sidecar ${UUID}`);
    expect(fs.readFileSync(path.join(folder, UUID, "x"), "utf8")).toBe("mine");
  });

  it("refuses when the transcript is not a central link", () => {
    writeTranscript(folder, true);
    expect(() => adoptSidecar(folder, UUID, central)).toThrow("not a central link");
    expect(fs.lstatSync(path.join(folder, UUID)).isDirectory()).toBe(true);
  });

  it("puts the sidecar back when its link fails", () => {
    linkedTranscript();
    fs.mkdirSync(path.join(folder, UUID));
    fs.writeFileSync(path.join(folder, UUID, "x"), "mine");
    jest.spyOn(rawFs, "symlinkSync").mockImplementation(() => {
      throw new Error("EPERM: boom");
    });
    expect(() => adoptSidecar(folder, UUID, central)).toThrow(/EPERM/);
    jest.restoreAllMocks();

    expect(fs.readFileSync(path.join(folder, UUID, "x"), "utf8")).toBe("mine");
    expect(fs.existsSync(path.join(central, UUID))).toBe(false);
  });
});
