import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import {
  ensureCocosCliServer,
  getCocosCliServer,
  stopCocosCliServer,
  stopAllCocosCliServers,
  findFreePort,
  createCocosProjectViaCli
} from '../../electron/main/cocos-cli-server.ts';

function makeFakeChild(): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess & { exitCode: number | null; killed: boolean };
  child.exitCode = null;
  child.killed = false;
  child.kill = ((): boolean => {
    child.killed = true;
    child.exitCode = 0;
    child.emit('exit', 0);
    return true;
  }) as ChildProcess['kill'];
  return child;
}

test('findFreePort returns a usable TCP port', async () => {
  const port = await findFreePort();
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
});

test('ensureCocosCliServer spawns, waits for ready, and exposes the /mcp endpoint', async () => {
  const projectPath = '/tmp/funplay-cocos4-a';
  let spawnCount = 0;
  try {
    const handle = await ensureCocosCliServer({
      projectPath,
      cliPath: '/fake/dist/cli.js',
      spawner: () => {
        spawnCount += 1;
        return makeFakeChild();
      },
      readyProbe: async () => true
    });
    assert.equal(handle.projectPath, projectPath);
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.equal(handle.port > 0, true);
    assert.equal(spawnCount, 1);

    // A second ensure for the same project reuses the live server (no re-spawn).
    const reused = await ensureCocosCliServer({
      projectPath,
      cliPath: '/fake/dist/cli.js',
      spawner: () => {
        spawnCount += 1;
        return makeFakeChild();
      },
      readyProbe: async () => true
    });
    assert.equal(reused.url, handle.url);
    assert.equal(spawnCount, 1);
    assert.equal(getCocosCliServer(projectPath)?.url, handle.url);
  } finally {
    await stopCocosCliServer(projectPath);
  }
  assert.equal(getCocosCliServer(projectPath), undefined);
});

test('ensureCocosCliServer throws and cleans up when the server never becomes ready', async () => {
  const projectPath = '/tmp/funplay-cocos4-b';
  try {
    await assert.rejects(
      ensureCocosCliServer({
        projectPath,
        cliPath: '/fake/dist/cli.js',
        spawner: () => makeFakeChild(),
        readyProbe: async () => false
      }),
      /未能在端口/
    );
    // The failed attempt must not leave a registered server behind.
    assert.equal(getCocosCliServer(projectPath), undefined);
  } finally {
    await stopAllCocosCliServers();
  }
});

test('createCocosProjectViaCli passes the dimension flag and reports success / failure', async () => {
  let invoked: string[] = [];
  const ok = await createCocosProjectViaCli({
    cliPath: '/fake/dist/cli.js',
    projectPath: '/tmp/MyGame',
    dimension: '3d',
    run: async (command, args) => {
      invoked = [command, ...args];
      return { code: 0 };
    }
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(invoked, ['node', '/fake/dist/cli.js', 'create', '--project', '/tmp/MyGame', '--type', '3d']);

  const failed = await createCocosProjectViaCli({
    cliPath: '/fake/dist/cli.js',
    projectPath: '/tmp/MyGame',
    dimension: '2d',
    run: async () => ({ code: 2, stderrTail: 'nope' })
  });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /失败（exit 2）/);
});

test('a server whose process exits is no longer reported as running', async () => {
  const projectPath = '/tmp/funplay-cocos4-c';
  const child = makeFakeChild();
  try {
    const handle = await ensureCocosCliServer({
      projectPath,
      cliPath: '/fake/dist/cli.js',
      spawner: () => child,
      readyProbe: async () => true
    });
    assert.equal(getCocosCliServer(projectPath)?.url, handle.url);
    // Simulate the headless server dying.
    (child as unknown as { exitCode: number | null }).exitCode = 1;
    child.emit('exit', 1);
    assert.equal(getCocosCliServer(projectPath), undefined);
  } finally {
    await stopAllCocosCliServers();
  }
});
