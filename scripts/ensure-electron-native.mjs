import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const packageRoot = process.cwd();
const binarySuffix = process.platform === 'win32' ? '.cmd' : '';
const electronBin = join(packageRoot, 'node_modules', '.bin', `electron${binarySuffix}`);
const electronRebuildBin = join(packageRoot, 'node_modules', '.bin', `electron-rebuild${binarySuffix}`);
const force = process.argv.includes('--force');

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: packageRoot,
    env: {
      ...process.env,
      ...options.env
    },
    encoding: 'utf8',
    stdio: options.stdio ?? 'pipe',
    shell: process.platform === 'win32'
  });
}

function checkBetterSqliteForElectron() {
  if (!existsSync(electronBin)) {
    return {
      ok: false,
      output: `Electron binary not found at ${electronBin}`
    };
  }

  const result = run(
    electronBin,
    [
      '-e',
      "require('better-sqlite3'); console.log(process.versions.modules)"
    ],
    {
      env: {
        ELECTRON_RUN_AS_NODE: '1'
      }
    }
  );

  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  };
}

function rebuildBetterSqliteForElectron() {
  if (!existsSync(electronRebuildBin)) {
    console.error(`electron-rebuild binary not found at ${electronRebuildBin}`);
    process.exit(1);
  }

  const result = run(electronRebuildBin, ['-f', '-w', 'better-sqlite3'], {
    stdio: 'inherit'
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const initialCheck = checkBetterSqliteForElectron();

if (!force && initialCheck.ok) {
  console.log(`better-sqlite3 is ready for Electron ABI ${initialCheck.output}.`);
  process.exit(0);
}

if (!initialCheck.ok) {
  console.warn('better-sqlite3 is not ready for Electron. Rebuilding native module...');
  console.warn(initialCheck.output);
}

rebuildBetterSqliteForElectron();

const finalCheck = checkBetterSqliteForElectron();
if (!finalCheck.ok) {
  console.error('better-sqlite3 still cannot load in Electron after rebuild.');
  console.error(finalCheck.output);
  process.exit(1);
}

console.log(`better-sqlite3 is ready for Electron ABI ${finalCheck.output}.`);
