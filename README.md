# Agentyard

Agentyard is a desktop app (Electron + TypeScript) for running and organizing many Claude Code and Gemini sessions side by side. Sessions are grouped into projects that can span several working directories, every conversation is kept in one central transcript store, and the terminals can be arranged in a split-pane layout so several agents stay visible at once.

> **Fork of FleetCode.** Agentyard is a fork of [FleetCode](https://github.com/built-by-as/FleetCode) by built-by-as (Amrit Subramanian), based on FleetCode v1.0.1-beta.8 (commit 1cb4afd). Many thanks to the original author; the original project is linked here for reference.

## Features

- **Projects with multiple working directories**: a project owns one or more directories; each session runs in one chosen directory, and directories already used by another session are locked in the picker.
- **Others (standalone sessions)**: sessions that do not belong to any project, shown in their own section.
- **Multiple Coding Agents**: run Claude Code, Gemini CLI, or Codex in your project workspaces and worktrees.
- **Central transcript store**: conversations live in `~/.agentyard/sessions/`; the session directory's `~/.claude/projects` folder contains a symlink to them, so a session can switch directories without losing its history. Existing Claude Code conversations found in `~/.claude/projects` are imported continuously.
- **Status dots via hooks**: running, waiting for approval, done, closed, and open elsewhere, with a per-project "n waiting" counter. The hook settings are passed to `claude` via `--settings`; the global `~/.claude/settings.json` is never modified.
- **Fork**: start a new session as a copy of an existing conversation.
- **Split-pane tree**: drop a session on a pane edge to split it; the 2x2 layout can move its splits linked or independently.
- **Per-pane breadcrumb and directory picker**: `project › session › dir ▾ ⎇ branch` above every terminal.
- **Attachments**: add files from a dialog, paste an image from the clipboard, or drag and drop files into a pane.
- **Voice toggle**: sends Claude's `/voice` command to the session.
- **Per-group search** in the sidebar.
- **Resizable, hideable sidebar.**
- **VS Code Dark+ styled UI.**
- Git worktree sessions, terminal settings and MCP server management inherited from FleetCode.

## Prerequisites

- Node.js 18+
- Git
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude` on your `PATH`) and/or Gemini CLI (`gemini` on your `PATH`)

## Development

```bash
npm install
npx @electron/rebuild -f -w node-pty   # rebuild the native terminal module for Electron
npm start                               # build and run
```

Other scripts:

```bash
npm test           # jest
npm run build      # CSS + TypeScript into dist/
npm run dist       # packaged build via electron-builder
```

On Linux, if Electron refuses to start because of the Chromium sandbox (`chrome-sandbox` not owned by root), run it with `--no-sandbox`:

```bash
npm run build && npx electron . --no-sandbox
```

## Data locations

- `~/.agentyard/` holds the app's own data:
  - `sessions/`: central transcript store (symlinked from `~/.claude/projects/<dir>/`)
  - `status/`: per-session hook status
  - `hooks/`: per-session hook settings
  - `attachments/`: pasted clipboard images
- `~/.config/agentyard/` (Electron userData; `~/.config/Agentyard/` for a packaged build): settings, projects and sessions (`config.json`) and UI state.
- `~/agentyard-scratch/`: working folder of the Others (standalone) sessions, created on first use.

Process detection for the "open elsewhere" state is Linux-only and reads `/proc`.

### Migrating from FleetCode

**Close FleetCode before the first launch of Agentyard.** On first launch Agentyard migrates FleetCode's data once:

1. Settings are copied from FleetCode's userData folder: `~/.config/fleetcode` → `~/.config/agentyard` when run from source, `~/.config/FleetCode` → `~/.config/Agentyard` for packaged builds. Only `config.json`, `Local Storage`, `Session Storage` and `Preferences` are copied; the old folder is kept as a backup. A failed copy is retried on the next launch.
2. `~/.fleetcode` is moved to `~/.agentyard`, and `~/.fleetcode` is left behind as a symlink to it, so every existing link keeps working.
3. The Others folder `~/fleetcode-scratch` is moved to `~/agentyard-scratch` (again with a symlink left at the old path), its Claude project folder under `~/.claude/projects` is renamed to match, and the stored paths in `config.json` are updated.
4. The transcript links under `~/.claude/projects` that point into `~/.fleetcode/` are retargeted to `~/.agentyard/`, one at a time and atomically. Real files are never touched.

Nothing is deleted or overwritten. If both the old and the new folder already exist as real folders, that step is skipped and a warning is shown in the sidebar.

> **Note:** When Agentyard is launched from inside a Claude Code session, it strips the nested-session environment variables before starting `claude`, otherwise transcripts are not written.

## Troubleshooting

### macOS: "App can't be opened because it is from an unidentified developer"

```bash
xattr -cr /path/to/Agentyard.app
```

### Claude Code works in the wrong directory

Disable "Auto connect to IDE" (`claude config`, set `autoConnectToIde` to `false`) so Claude Code stays in the session's directory or worktree.

## License

ISC. See [LICENSE](LICENSE). Copyright (c) 2025 built-by-as (Amrit Subramanian), Copyright (c) 2026 Mehmet Kirkoca.
