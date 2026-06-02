/**
 * Cross-platform shell resolution for spawning commands.
 *
 * The old code hardcoded `process.env.SHELL || '/bin/sh'` together with Unix
 * flags (`-lc` / `-i`). On Windows `$SHELL` is normally unset, so it fell back
 * to `/bin/sh` — which does not exist there — producing `spawn /bin/sh ENOENT`.
 * Resolve the platform-native shell instead: cmd.exe on Windows (via %ComSpec%),
 * the login/interactive shell on Unix.
 */

/**
 * One-shot command execution for `run_command`:
 * `cmd /d /s /c <command>` on Windows, `sh -lc <command>` on Unix.
 */
export function resolveRunCommandShell(command: string): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    return { shell: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
  return { shell: process.env.SHELL || '/bin/sh', args: ['-lc', command] };
}

/**
 * Interactive persistent terminal: bare `cmd.exe` on Windows (it reads commands
 * from stdin by default), `sh -i` on Unix.
 */
export function resolveInteractiveShell(): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    return { shell: process.env.ComSpec || 'cmd.exe', args: [] };
  }
  return { shell: process.env.SHELL || '/bin/sh', args: ['-i'] };
}
