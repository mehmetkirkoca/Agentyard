import * as fs from "fs";
import * as path from "path";

export type LinkState = "missing" | "real" | "link-ok" | "link-foreign";

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`failed to inspect ${p}: ${(err as Error).message}`);
  }
}

function dirStats(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.lstatSync(p);
    if (st.isDirectory()) {
      const sub = dirStats(p);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += st.size;
    }
  }
  return { files, bytes };
}

function sameStats(a: string, b: string, isDir: boolean): string | null {
  if (isDir) {
    const x = dirStats(a);
    const y = dirStats(b);
    if (x.files !== y.files || x.bytes !== y.bytes) {
      return `mismatch (${x.files} files/${x.bytes} bytes vs ${y.files} files/${y.bytes} bytes)`;
    }
    return null;
  }
  const x = fs.lstatSync(a).size;
  const y = fs.lstatSync(b).size;
  return x === y ? null : `size mismatch (${x} vs ${y})`;
}

function isExists(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "EEXIST" || code === "ERR_FS_CP_EEXIST";
}

/**
 * Move a file or directory. rename first; on EXDEV copy, verify, then remove
 * the source. The source is never removed before the copy is verified, a
 * pre-existing dst is never touched, and a failed move leaves src complete.
 */
function moveEntry(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") {
      throw new Error(`failed to move ${src} to ${dst}: ${(err as Error).message}`);
    }
  }

  if (lstatOrNull(dst)) {
    throw new Error(`failed to copy ${src} to ${dst}: destination already exists`);
  }
  const isDir = fs.lstatSync(src).isDirectory();
  try {
    if (isDir) {
      fs.cpSync(src, dst, {
        recursive: true,
        errorOnExist: true,
        force: false,
        verbatimSymlinks: true,
      });
    } else {
      fs.copyFileSync(src, dst, fs.constants.COPYFILE_EXCL);
    }
    const problem = sameStats(src, dst, isDir);
    if (problem) throw new Error(`verification failed: ${problem}`);
  } catch (err) {
    // Remove only a copy we created; never a destination that already existed.
    if (!isExists(err)) {
      try {
        fs.rmSync(dst, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    throw new Error(`failed to copy ${src} to ${dst}: ${(err as Error).message}`);
  }
  try {
    fs.rmSync(src, { recursive: true });
  } catch (err) {
    // Source may be partially deleted: refill it from the verified copy, and
    // only drop the copy once the source is whole again.
    try {
      if (isDir) {
        fs.cpSync(dst, src, {
          recursive: true,
          force: false,
          errorOnExist: false,
          verbatimSymlinks: true,
        });
      }
      const problem = sameStats(dst, src, isDir);
      if (problem) throw new Error(problem);
      fs.rmSync(dst, { recursive: true, force: true });
    } catch (restoreErr) {
      throw new Error(
        `copied ${src} to ${dst} but failed to remove source (${(err as Error).message}) ` +
          `and to restore it (${(restoreErr as Error).message}); verified copy kept at ${dst}`
      );
    }
    throw new Error(`failed to remove source ${src}, move reverted: ${(err as Error).message}`);
  }
}

export function inspectTranscript(folder: string, uuid: string, centralDir: string): LinkState {
  centralDir = path.resolve(centralDir);
  const file = path.join(folder, `${uuid}.jsonl`);
  const st = lstatOrNull(file);
  if (!st) return "missing";
  if (!st.isSymbolicLink()) return "real";
  let target: string;
  try {
    target = fs.readlinkSync(file);
  } catch (err) {
    throw new Error(`failed to read link ${file}: ${(err as Error).message}`);
  }
  const resolved = path.resolve(folder, target);
  return resolved === path.join(centralDir, `${uuid}.jsonl`) ? "link-ok" : "link-foreign";
}

/**
 * Move <uuid>.jsonl (and <uuid>/ if present) into centralDir and leave
 * absolute symlinks behind. On failure the original layout is restored.
 * Only call this for sessions that are not currently running: Claude Code may
 * be appending to the transcript.
 */
export function adoptTranscript(folder: string, uuid: string, centralDir: string): void {
  centralDir = path.resolve(centralDir);
  const srcFile = path.join(folder, `${uuid}.jsonl`);
  const srcDir = path.join(folder, uuid);
  const dstFile = path.join(centralDir, `${uuid}.jsonl`);
  const dstDir = path.join(centralDir, uuid);

  const fileSt = lstatOrNull(srcFile);
  if (!fileSt || !fileSt.isFile()) {
    throw new Error(`not a real transcript file: ${srcFile}`);
  }
  const dirSt = lstatOrNull(srcDir);
  if (dirSt && !dirSt.isDirectory()) {
    throw new Error(`sidecar is not a directory: ${srcDir}`);
  }

  try {
    fs.mkdirSync(centralDir, { recursive: true });
  } catch (err) {
    throw new Error(`failed to create ${centralDir}: ${(err as Error).message}`);
  }
  if (lstatOrNull(dstFile) || lstatOrNull(dstDir)) {
    throw new Error(`central already has ${uuid}`);
  }

  const movedBack: Array<() => void> = [];
  const createdLinks: string[] = [];
  let createdDir = false;
  try {
    moveEntry(srcFile, dstFile);
    movedBack.push(() => moveEntry(dstFile, srcFile));
    if (dirSt) {
      moveEntry(srcDir, dstDir);
      movedBack.push(() => moveEntry(dstDir, srcDir));
    }
    fs.symlinkSync(dstFile, srcFile);
    createdLinks.push(srcFile);
    if (!dirSt) {
      // Always give the session a central sidecar, so one Claude creates later lands centrally.
      fs.mkdirSync(dstDir);
      createdDir = true;
    }
    fs.symlinkSync(dstDir, srcDir, "dir");
    createdLinks.push(srcDir);
  } catch (err) {
    // Roll back: drop links we created, then put the real data back.
    const problems: string[] = [];
    for (const link of createdLinks) {
      try {
        if (lstatOrNull(link)?.isSymbolicLink()) fs.unlinkSync(link);
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    if (createdDir) {
      try {
        fs.rmdirSync(dstDir);
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    for (const undo of movedBack.reverse()) {
      try {
        undo();
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    const extra = problems.length ? ` (rollback problems: ${problems.join("; ")})` : "";
    throw new Error(`failed to adopt ${uuid}: ${(err as Error).message}${extra}`);
  }
}

/**
 * Move a real <uuid>/ sidecar directory into centralDir and leave an absolute
 * symlink behind. For a transcript that is already a central link but whose
 * sidecar was created (by Claude) after adoption. On failure the original
 * layout is restored. Only call this for sessions that are not running.
 */
export function adoptSidecar(folder: string, uuid: string, centralDir: string): void {
  centralDir = path.resolve(centralDir);
  const srcDir = path.join(folder, uuid);
  const dstDir = path.join(centralDir, uuid);

  if (inspectTranscript(folder, uuid, centralDir) !== "link-ok") {
    throw new Error(`transcript is not a central link: ${path.join(folder, `${uuid}.jsonl`)}`);
  }
  const dirSt = lstatOrNull(srcDir);
  if (!dirSt || !dirSt.isDirectory()) {
    throw new Error(`not a real sidecar directory: ${srcDir}`);
  }
  if (lstatOrNull(dstDir)) {
    throw new Error(`central already has sidecar ${uuid}`);
  }

  moveEntry(srcDir, dstDir);
  try {
    fs.symlinkSync(dstDir, srcDir, "dir");
  } catch (err) {
    let extra = "";
    try {
      moveEntry(dstDir, srcDir);
    } catch (e) {
      extra = ` (rollback problems: ${(e as Error).message})`;
    }
    throw new Error(`failed to adopt sidecar ${uuid}: ${(err as Error).message}${extra}`);
  }
}

/**
 * Move the symlinks for <uuid> from one project folder to another. When the
 * source has no sidecar link, the target gets one to central <uuid>/ (created
 * if needed), so a sidecar Claude creates later lands centrally.
 */
export function relinkTranscript(
  fromFolder: string,
  toFolder: string,
  uuid: string,
  centralDir: string
): void {
  centralDir = path.resolve(centralDir);
  if (path.resolve(fromFolder) === path.resolve(toFolder)) return;

  const names = [`${uuid}.jsonl`, uuid];
  const moves: Array<[string, string]> = [];
  for (const name of names) {
    const from = path.join(fromFolder, name);
    const st = lstatOrNull(from);
    if (!st) {
      if (name === `${uuid}.jsonl`) throw new Error(`source is not a link: ${from}`);
      continue;
    }
    if (!st.isSymbolicLink()) throw new Error(`source is not a link: ${from}`);
    moves.push([from, path.join(toFolder, name)]);
  }

  try {
    fs.mkdirSync(toFolder, { recursive: true });
  } catch (err) {
    throw new Error(`failed to create ${toFolder}: ${(err as Error).message}`);
  }
  for (const name of names) {
    if (lstatOrNull(path.join(toFolder, name))) throw new Error(`target already has ${uuid}`);
  }

  const done: Array<[string, string]> = [];
  try {
    for (const [from, to] of moves) {
      fs.renameSync(from, to);
      done.push([from, to]);
    }
    if (moves.length === 1) {
      const centralSidecar = path.join(centralDir, uuid);
      fs.mkdirSync(centralSidecar, { recursive: true });
      fs.symlinkSync(centralSidecar, path.join(toFolder, uuid), "dir");
    }
  } catch (err) {
    const problems: string[] = [];
    for (const [from, to] of done.reverse()) {
      try {
        fs.renameSync(to, from);
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    const extra = problems.length ? ` (rollback problems: ${problems.join("; ")})` : "";
    throw new Error(`failed to relink ${uuid}: ${(err as Error).message}${extra}`);
  }
}
