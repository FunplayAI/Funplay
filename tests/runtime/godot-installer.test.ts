import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findManagedGodotInstallation,
  getGodotManagedDir,
  installGodotEditor,
  type GodotInstallHooks
} from '../../electron/main/godot-installer.ts';

async function withManagedDir(run: (managedDir: string, userDataPath: string) => Promise<void>): Promise<void> {
  const userDataPath = await mkdtemp(join(tmpdir(), 'funplay-godot-install-'));
  const managedDir = join(userDataPath, 'managed');
  const previous = process.env.GODOT_MANAGED_DIR;
  process.env.GODOT_MANAGED_DIR = managedDir;
  try {
    await run(managedDir, userDataPath);
  } finally {
    if (previous === undefined) {
      delete process.env.GODOT_MANAGED_DIR;
    } else {
      process.env.GODOT_MANAGED_DIR = previous;
    }
    await rm(userDataPath, { recursive: true, force: true });
  }
}

// Lay down a platform-appropriate fake Godot payload, the same shape the real
// unzip would leave behind, so detection + the install flow can be exercised
// without a network download or a real archive.
function writeFakeGodotPayload(destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  if (process.platform === 'darwin') {
    const macosDir = join(destDir, 'Godot.app', 'Contents', 'MacOS');
    mkdirSync(macosDir, { recursive: true });
    const bin = join(macosDir, 'Godot');
    writeFileSync(bin, '#!/bin/sh\necho "4.7.stable.official"\n');
    chmodSync(bin, 0o755);
    return;
  }
  if (process.platform === 'win32') {
    writeFileSync(join(destDir, 'Godot_v4.7-stable_win64.exe'), 'fake');
    return;
  }
  const bin = join(destDir, 'Godot_v4.7-stable_linux.x86_64');
  writeFileSync(bin, '#!/bin/sh\necho "4.7.stable.official"\n');
  chmodSync(bin, 0o755);
}

function stubHooks(): GodotInstallHooks {
  return {
    resolveAsset: async () => ({
      tag: '4.7-stable',
      assetName: 'Godot_v4.7-stable_test.zip',
      downloadUrl: 'https://example.invalid/godot.zip'
    }),
    download: async (_url, destZip) => {
      writeFileSync(destZip, 'fake-zip-bytes');
    },
    extract: async (_zipPath, destDir) => {
      writeFakeGodotPayload(destDir);
    }
  };
}

test('getGodotManagedDir honors the GODOT_MANAGED_DIR override', async () => {
  await withManagedDir(async (managedDir, userDataPath) => {
    assert.equal(getGodotManagedDir(userDataPath), managedDir);
  });
});

test('findManagedGodotInstallation reports nothing for an empty managed dir', async () => {
  await withManagedDir(async (_managedDir, userDataPath) => {
    assert.equal(findManagedGodotInstallation(userDataPath), undefined);
  });
});

test('installGodotEditor downloads + extracts + locates a launchable binary', async () => {
  await withManagedDir(async (_managedDir, userDataPath) => {
    const stages: string[] = [];
    const result = await installGodotEditor({
      userDataPath,
      onStage: (stage) => stages.push(stage),
      hooks: stubHooks()
    });
    assert.equal(result.ok, true, result.message);
    assert.ok(result.executablePath && existsSync(result.executablePath), 'binary should exist on disk');

    // Detection now finds the managed install at the same path.
    const detected = findManagedGodotInstallation(userDataPath);
    assert.ok(detected, 'managed install should be detected');
    assert.equal(detected?.executablePath, result.executablePath);

    // The staged progress walked through the expected lifecycle.
    assert.ok(stages.includes('downloading'), 'should report a downloading stage');
    assert.equal(stages.at(-1), 'validating', 'should finish on validating');
  });
});

test('installGodotEditor is idempotent once a managed install exists', async () => {
  await withManagedDir(async (_managedDir, userDataPath) => {
    const first = await installGodotEditor({ userDataPath, onStage: () => {}, hooks: stubHooks() });
    assert.equal(first.ok, true, first.message);

    // A second call must short-circuit to "already installed" instead of
    // re-downloading — the resolveAsset hook should never be invoked.
    let resolveCalled = false;
    const hooks = stubHooks();
    const second = await installGodotEditor({
      userDataPath,
      onStage: () => {},
      hooks: {
        ...hooks,
        resolveAsset: async (...args) => {
          resolveCalled = true;
          return hooks.resolveAsset!(...args);
        }
      }
    });
    assert.equal(second.ok, true);
    assert.match(second.message, /已安装/);
    assert.equal(resolveCalled, false, 'should not re-resolve a release when already installed');
  });
});

test('installGodotEditor fails clearly when extraction yields no binary', async () => {
  await withManagedDir(async (_managedDir, userDataPath) => {
    const result = await installGodotEditor({
      userDataPath,
      onStage: () => {},
      hooks: {
        ...stubHooks(),
        extract: async () => {
          /* extract produced nothing usable */
        }
      }
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /未.*找到.*可执行|可执行文件/);
  });
});
