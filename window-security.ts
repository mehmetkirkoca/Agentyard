// The page runs with Node integration, so any other page loaded into the window would too:
// the window stays on index.html and opens nothing else.
export function hardenNavigation(contents: {
  on(event: "will-navigate", listener: (event: {preventDefault(): void}) => void): unknown;
  setWindowOpenHandler(handler: () => {action: "deny"}): void;
}): void {
  contents.on("will-navigate", (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({action: "deny"}));
}
