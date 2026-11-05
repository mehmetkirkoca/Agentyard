import {execFileSync} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {hasMcpListResult, mcpAddJsonCommand, mcpGetCommand, mcpRemoveCommand, mcpServerDetailsHtml, parseMcpListOutput} from './mcp-utils';

// Real `claude mcp list` output from Claude Code 2.1.x
const CURRENT_OUTPUT = [
  'claude mcp list',
  'Checking MCP server health…',
  '',
  'claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected',
  'claude.ai legal-mcp: https://legal.example.com/mcp - ✘ Failed to connect — HTTP 502: Error POSTing to endpoint: {"type":"x"}',
  'tracker: https://tracker.example.com/v1/mcp (HTTP) - ✔ Connected',
  'playwright: npx @playwright/mcp@latest - ✔ Connected',
  'user@host:~$ ',
].join('\r\n');

describe('parseMcpListOutput', () => {
  it('parses the current output format (✔/✘, names with spaces, no type)', () => {
    expect(parseMcpListOutput(CURRENT_OUTPUT)).toEqual([
      {name: 'claude.ai Claude Docs', connected: true},
      {name: 'claude.ai legal-mcp', connected: false},
      {name: 'tracker', connected: true},
      {name: 'playwright', connected: true},
    ]);
  });

  it('still parses the legacy format (✓/✗ with type)', () => {
    const legacy = [
      'my-server: https://example.com/mcp (SSE) - ✓ Connected',
      'local: node server.js (stdio) - ✗ Failed to connect',
      'warn: https://w.example (HTTP) - ⚠ Needs authentication',
    ].join('\n');
    expect(parseMcpListOutput(legacy)).toEqual([
      {name: 'my-server', connected: true},
      {name: 'local', connected: false},
      {name: 'warn', connected: false},
    ]);
  });

  it('returns an empty list when no servers are configured', () => {
    expect(parseMcpListOutput('No MCP servers configured. Use `claude mcp add` to add a server.')).toEqual([]);
  });

  it('ignores ANSI escape sequences and the echoed command', () => {
    const colored = '\x1b[32mclaude mcp list\x1b[0m\r\n\x1b[1mgithub\x1b[0m: https://x.example - \x1b[32m✔ Connected\x1b[0m\r\n';
    expect(parseMcpListOutput(colored)).toEqual([{name: 'github', connected: true}]);
  });

  it('does not treat a shell prompt or a URL line without status as a server', () => {
    expect(parseMcpListOutput('user@host:~/dir$ \r\nsee https://docs.example.com/mcp for help')).toEqual([]);
  });
});

// Raw bytes as seen through a PTY: Claude Code aligns columns with cursor moves (ESC[nG), not spaces,
// and wraps long lines at the terminal width.
const PTY_OUTPUT =
  'claude.ai\x1b[11GGoogle\x1b[18GCalendar:\x1b[28Ghttps://calendarmcp.googleapis.com/mcp/v1\x1b[70G-\x1b[72G\u2714\r\r\nConnected\r\r\n' +
  'tracker:\x1b[12Ghttps://tracker.example.com/v1/mcp\x1b[45G(HTTP)\x1b[52G-\x1b[54G\u2714\x1b[56GConnected\r\r\n' +
  'playwright:\x1b[13Gnpx\x1b[17G@playwright/mcp@latest\x1b[40G-\x1b[42G\u2714\x1b[44GConnected\r\r\n' +
  'claude.ai\x1b[11Glegal-mcp:\x1b[22Ghttps://legal.example.com/mcp\x1b[52G-\x1b[54G\u2718\x1b[56GFailed\r\r\n';

describe('parseMcpListOutput with PTY cursor movement', () => {
  it('treats cursor-column moves as spaces', () => {
    expect(parseMcpListOutput(PTY_OUTPUT)).toEqual([
      {name: 'claude.ai Google Calendar', connected: true},
      {name: 'tracker', connected: true},
      {name: 'playwright', connected: true},
      {name: 'claude.ai legal-mcp', connected: false},
    ]);
    expect(hasMcpListResult(PTY_OUTPUT)).toBe(true);
  });
});

