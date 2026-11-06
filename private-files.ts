import * as fs from "fs";

// Modes are also set after the call: mkdir and open apply theirs only to what they create

/** A folder only its owner can enter, created when missing. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.chmodSync(dir, 0o700);
}

/** A file only its owner can read or write. */
export function writePrivateFile(file: string, data: string | Buffer): void {
  fs.writeFileSync(file, data, {mode: 0o600});
  fs.chmodSync(file, 0o600);
}
