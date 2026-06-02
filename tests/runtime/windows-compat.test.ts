import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { isPathInsideRoot } from '../../electron/main/path-guard.ts';
import { resolveInteractiveShell, resolveRunCommandShell } from '../../electron/main/agent-platform/system-shell.ts';

// These run on any OS via injected path implementations / a patched
// process.platform, so the Windows behaviour is exercised from macOS/Linux CI.

test('isPathInsideRoot accepts in-root paths under Windows semantics (the write_file regression)', () => {
  const win = path.win32;
  const root = 'C:\\Users\\32567\\Downloads\\pvz';

  // The exact case that was failing: a relative file resolved against the root
  // becomes a backslash absolute path; the old `startsWith(root + '/')` rejected
  // it. isPathInsideRoot must accept it.
  assert.equal(isPathInsideRoot(root, win.resolve(root, 'index.html'), win), true);
  assert.equal(isPathInsideRoot(root, win.resolve(root, 'docs\\pvz-cartoon-pillar.md'), win), true);
  assert.equal(isPathInsideRoot(root, win.resolve(root, 'assets/audio/theme.mp3'), win), true);
  assert.equal(isPathInsideRoot(root, root, win), true);
});

test('isPathInsideRoot rejects escapes and other drives under Windows semantics', () => {
  const win = path.win32;
  const root = 'C:\\Users\\32567\\Downloads\\pvz';

  assert.equal(isPathInsideRoot(root, win.resolve(root, '..\\secrets.txt'), win), false);
  assert.equal(isPathInsideRoot(root, win.resolve(root, '..\\..\\Windows\\system32'), win), false);
  assert.equal(isPathInsideRoot(root, 'D:\\elsewhere\\file.txt', win), false);
});

test('isPathInsideRoot keeps working under POSIX semantics', () => {
  const posix = path.posix;
  const root = '/home/me/proj';

  assert.equal(isPathInsideRoot(root, posix.resolve(root, 'index.html'), posix), true);
  assert.equal(isPathInsideRoot(root, posix.resolve(root, 'docs/readme.md'), posix), true);
  assert.equal(isPathInsideRoot(root, root, posix), true);
  assert.equal(isPathInsideRoot(root, posix.resolve(root, '../other'), posix), false);
  assert.equal(isPathInsideRoot(root, '/etc/passwd', posix), false);
});

function withPlatform(platform: NodeJS.Platform, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    run();
  } finally {
    if (original) {
      Object.defineProperty(process, 'platform', original);
    }
  }
}

test('resolveRunCommandShell uses cmd.exe on Windows, sh -lc on Unix', () => {
  withPlatform('win32', () => {
    const { shell, args } = resolveRunCommandShell('npm run dev');
    assert.equal(shell, process.env.ComSpec || 'cmd.exe');
    assert.deepEqual(args, ['/d', '/s', '/c', 'npm run dev']);
  });
  withPlatform('darwin', () => {
    const { shell, args } = resolveRunCommandShell('npm run dev');
    assert.equal(shell, process.env.SHELL || '/bin/sh');
    assert.deepEqual(args, ['-lc', 'npm run dev']);
  });
});

test('resolveInteractiveShell uses bare cmd.exe on Windows, sh -i on Unix', () => {
  withPlatform('win32', () => {
    const { shell, args } = resolveInteractiveShell();
    assert.equal(shell, process.env.ComSpec || 'cmd.exe');
    assert.deepEqual(args, []);
  });
  withPlatform('linux', () => {
    const { shell, args } = resolveInteractiveShell();
    assert.equal(shell, process.env.SHELL || '/bin/sh');
    assert.deepEqual(args, ['-i']);
  });
});
