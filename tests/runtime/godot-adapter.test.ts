import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createGodotProjectFromTemplate,
  detectGodotInstallations,
  findGodotInstallation,
  inspectGodotProject,
  installGodotBridge,
  isGodotBridgeInstalled
} from '../../electron/main/agent-platform/godot-adapter.ts';

async function withTempRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'funplay-godot-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('findGodotInstallation prefers an explicit GODOT_BIN override', async () => {
  await withTempRoot(async (root) => {
    const fakeBin = join(root, 'Godot_v4.3.1');
    await writeFile(fakeBin, '#!/bin/sh\n', 'utf8');
    const installation = findGodotInstallation({ ...process.env, GODOT_BIN: fakeBin });
    assert.ok(installation, 'an installation should be detected');
    assert.equal(installation?.executablePath, fakeBin);
    assert.equal(installation?.source, 'env:GODOT_BIN');
    assert.equal(installation?.version, '4.3.1');
  });
});

test(
  'detectGodotInstallations finds a Spotlight-located Godot.app outside the Applications roots',
  { skip: process.platform !== 'darwin' ? 'macOS-only detection path' : false },
  async () => {
    await withTempRoot(async (root) => {
      // A Godot.app kept somewhere unusual (e.g. ~/Downloads) — only Spotlight
      // would surface it; the fixed /Applications scan never would.
      const appBin = join(root, 'Godot.app', 'Contents', 'MacOS', 'Godot');
      await mkdir(dirname(appBin), { recursive: true });
      await writeFile(appBin, '#!/bin/sh\n', 'utf8');

      const installations = detectGodotInstallations({}, { spotlightApps: () => [join(root, 'Godot.app')] });
      const spotlightHit = installations.find((installation) => installation.source === 'macos:spotlight');
      assert.ok(spotlightHit, 'a Spotlight-located app should be detected');
      assert.equal(spotlightHit?.executablePath, appBin);
    });
  }
);

test('inspectGodotProject treats project.godot as the validity marker', async () => {
  await withTempRoot(async (root) => {
    const projectPath = join(root, 'game');
    await mkdir(projectPath, { recursive: true });
    assert.equal(inspectGodotProject(projectPath).valid, false, 'no project.godot yet');
    await writeFile(join(projectPath, 'project.godot'), 'config_version=5\n', 'utf8');
    const inspection = inspectGodotProject(projectPath);
    assert.equal(inspection.valid, true);
    assert.deepEqual(inspection.indicators, ['project.godot']);
  });
});

test('createGodotProjectFromTemplate bootstraps project.godot + dimension-typed main scene', async () => {
  await withTempRoot(async (root) => {
    const twoD = createGodotProjectFromTemplate({ targetProjectPath: join(root, 'g2d'), projectName: 'My 2D Game', dimension: '2d' });
    assert.equal(twoD.ok, true, twoD.summary);
    assert.ok(existsSync(join(root, 'g2d', 'project.godot')));
    assert.match(readFileSync(join(root, 'g2d', 'main.tscn'), 'utf8'), /type="Node2D"/);
    assert.match(readFileSync(join(root, 'g2d', 'project.godot'), 'utf8'), /config\/name="My 2D Game"/);
    assert.equal(inspectGodotProject(join(root, 'g2d')).valid, true);

    const threeD = createGodotProjectFromTemplate({ targetProjectPath: join(root, 'g3d'), projectName: 'g3d', dimension: '3d' });
    assert.equal(threeD.ok, true, threeD.summary);
    assert.match(readFileSync(join(root, 'g3d', 'main.tscn'), 'utf8'), /type="Node3D"/);
  });
});

test('installGodotBridge copies the addon from FUNPLAY_GODOT_MCP_LOCAL_SOURCE into addons/funplay_mcp', async () => {
  await withTempRoot(async (root) => {
    // A local bridge checkout: <source>/addons/funplay_mcp/{plugin.cfg,plugin.gd}.
    const source = join(root, 'bridge-src');
    const addon = join(source, 'addons', 'funplay_mcp');
    await mkdir(addon, { recursive: true });
    await writeFile(join(addon, 'plugin.cfg'), '[plugin]\nname="Funplay MCP for Godot"\n', 'utf8');
    await writeFile(join(addon, 'plugin.gd'), '@tool\nextends EditorPlugin\n', 'utf8');

    const projectPath = join(root, 'game');
    await mkdir(projectPath, { recursive: true });
    await writeFile(join(projectPath, 'project.godot'), 'config_version=5\n', 'utf8');

    const previous = process.env.FUNPLAY_GODOT_MCP_LOCAL_SOURCE;
    process.env.FUNPLAY_GODOT_MCP_LOCAL_SOURCE = source;
    try {
      assert.equal(isGodotBridgeInstalled(projectPath), false);
      const result = installGodotBridge({ projectPath });
      assert.equal(result.ok, true, result.summary);
      assert.equal(isGodotBridgeInstalled(projectPath), true);
      assert.ok(existsSync(join(projectPath, 'addons', 'funplay_mcp', 'plugin.cfg')));

      // Idempotent: a second install reports already-installed, not a conflict.
      const again = installGodotBridge({ projectPath });
      assert.equal(again.ok, true);
      assert.match(again.summary, /already installed/i);
    } finally {
      if (previous === undefined) {
        delete process.env.FUNPLAY_GODOT_MCP_LOCAL_SOURCE;
      } else {
        process.env.FUNPLAY_GODOT_MCP_LOCAL_SOURCE = previous;
      }
    }
  });
});

test('installGodotBridge refuses an invalid (non-Godot) project', async () => {
  await withTempRoot(async (root) => {
    const projectPath = join(root, 'not-a-game');
    await mkdir(projectPath, { recursive: true });
    const result = installGodotBridge({ projectPath });
    assert.equal(result.ok, false);
    assert.match(result.summary, /project valid: no/i);
  });
});
