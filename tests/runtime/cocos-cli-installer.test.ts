import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getCocosCliDir,
  findCocosCliInstallation,
  checkCocosCliPrerequisites,
  installCocosCli
} from '../../electron/main/cocos-cli-installer.ts';

test('getCocosCliDir defaults under userData and honors COCOS_CLI_DIR override', () => {
  const previous = process.env.COCOS_CLI_DIR;
  try {
    delete process.env.COCOS_CLI_DIR;
    assert.equal(getCocosCliDir('/data/user'), join('/data/user', 'cocos-cli'));
    process.env.COCOS_CLI_DIR = '/custom/cocos-cli';
    assert.equal(getCocosCliDir('/data/user'), '/custom/cocos-cli');
  } finally {
    if (typeof previous === 'undefined') {
      delete process.env.COCOS_CLI_DIR;
    } else {
      process.env.COCOS_CLI_DIR = previous;
    }
  }
});

test('findCocosCliInstallation detects a built cocos-cli (dist/cli.js present)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-cli-detect-'));
  const previous = process.env.COCOS_CLI_DIR;
  try {
    const cliDir = join(root, 'cocos-cli');
    process.env.COCOS_CLI_DIR = cliDir;
    // Not built yet.
    assert.equal(findCocosCliInstallation(root), undefined);
    // After a build produces dist/cli.js.
    await mkdir(join(cliDir, 'dist'), { recursive: true });
    await writeFile(join(cliDir, 'dist', 'cli.js'), '', 'utf8');
    const found = findCocosCliInstallation(root);
    assert.equal(found?.cliPath, join(cliDir, 'dist', 'cli.js'));
  } finally {
    if (typeof previous === 'undefined') {
      delete process.env.COCOS_CLI_DIR;
    } else {
      process.env.COCOS_CLI_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('checkCocosCliPrerequisites returns a well-formed report (node version captured)', () => {
  const prereqs = checkCocosCliPrerequisites();
  assert.equal(typeof prereqs.ok, 'boolean');
  assert.equal(typeof prereqs.nodeOk, 'boolean');
  assert.equal(typeof prereqs.gitOk, 'boolean');
  assert.ok(Array.isArray(prereqs.missing));
  // The test runner itself is node, so a node version is always detected.
  assert.match(prereqs.nodeVersion ?? '', /^v?\d+\./);
});

test('installCocosCli runs the staged orchestration and verifies the build product', async () => {
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-cli-install-'));
  const previous = process.env.COCOS_CLI_DIR;
  try {
    const cliDir = join(root, 'cocos-cli');
    process.env.COCOS_CLI_DIR = cliDir;
    const stages: string[] = [];
    const ranSteps: string[] = [];
    const result = await installCocosCli({
      userDataPath: root,
      onStage: (stage) => stages.push(stage),
      runStep: async (step) => {
        ranSteps.push(`${step.command} ${step.args[0]}`);
        // Simulate the build producing dist/cli.js on `npm install`.
        if (step.command === 'npm' && step.args.includes('install')) {
          await mkdir(join(cliDir, 'dist'), { recursive: true });
          await writeFile(join(cliDir, 'dist', 'cli.js'), '', 'utf8');
        }
        return { code: 0 };
      }
    });
    assert.equal(result.ok, true);
    assert.equal(result.cliPath, join(cliDir, 'dist', 'cli.js'));
    assert.deepEqual(ranSteps, ['git clone', 'npm run', 'npm install']);
    assert.ok(stages.includes('downloading'));
    assert.ok(stages.includes('installing'));
    assert.ok(stages.includes('validating'));
  } finally {
    if (typeof previous === 'undefined') {
      delete process.env.COCOS_CLI_DIR;
    } else {
      process.env.COCOS_CLI_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('installCocosCli aborts with the failing step when a subprocess exits non-zero', async () => {
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-cli-fail-'));
  const previous = process.env.COCOS_CLI_DIR;
  try {
    process.env.COCOS_CLI_DIR = join(root, 'cocos-cli');
    const result = await installCocosCli({
      userDataPath: root,
      onStage: () => undefined,
      // Fail on the engine-pull step.
      runStep: async (step) => (step.args.includes('init') ? { code: 1, stderrTail: 'boom' } : { code: 0 })
    });
    assert.equal(result.ok, false);
    assert.match(result.message, /失败（exit 1/);
  } finally {
    if (typeof previous === 'undefined') {
      delete process.env.COCOS_CLI_DIR;
    } else {
      process.env.COCOS_CLI_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('installCocosCli retries a transiently-failing clone and clears a partial checkout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-cli-retry-'));
  const previous = process.env.COCOS_CLI_DIR;
  try {
    const cliDir = join(root, 'cocos-cli');
    process.env.COCOS_CLI_DIR = cliDir;
    // A leftover partial checkout from an earlier failed run.
    await mkdir(cliDir, { recursive: true });
    await writeFile(join(cliDir, 'STALE.txt'), 'leftover', 'utf8');

    let cloneAttempts = 0;
    const result = await installCocosCli({
      userDataPath: root,
      onStage: () => undefined,
      runStep: async (step) => {
        if (step.command === 'git' && step.args[0] === 'clone') {
          cloneAttempts += 1;
          await mkdir(cliDir, { recursive: true });
          // First attempt fails transiently; the retry clears the dir and succeeds.
          return cloneAttempts === 1 ? { code: 1, stderrTail: 'fatal: unable to access (transient)' } : { code: 0 };
        }
        if (step.command === 'npm' && step.args.includes('install')) {
          await mkdir(join(cliDir, 'dist'), { recursive: true });
          await writeFile(join(cliDir, 'dist', 'cli.js'), '', 'utf8');
        }
        return { code: 0 };
      }
    });

    assert.equal(result.ok, true, result.message);
    assert.equal(cloneAttempts, 2, 'clone is retried once');
    assert.equal(existsSync(join(cliDir, 'STALE.txt')), false, 'pre-clean removes the partial checkout');
  } finally {
    if (typeof previous === 'undefined') {
      delete process.env.COCOS_CLI_DIR;
    } else {
      process.env.COCOS_CLI_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test('installCocosCli gives up after the retry cap and reports the captured error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'funplay-cocos-cli-giveup-'));
  const previous = process.env.COCOS_CLI_DIR;
  try {
    process.env.COCOS_CLI_DIR = join(root, 'cocos-cli');
    let cloneAttempts = 0;
    const result = await installCocosCli({
      userDataPath: root,
      onStage: () => undefined,
      runStep: async (step) => {
        if (step.command === 'git' && step.args[0] === 'clone') {
          cloneAttempts += 1;
          return { code: 128, stderrTail: 'fatal: repository not found' };
        }
        return { code: 0 };
      }
    });

    assert.equal(result.ok, false);
    assert.equal(cloneAttempts, 3, 'clone is retried up to the cap (3 attempts total)');
    assert.match(result.message, /repository not found/);
  } finally {
    if (typeof previous === 'undefined') {
      delete process.env.COCOS_CLI_DIR;
    } else {
      process.env.COCOS_CLI_DIR = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
});
