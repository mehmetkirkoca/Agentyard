import * as fs from "fs";
import * as path from "path";
import {appHome, claudeProjectFolder} from "./claude-paths";
import {standaloneScratchDir} from "./project-model";

/**
 * One-time migration of the data FleetCode left behind, now that the app is
 * named Agentyard. Every step only copies, renames or retargets links; nothing
 * is ever deleted, overwritten or followed into a real transcript file.
 */

/** Electron userData folder names used by FleetCode (dev run: `name`, packaged: `productName`). */
export const LEGACY_USER_DATA_NAMES: readonly string[] = ["fleetcode", "FleetCode"];
/** FleetCode's data folder under the home directory. */
export const LEGACY_HOME_DIR_NAME = ".fleetcode";

export interface MigrationStep {
  action: string;
  warnings: string[];
}

export interface RelinkResult {
  relinked: number;
  /** links into the legacy folder left unchanged because their target is missing under the new folder */
  skipped: number;
  /** temp links left behind by an interrupted earlier run, removed */
  cleaned: number;
  errors: string[];
}

// Temp name of a link being retargeted: .<entry name>.agentyard-relink-<pid>
const RELINK_TEMP_RE = /^\..+\.agentyard-relink-\d+$/;

function lstatOrNull(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pick FleetCode's userData folder next to `newDir`: the name matching the new
 * folder's style first (Agentyard → FleetCode, agentyard → fleetcode), then the other.
 */
export function legacyUserDataDir(appDataDir: string, newDir: string): string {
  const preferred = path.basename(newDir) === "Agentyard" ? "FleetCode" : "fleetcode";
  const candidates = [preferred, ...LEGACY_USER_DATA_NAMES.filter(n => n !== preferred)];
  for (const name of candidates) {
    const dir = path.join(appDataDir, name);
    if (lstatOrNull(dir)?.isDirectory()) return dir;
  }
  return path.join(appDataDir, preferred);
}

/** Written into the new userData folder once every settings entry was copied. */
export const USER_DATA_MARKER = ".migrated-from-fleetcode";
/**
 * The userData entries worth keeping: electron-store's config.json (projects, sessions,
 * settings) and the renderer's storage (pane layout, sidebar state). Caches, GPU/Dawn
 * caches, Crashpad, blob storage and Chromium's singleton files are rebuilt by Electron.
 */
export const USER_DATA_ENTRIES: readonly string[] = ["config.json", "Local Storage", "Session Storage", "Preferences"];

// Store keys holding lists of records with an `id`, and lists of plain values.
const ID_LIST_KEYS = ["projects", "sessions"];
const VALUE_LIST_KEYS = ["hiddenTranscripts"];

/**
 * Merge FleetCode's electron-store config into one Agentyard already wrote (for
 * example by a startup after a failed copy). Everything in `current` is kept;
 * from `legacy` it adds top-level keys `current` lacks, projects/sessions whose
 * id is missing, and missing hidden transcript ids.
 */
export function mergeLegacyConfig(current: Record<string, unknown>, legacy: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {...current};
  for (const [key, value] of Object.entries(legacy)) {
    if (!(key in merged)) {
      merged[key] = value;
      continue;
    }
    const mine = merged[key];
    if (!Array.isArray(mine) || !Array.isArray(value)) continue;
    if (ID_LIST_KEYS.includes(key)) {
      const ids = new Set(mine.map(item => (item as {id?: unknown})?.id));
      merged[key] = [...mine, ...value.filter(item => !ids.has((item as {id?: unknown})?.id))];
    } else if (VALUE_LIST_KEYS.includes(key)) {
      merged[key] = [...mine, ...value.filter(item => !mine.includes(item))];
    }
  }
  return merged;
}

function readJsonObject(file: string): Record<string, unknown> {
  const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

// Special files (sockets, FIFOs) cannot be copied and are never settings.
function copyableFilter(src: string): boolean {
  const st = fs.lstatSync(src);
  return st.isFile() || st.isDirectory() || st.isSymbolicLink();
}

/**
 * Copy `src` to a missing `dst` through a temp name next to it, so a failed copy
 * never leaves a half-written `dst` behind. A present `dst` is never replaced.
 */
function copyIntoPlace(src: string, dst: string): void {
  const tmp = `${dst}.migrating-${process.pid}`;
  try {
    fs.rmSync(tmp, {recursive: true, force: true}); // leftover of an interrupted attempt
    fs.cpSync(src, tmp, {
      recursive: true,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      force: false,
      errorOnExist: true,
      filter: copyableFilter,
    });
    if (lstatOrNull(dst)) throw new Error(`${dst} appeared during the copy`);
    fs.renameSync(tmp, dst);
  } catch (err) {
    try {
      fs.rmSync(tmp, {recursive: true, force: true});
    } catch {
      /* best effort: only our own temp copy */
    }
    throw err;
  }
}

/** Fill a present `dst` folder with what it lacks from `src`; nothing is overwritten. */
function fillMissing(src: string, dst: string): void {
  fs.cpSync(src, dst, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    force: false,
    errorOnExist: false,
    filter: copyableFilter,
  });
}

/**
 * Copy Electron's userData settings (USER_DATA_ENTRIES) from `oldDir` to
 * `newDir`. The old folder is kept as a backup. Until every entry was copied
 * the USER_DATA_MARKER is not written, so a failed run is retried next launch:
 * - missing entries are copied in place via a temp name;
 * - present folders only get what they lack (nothing is overwritten);
 * - a config.json Agentyard already wrote is merged at JSON level
 *   (mergeLegacyConfig), keeping everything it holds.
 */
export function migrateUserData(oldDir: string, newDir: string): MigrationStep {
  oldDir = path.resolve(oldDir);
  newDir = path.resolve(newDir);
  if (oldDir === newDir) return {action: "none", warnings: []};
  const oldSt = lstatOrNull(oldDir);
  if (!oldSt || !oldSt.isDirectory()) return {action: "none", warnings: []};
  const marker = path.join(newDir, USER_DATA_MARKER);
  if (lstatOrNull(marker)) return {action: "none", warnings: []};

  const newSt = lstatOrNull(newDir);
  if (newSt && !newSt.isDirectory()) {
    return {action: "none", warnings: [`${newDir} is not a directory; settings from ${oldDir} were not copied`]};
  }

  try {
    fs.mkdirSync(newDir, {recursive: true});
    let merged = false;
    for (const name of USER_DATA_ENTRIES) {
      const src = path.join(oldDir, name);
      const dst = path.join(newDir, name);
      const srcSt = lstatOrNull(src);
      if (!srcSt) continue;
      const dstSt = lstatOrNull(dst);
      if (!dstSt) {
        copyIntoPlace(src, dst);
      } else if (name === "config.json") {
        const combined = mergeLegacyConfig(readJsonObject(dst), readJsonObject(src));
        const tmp = `${dst}.migrating-${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify(combined, null, "\t"));
        fs.renameSync(tmp, dst);
        merged = true;
      } else if (srcSt.isDirectory() && dstSt.isDirectory()) {
        fillMissing(src, dst);
        merged = true;
      }
    }
    fs.writeFileSync(marker, `Settings copied from ${oldDir}\n`);
    return {action: merged ? "merged" : "copied", warnings: []};
  } catch (err) {
    return {
      action: "failed",
      warnings: [`Could not copy settings from ${oldDir} to ${newDir} (retried next launch): ${message(err)}`],
    };
  }
}

/**
 * Move <home>/.fleetcode to <home>/.agentyard and leave <home>/.fleetcode as a
 * symlink to it, so every link that still points into the old folder keeps
 * resolving. Never merges: when both are real folders nothing is changed.
 */
export function migrateDataHome(home: string): MigrationStep {
  const oldHome = path.join(home, LEGACY_HOME_DIR_NAME);
  const newHome = appHome(home);
  const oldSt = lstatOrNull(oldHome);
  if (!oldSt) return {action: "none", warnings: []};

  const newSt = lstatOrNull(newHome);
  if (oldSt.isSymbolicLink()) {
    const sameTarget = newSt && realpathOrNull(oldHome) !== null && realpathOrNull(oldHome) === realpathOrNull(newHome);
    if (sameTarget) return {action: "already-migrated", warnings: []};
    return {action: "none", warnings: [`${oldHome} is a symlink that does not point to ${newHome}; not migrating`]};
  }
  if (!oldSt.isDirectory()) {
    return {action: "none", warnings: [`${oldHome} is not a directory; not migrating`]};
  }
  if (newSt) {
    if (realpathOrNull(oldHome) === realpathOrNull(newHome)) return {action: "already-migrated", warnings: []};
    return {action: "both-exist", warnings: [`Both ${oldHome} and ${newHome} exist; not migrating`]};
  }

  try {
    fs.renameSync(oldHome, newHome);
  } catch (err) {
    return {action: "failed", warnings: [`Could not move ${oldHome} to ${newHome}: ${message(err)}`]};
  }
  try {
    fs.symlinkSync(newHome, oldHome, "dir");
  } catch (err) {
    // Without the compatibility link existing transcript links would dangle: move the folder back.
    try {
      fs.renameSync(newHome, oldHome);
    } catch (restoreErr) {
      return {
        action: "failed",
        warnings: [
          `Moved ${oldHome} to ${newHome} but could not link it back (${message(err)}) ` +
            `nor move it back (${message(restoreErr)}); your data is in ${newHome}`,
        ],
      };
    }
    return {action: "failed", warnings: [`Could not link ${oldHome} to ${newHome}, nothing moved: ${message(err)}`]};
  }
  return {action: "renamed", warnings: []};
}

/**
 * Retarget the symlinks under <home>/.claude/projects/* that point into
 * <home>/.fleetcode/ to the same path under <home>/.agentyard/. Each link is
 * replaced atomically (new link at a temp name, then rename over the old one).
 * Real files are never touched. Runs only once <home>/.fleetcode is the
 * compatibility link (or gone), so it never switches a link to a different copy.
 * Idempotent: a second run finds nothing to retarget.
 */
export function relinkTranscripts(home: string): RelinkResult {
  const result: RelinkResult = {relinked: 0, skipped: 0, cleaned: 0, errors: []};
  const oldHome = path.join(home, LEGACY_HOME_DIR_NAME);
  const newHome = appHome(home);
  const projectsDir = path.join(home, ".claude", "projects");

  try {
    const oldSt = lstatOrNull(oldHome);
    if (oldSt && realpathOrNull(oldHome) !== realpathOrNull(newHome)) return result;
    if (!lstatOrNull(projectsDir)?.isDirectory()) return result;
  } catch (err) {
    result.errors.push(`Could not inspect ${oldHome}: ${message(err)}`);
    return result;
  }

  let folders: string[];
  try {
    folders = fs.readdirSync(projectsDir);
  } catch (err) {
    result.errors.push(`Could not read ${projectsDir}: ${message(err)}`);
    return result;
  }

  const oldPrefix = oldHome + path.sep;
  for (const folderName of folders) {
    const folder = path.join(projectsDir, folderName);
    let names: string[];
    try {
      if (!fs.lstatSync(folder).isDirectory()) continue;
      names = fs.readdirSync(folder);
    } catch (err) {
      result.errors.push(`Could not read ${folder}: ${message(err)}`);
      continue;
    }
    // A crash between creating a temp link and renaming it leaves the temp link next to the
    // untouched original: drop it (only symlinks with our exact temp name).
    names = names.filter(name => {
      if (!RELINK_TEMP_RE.test(name)) return true;
      const p = path.join(folder, name);
      try {
        if (!fs.lstatSync(p).isSymbolicLink()) return true;
        fs.unlinkSync(p);
        result.cleaned++;
      } catch (err) {
        result.errors.push(`Could not remove leftover temp link ${p}: ${message(err)}`);
      }
      return false;
    });
    for (const name of names) {
      const entry = path.join(folder, name);
      const tmp = path.join(folder, `.${name}.agentyard-relink-${process.pid}`);
      try {
        if (!fs.lstatSync(entry).isSymbolicLink()) continue;
        const target = path.resolve(folder, fs.readlinkSync(entry));
        if (!target.startsWith(oldPrefix)) continue;
        const newTarget = path.join(newHome, path.relative(oldHome, target));
        if (!fs.existsSync(newTarget)) {
          result.skipped++;
          continue;
        }
        const type = fs.statSync(newTarget).isDirectory() ? "dir" : "file";
        const leftover = lstatOrNull(tmp);
        if (leftover) {
          if (!leftover.isSymbolicLink()) throw new Error(`temp path ${tmp} exists and is not a link`);
          fs.unlinkSync(tmp);
        }
        fs.symlinkSync(newTarget, tmp, type);
        fs.renameSync(tmp, entry);
        result.relinked++;
      } catch (err) {
        result.errors.push(`Could not relink ${entry}: ${message(err)}`);
        try {
          if (lstatOrNull(tmp)?.isSymbolicLink()) fs.unlinkSync(tmp);
        } catch {
          /* best effort: only our own temp link */
        }
      }
    }
  }
  return result;
}

/** FleetCode's folder for standalone ("Others") sessions under the home directory. */
export const LEGACY_SCRATCH_DIR_NAME = "fleetcode-scratch";

function legacyScratchDir(home: string): string {
  return path.join(home, LEGACY_SCRATCH_DIR_NAME);
}

/** The old scratch path is gone or is the compatibility link to the new one. */
function scratchMigrated(home: string): boolean {
  const oldDir = legacyScratchDir(home);
  if (!lstatOrNull(oldDir)) return true;
  const real = realpathOrNull(oldDir);
  return real !== null && real === realpathOrNull(standaloneScratchDir(home));
}

/**
 * Move <home>/fleetcode-scratch to <home>/agentyard-scratch, leave a compatibility
 * symlink at the old path, then rename Claude's project folder for it
 * (<home>/.claude/projects/<encoded old path>) to the encoded new path, so the
 * transcript links and memory/ of those sessions follow. Never merges: when both
 * exist as real folders nothing is changed and a warning is returned.
 */
export function migrateScratchDir(home: string): MigrationStep {
  const warnings: string[] = [];
  const oldDir = legacyScratchDir(home);
  const newDir = standaloneScratchDir(home);
  let action = "none";

  const oldSt = lstatOrNull(oldDir);
  const newSt = lstatOrNull(newDir);
  if (oldSt?.isDirectory()) {
    if (newSt) {
      warnings.push(`Both ${oldDir} and ${newDir} exist; not migrating the Others folder`);
      return {action: "both-exist", warnings};
    }
    try {
      fs.renameSync(oldDir, newDir);
    } catch (err) {
      return {action: "failed", warnings: [`Could not move ${oldDir} to ${newDir}: ${message(err)}`]};
    }
    try {
      fs.symlinkSync(newDir, oldDir, "dir");
    } catch (err) {
      try {
        fs.renameSync(newDir, oldDir);
      } catch (restoreErr) {
        return {
          action: "failed",
          warnings: [
            `Moved ${oldDir} to ${newDir} but could not link it back (${message(err)}) ` +
              `nor move it back (${message(restoreErr)}); the folder is now ${newDir}`,
          ],
        };
      }
      return {action: "failed", warnings: [`Could not link ${oldDir} to ${newDir}, nothing moved: ${message(err)}`]};
    }
    action = "renamed";
  }
  if (!scratchMigrated(home)) return {action, warnings};

  const oldFolder = claudeProjectFolder(oldDir, home);
  const newFolder = claudeProjectFolder(newDir, home);
  const oldFolderSt = lstatOrNull(oldFolder);
  if (oldFolderSt?.isDirectory()) {
    if (lstatOrNull(newFolder)) {
      warnings.push(`Both ${oldFolder} and ${newFolder} exist; not moving the Others transcripts folder`);
    } else {
      try {
        fs.renameSync(oldFolder, newFolder);
        action = action === "none" ? "transcripts-moved" : `${action}+transcripts-moved`;
      } catch (err) {
        warnings.push(`Could not move ${oldFolder} to ${newFolder}: ${message(err)}`);
      }
    }
  }
  return {action, warnings};
}

/**
 * Replace the old scratch path with the new one in the stored session data:
 * projects[].dirs, sessions[].config.projectDir, sessions[].linkedDir and
 * lastSessionConfig.projectDir. Exact matches only; other paths are untouched.
 */
export function rewriteScratchPaths(
  config: Record<string, unknown>,
  oldPath: string,
  newPath: string,
): {config: Record<string, unknown>; changed: boolean} {
  let changed = false;
  const swap = (value: unknown): unknown => {
    if (value === oldPath) {
      changed = true;
      return newPath;
    }
    return value;
  };
  const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const out: Record<string, unknown> = {...config};

  if (Array.isArray(config.projects)) {
    out.projects = config.projects.map(p =>
      isObject(p) && Array.isArray(p.dirs) ? {...p, dirs: p.dirs.map(swap)} : p,
    );
  }
  if (Array.isArray(config.sessions)) {
    out.sessions = config.sessions.map(s => {
      if (!isObject(s)) return s;
      const next: Record<string, unknown> = {...s};
      if ("linkedDir" in s) next.linkedDir = swap(s.linkedDir);
      if (isObject(s.config) && "projectDir" in s.config) next.config = {...s.config, projectDir: swap(s.config.projectDir)};
      return next;
    });
  }
  if (isObject(config.lastSessionConfig) && "projectDir" in config.lastSessionConfig) {
    out.lastSessionConfig = {...config.lastSessionConfig, projectDir: swap(config.lastSessionConfig.projectDir)};
  }
  return {config: changed ? out : config, changed};
}

/**
 * Apply rewriteScratchPaths to the electron-store config.json in `userDataDir`
 * (written atomically). Only once the scratch folder was migrated, so stored
 * paths never point at a folder whose data still lives under the old name.
 */
export function migrateConfigScratchPaths(home: string, userDataDir: string): MigrationStep {
  const file = path.join(userDataDir, "config.json");
  if (!scratchMigrated(home) || !lstatOrNull(file)) return {action: "none", warnings: []};
  try {
    const {config, changed} = rewriteScratchPaths(readJsonObject(file), legacyScratchDir(home), standaloneScratchDir(home));
    if (!changed) return {action: "none", warnings: []};
    const tmp = `${file}.migrating-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, "\t"));
    fs.renameSync(tmp, file);
    return {action: "rewritten", warnings: []};
  } catch (err) {
    return {action: "failed", warnings: [`Could not update the Others folder path in ${file}: ${message(err)}`]};
  }
}

/**
 * Run every step in order. Never throws: failures come back as warnings.
 */
export function runDataMigration(opts: {home: string; oldUserData: string; newUserData: string}): {
  summary: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const run = <T>(label: string, step: () => T, fallback: T): T => {
    try {
      return step();
    } catch (err) {
      warnings.push(`${label} failed: ${message(err)}`);
      return fallback;
    }
  };
  const failed: MigrationStep = {action: "failed", warnings: []};

  const userData = run("Settings migration", () => migrateUserData(opts.oldUserData, opts.newUserData), failed);
  warnings.push(...userData.warnings);
  const dataHome = run("Data folder migration", () => migrateDataHome(opts.home), failed);
  warnings.push(...dataHome.warnings);
  const scratch = run("Others folder migration", () => migrateScratchDir(opts.home), failed);
  warnings.push(...scratch.warnings);
  const configPaths = run("Others folder path update", () => migrateConfigScratchPaths(opts.home, opts.newUserData), failed);
  warnings.push(...configPaths.warnings);
  const links = run("Transcript relink", () => relinkTranscripts(opts.home), {relinked: 0, skipped: 0, cleaned: 0, errors: []});
  warnings.push(...links.errors);

  const summary =
    `settings: ${userData.action}, data folder: ${dataHome.action}, ` +
    `others folder: ${scratch.action}, config paths: ${configPaths.action}, ` +
    `links relinked: ${links.relinked}, skipped: ${links.skipped}, cleaned: ${links.cleaned}, errors: ${links.errors.length}`;
  return {summary, warnings};
}
