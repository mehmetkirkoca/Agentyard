// Path helpers for the renderer, which runs without Node's `path` module.
// Both "/" and "\" separate segments, so Windows paths work too.

function trimmed(p: string): string {
  const unified = p.replace(/[\\/]+/g, "/");
  return unified.length > 1 ? unified.replace(/\/$/, "") : unified;
}

/** Last segment of a path, ignoring trailing separators: "/a/b/" -> "b". */
export function baseName(p: string): string {
  const clean = trimmed(p);
  return clean.slice(clean.lastIndexOf("/") + 1);
}

/** Whether two paths name the same location, ignoring separator style and trailing separators. */
export function samePath(a: string, b: string): boolean {
  return trimmed(a) === trimmed(b);
}