describe('parseMcpListOutput with shell-integration escapes', () => {
  it('does not let an OSC sequence swallow the following lines', () => {
    const raw = 'claude mcp list 2>&1 | cat\r\n\x1b[?2004l\r\x1b]666;vte.shell.preexec!\x1b\\Checking MCP server health\u2026\r\n\r\n' +
      'claude.ai search: https://search.example.com/api/mcp - \u2714 Connected\r\n' +
      'playwright: npx @playwright/mcp@latest - \u2714 Connected\r\n' +
      '\x1b]666;vte.shell.postexec=0\x1b\\\x1b]0;user@host: ~/dir\x07user@host:~/dir$ ';
    expect(parseMcpListOutput(raw)).toEqual([
      {name: 'claude.ai search', connected: true},
      {name: 'playwright', connected: true},
    ]);
  });
});

describe('hasMcpListResult', () => {
  it('detects a chunk containing a server line in the current format', () => {
    expect(hasMcpListResult('playwright: npx @playwright/mcp@latest - ✔ Connected\r\n')).toBe(true);
  });

  it('detects the no-servers message', () => {
    expect(hasMcpListResult('No MCP servers configured.')).toBe(true);
  });

  it('is false for unrelated output', () => {
    expect(hasMcpListResult('Checking MCP server health…\r\n')).toBe(false);
  });
});

describe('MCP shell commands', () => {
  // The real shell parses the command; a stub claude reports the arguments it received
  const argvOf = (command: string): string[] =>
    execFileSync('bash', ['-c', `claude() { printf '%s\\0' "$@"; }; ${command}`], {encoding: 'utf8'})
      .split('\0').slice(0, -1);

  let dir: string;
  let canary: string;
  let hostile: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentyard-mcp-'));
    canary = path.join(dir, 'canary');
    hostile = `x$(touch ${canary})\`touch ${canary}\`"'; touch ${canary}; '`;
  });

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it('passes a hostile name to mcp get as one literal argument', () => {
    expect(argvOf(mcpGetCommand(hostile))).toEqual(['mcp', 'get', '--', hostile]);
    expect(fs.existsSync(canary)).toBe(false);
  });

  it('passes a hostile name to mcp remove as one literal argument', () => {
    expect(argvOf(mcpRemoveCommand(hostile))).toEqual(['mcp', 'remove', '--', hostile]);
    expect(fs.existsSync(canary)).toBe(false);
  });

  it('passes a hostile name and config to mcp add-json as literal arguments', () => {
    const config = {command: hostile};
    expect(argvOf(mcpAddJsonCommand(hostile, config)))
      .toEqual(['mcp', 'add-json', '--scope', 'user', '--', hostile, JSON.stringify(config)]);
    expect(fs.existsSync(canary)).toBe(false);
  });

  it('refuses a name with control characters, which a PTY would act on', () => {
    expect(() => mcpGetCommand('a\rtouch x\r')).toThrow(/control characters/i);
    expect(() => mcpRemoveCommand('a\x03')).toThrow(/control characters/i);
    expect(() => mcpAddJsonCommand('a\n', {})).toThrow(/control characters/i);
  });
});

describe('mcpServerDetailsHtml', () => {
  it('escapes every value', () => {
    const payload = '<img src=x onerror=alert(1)>';
    const html = mcpServerDetailsHtml({
      scope: payload, status: payload, type: payload, url: payload, command: payload, args: payload,
    });
    expect(html).not.toContain('<img');
    expect(html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g)).toHaveLength(6);
  });

  it('shows only the fields that are present', () => {
    expect(mcpServerDetailsHtml({url: 'https://x.test/mcp'}))
      .toBe('<div><strong>URL:</strong> https://x.test/mcp</div>');
  });
});
