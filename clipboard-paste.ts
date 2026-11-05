// Right-click paste in a terminal. The clipboard now lives in main (IPC), so reading it is async.

/**
 * Reads the clipboard and pastes its text unchanged (multi-line included). An empty clipboard
 * pastes nothing; a failing read goes to onError instead of being swallowed.
 */
export async function pasteFromClipboard(
  read: () => Promise<string>,
  paste: (text: string) => void,
  onError: (message: string) => void,
): Promise<void> {
  try {
    const text = await read();
    if (text) paste(text);
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  }
}
