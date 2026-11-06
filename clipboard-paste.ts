// Right-click paste in a terminal. The clipboard now lives in main (IPC), so reading it is async.

/**
 * xterm pastes text as it is, so a clipboard holding ESC [201~ ends a bracketed paste early and the
 * rest runs as typed input. Control characters go; tabs and line breaks stay.
 */
export function sanitizePaste(text: string): string {
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

/**
 * Reads the clipboard and pastes its text with line breaks intact. An empty clipboard pastes
 * nothing; a failing read goes to onError instead of being swallowed.
 */
export async function pasteFromClipboard(
  read: () => Promise<string>,
  paste: (text: string) => void,
  onError: (message: string) => void,
): Promise<void> {
  try {
    const text = await read();
    if (text) paste(sanitizePaste(text));
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  }
}
