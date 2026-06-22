import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getActiveProjectSession } from '../../shared/project-sessions.ts';
import { buildGenericWorkspaceContext } from '../../electron/main/agent-platform/context.ts';
import {
  collectActiveVerificationChangeSummary,
  collectActiveVerificationRepairEvidence,
  createActiveVerificationRepairPrompt,
  diagnoseActiveVerificationFailure,
  formatActiveVerificationFailureReply,
  planActiveVerification,
  runActiveVerificationGate
} from '../../electron/main/agent-platform/active-verification.ts';
import { updateVerificationReportFromToolResult, createVerificationReport } from '../../electron/main/agent-platform/verification-loop.ts';
import { executeAgentToolAction } from '../../electron/main/agent-platform/workspace-tools.ts';
import { buildProject } from './test-helpers.ts';

test('active verification planner chooses package test script for write-triggered checks', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-plan-'));
  try {
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({
      type: 'module',
      scripts: {
        test: 'node acceptance.test.mjs',
        build: 'tsc --noEmit'
      }
    }, null, 2));
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '写入 src/output.txt');
    const plan = planActiveVerification({
      project,
      message: '写入 src/output.txt',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write');

    assert.equal(plan?.blocking, true);
    assert.equal(plan?.trigger, 'active_write');
    assert.equal(plan?.checks[0]?.kind, 'test');
    assert.equal(plan?.checks[0]?.command, 'npm test');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner honors packageManager field for root package scripts', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-package-manager-'));
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src/app.ts'), 'export const ok = true;\n');
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({
      type: 'module',
      packageManager: 'pnpm@9.12.0',
      scripts: {
        typecheck: 'tsc --noEmit',
        test: 'vitest run'
      }
    }, null, 2));
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 src/app.ts');
    const plan = planActiveVerification({
      project,
      message: '修改 src/app.ts',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['src/app.ts']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), ['pnpm run typecheck', 'pnpm test']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner uses project quality script when test and build scripts are absent', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-quality-script-'));
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src/app.ts'), 'export const ok = true;\n');
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({
      type: 'module',
      packageManager: 'pnpm@9.12.0',
      scripts: {
        check: 'tsc --noEmit && eslint src'
      }
    }, null, 2));
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 src/app.ts');
    const plan = planActiveVerification({
      project,
      message: '修改 src/app.ts',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['src/app.ts']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), ['pnpm run check']);
    assert.deepEqual(plan?.checks.map((check) => check.title), ['Run project quality check']);
    assert.deepEqual(plan?.checks.map((check) => check.kind), ['command']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner uses nearest package manager for monorepo package scripts', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-nearest-pm-'));
  try {
    await mkdir(join(projectPath, 'packages/ui/src'), { recursive: true });
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({
      type: 'module',
      packageManager: 'npm@10.8.0',
      scripts: {
        test: 'node --test'
      }
    }, null, 2));
    await writeFile(join(projectPath, 'packages/ui/package.json'), JSON.stringify({
      type: 'module',
      scripts: {
        typecheck: 'tsc --noEmit',
        test: 'bun-test-runner'
      }
    }, null, 2));
    await writeFile(join(projectPath, 'packages/ui/bun.lock'), '');
    await writeFile(join(projectPath, 'packages/ui/src/button.ts'), 'export const label = "ok";\n');
    await writeFile(join(projectPath, 'packages/ui/src/button.test.ts'), 'import { test } from "bun:test";\n');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 packages/ui/src/button.ts');
    const plan = planActiveVerification({
      project,
      message: '修改 packages/ui/src/button.ts',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['packages/ui/src/button.ts']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), [
      'bun run typecheck',
      'bun run test -- src/button.test.ts',
      'bun run test'
    ]);
    assert.deepEqual(plan?.checks.map((check) => check.cwd), ['packages/ui', 'packages/ui', 'packages/ui']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner selects focused checks from changed source files', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-source-'));
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src/app.ts'), 'export const ok = true;\n');
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({
      type: 'module',
      scripts: {
        typecheck: 'tsc --noEmit',
        test: 'node --test',
        build: 'vite build'
      }
    }, null, 2));
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 src/app.ts');
    const plan = planActiveVerification({
      project,
      message: '修改 src/app.ts',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['src/app.ts']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), ['npm run typecheck', 'npm test']);
    assert.deepEqual(plan?.checks.map((check) => check.kind), ['build', 'test']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner targets tests related to changed source files', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-related-source-'));
  try {
    await mkdir(join(projectPath, 'src/utils'), { recursive: true });
    await writeFile(join(projectPath, 'src/utils/math.ts'), 'export const add = (a: number, b: number) => a + b;\n');
    await writeFile(join(projectPath, 'src/utils/math.test.ts'), 'import test from "node:test";\n');
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({
      type: 'module',
      scripts: {
        typecheck: 'tsc --noEmit',
        test: 'node --test'
      }
    }, null, 2));
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 src/utils/math.ts');
    const plan = planActiveVerification({
      project,
      message: '修改 src/utils/math.ts',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['src/utils/math.ts']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), [
      'npm run typecheck',
      'npm test -- src/utils/math.test.ts',
      'npm test'
    ]);
    assert.deepEqual(plan?.checks.map((check) => check.title), ['Run type check', 'Run related tests', 'Run automatic tests']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner uses nearest package scripts for monorepo source changes', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-monorepo-source-'));
  try {
    await mkdir(join(projectPath, 'packages/ui/src'), { recursive: true });
    await writeFile(join(projectPath, 'packages/ui/package.json'), JSON.stringify({
      type: 'module',
      scripts: {
        typecheck: 'tsc --noEmit',
        test: 'vitest run'
      }
    }, null, 2));
    await writeFile(join(projectPath, 'packages/ui/src/button.ts'), 'export const label = "ok";\n');
    await writeFile(join(projectPath, 'packages/ui/src/button.test.ts'), 'import { test } from "vitest";\n');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 packages/ui/src/button.ts');
    const plan = planActiveVerification({
      project,
      message: '修改 packages/ui/src/button.ts',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['packages/ui/src/button.ts']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), [
      'npm run typecheck',
      'npm test -- src/button.test.ts',
      'npm test'
    ]);
    assert.deepEqual(plan?.checks.map((check) => check.cwd), ['packages/ui', 'packages/ui', 'packages/ui']);
    assert.deepEqual(plan?.checks.map((check) => check.title), ['Run package type check', 'Run related tests', 'Run package tests']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner uses nearest package scripts for monorepo test changes', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-monorepo-test-'));
  try {
    await mkdir(join(projectPath, 'packages/ui/tests'), { recursive: true });
    await writeFile(join(projectPath, 'packages/ui/package.json'), JSON.stringify({
      type: 'module',
      scripts: {
        typecheck: 'tsc --noEmit',
        test: 'vitest run'
      }
    }, null, 2));
    await writeFile(join(projectPath, 'packages/ui/tests/button.test.ts'), 'import { test } from "vitest";\n');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 packages/ui/tests/button.test.ts');
    const plan = planActiveVerification({
      project,
      message: '修改 packages/ui/tests/button.test.ts',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['packages/ui/tests/button.test.ts']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), [
      'npm test -- tests/button.test.ts',
      'npm run typecheck'
    ]);
    assert.deepEqual(plan?.checks.map((check) => check.cwd), ['packages/ui', 'packages/ui']);
    assert.deepEqual(plan?.checks.map((check) => check.title), ['Run targeted tests', 'Run package type check']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner falls back to Python compile checks without package scripts', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-python-'));
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'pyproject.toml'), '[project]\nname = "demo"\n');
    await writeFile(join(projectPath, 'src/app.py'), 'VALUE = 1\n');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 src/app.py');
    const plan = planActiveVerification({
      project,
      message: '修改 src/app.py',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['src/app.py']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), ['python -m py_compile src/app.py']);
    assert.deepEqual(plan?.checks.map((check) => check.title), ['Run Python compile check']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner targets Python tests related to changed source files', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-python-related-'));
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await mkdir(join(projectPath, 'tests'), { recursive: true });
    await writeFile(join(projectPath, 'pyproject.toml'), '[project]\nname = "demo"\n');
    await writeFile(join(projectPath, 'src/app.py'), 'VALUE = 1\n');
    await writeFile(join(projectPath, 'tests/test_app.py'), 'def test_ok():\n    assert True\n');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 src/app.py');
    const plan = planActiveVerification({
      project,
      message: '修改 src/app.py',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['src/app.py']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), [
      'python -m py_compile src/app.py',
      'python -m pytest tests/test_app.py'
    ]);
    assert.deepEqual(plan?.checks.map((check) => check.title), ['Run Python compile check', 'Run related Python tests']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner runs targeted Python tests for changed test files', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-python-test-'));
  try {
    await mkdir(join(projectPath, 'tests'), { recursive: true });
    await writeFile(join(projectPath, 'pyproject.toml'), '[project]\nname = "demo"\n');
    await writeFile(join(projectPath, 'tests/test_app.py'), 'def test_ok():\n    assert True\n');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 tests/test_app.py');
    const plan = planActiveVerification({
      project,
      message: '修改 tests/test_app.py',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['tests/test_app.py']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), [
      'python -m pytest tests/test_app.py',
      'python -m py_compile tests/test_app.py'
    ]);
    assert.deepEqual(plan?.checks.map((check) => check.kind), ['test', 'build']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner targets Go package tests related to changed source files', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-go-related-'));
  try {
    await mkdir(join(projectPath, 'pkg/calc'), { recursive: true });
    await writeFile(join(projectPath, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
    await writeFile(join(projectPath, 'pkg/calc/calc.go'), 'package calc\n\nfunc Value() int { return 1 }\n');
    await writeFile(join(projectPath, 'pkg/calc/calc_test.go'), 'package calc\n\nimport "testing"\n\nfunc TestValue(t *testing.T) {}\n');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 pkg/calc/calc.go');
    const plan = planActiveVerification({
      project,
      message: '修改 pkg/calc/calc.go',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['pkg/calc/calc.go']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), ['go test ./pkg/calc', 'go test ./...']);
    assert.deepEqual(plan?.checks.map((check) => check.title), ['Run related Go tests', 'Run Go tests']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner targets Go package tests for changed test files', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-go-test-'));
  try {
    await mkdir(join(projectPath, 'pkg/calc'), { recursive: true });
    await writeFile(join(projectPath, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
    await writeFile(join(projectPath, 'pkg/calc/calc_test.go'), 'package calc\n\nimport "testing"\n\nfunc TestValue(t *testing.T) {}\n');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 pkg/calc/calc_test.go');
    const plan = planActiveVerification({
      project,
      message: '修改 pkg/calc/calc_test.go',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['pkg/calc/calc_test.go']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), ['go test ./pkg/calc', 'go test ./...']);
    assert.deepEqual(plan?.checks.map((check) => check.title), ['Run targeted Go tests', 'Run Go tests']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner falls back to Go module tests without package scripts', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-go-'));
  try {
    await writeFile(join(projectPath, 'go.mod'), 'module example.com/demo\n\ngo 1.22\n');
    await writeFile(join(projectPath, 'main.go'), 'package main\n\nfunc main() {}\n');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 main.go');
    const plan = planActiveVerification({
      project,
      message: '修改 main.go',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['main.go']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), ['go test ./...']);
    assert.deepEqual(plan?.checks.map((check) => check.title), ['Run Go tests']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner falls back to Rust cargo tests without package scripts', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-rust-'));
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'Cargo.toml'), '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n');
    await writeFile(join(projectPath, 'src/lib.rs'), 'pub fn value() -> i32 { 1 }\n');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 src/lib.rs');
    const plan = planActiveVerification({
      project,
      message: '修改 src/lib.rs',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['src/lib.rs']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), ['cargo test']);
    assert.deepEqual(plan?.checks.map((check) => check.title), ['Run Rust tests']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner includes browser e2e checks for UI surface changes', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-browser-'));
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src/App.tsx'), 'export function App() { return <main />; }\n');
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({
      type: 'module',
      scripts: {
        typecheck: 'tsc --noEmit',
        test: 'node --test',
        'test:e2e': 'playwright test'
      },
      devDependencies: {
        '@playwright/test': '^1.0.0'
      }
    }, null, 2));
    await writeFile(join(projectPath, 'playwright.config.ts'), 'export default {};\n');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 src/App.tsx');
    const plan = planActiveVerification({
      project,
      message: '修改 src/App.tsx',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['src/App.tsx']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), ['npm run typecheck', 'npm test', 'npm run test:e2e']);
    assert.deepEqual(plan?.checks.map((check) => check.kind), ['build', 'test', 'browser']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner keeps browser e2e checks for UI changes with related tests', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-browser-related-'));
  try {
    await mkdir(join(projectPath, 'src/components'), { recursive: true });
    await writeFile(join(projectPath, 'src/components/Button.tsx'), 'export function Button() { return <button />; }\n');
    await writeFile(join(projectPath, 'src/components/Button.test.tsx'), 'import test from "node:test";\n');
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({
      type: 'module',
      scripts: {
        typecheck: 'tsc --noEmit',
        test: 'node --test',
        'test:e2e': 'playwright test'
      },
      devDependencies: {
        '@playwright/test': '^1.0.0'
      }
    }, null, 2));
    await writeFile(join(projectPath, 'playwright.config.ts'), 'export default {};\n');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 src/components/Button.tsx');
    const plan = planActiveVerification({
      project,
      message: '修改 src/components/Button.tsx',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['src/components/Button.tsx']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), [
      'npm run typecheck',
      'npm test -- src/components/Button.test.tsx',
      'npm run test:e2e'
    ]);
    assert.deepEqual(plan?.checks.map((check) => check.kind), ['build', 'test', 'browser']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner records omitted checks after max plan size', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-omitted-'));
  try {
    await mkdir(join(projectPath, 'src/components'), { recursive: true });
    await writeFile(join(projectPath, 'src/components/Button.tsx'), 'export function Button() { return <button />; }\n');
    await writeFile(join(projectPath, 'src/components/Button.test.tsx'), 'import test from "node:test";\n');
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({
      type: 'module',
      scripts: {
        typecheck: 'tsc --noEmit',
        test: 'node --test',
        'test:e2e': 'playwright test',
        lint: 'eslint .'
      },
      devDependencies: {
        '@playwright/test': '^1.0.0'
      }
    }, null, 2));
    await writeFile(join(projectPath, 'playwright.config.ts'), 'export default {};\n');
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 src/components/Button.tsx');
    const plan = planActiveVerification({
      project,
      message: '修改 src/components/Button.tsx',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['src/components/Button.tsx']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), [
      'npm run typecheck',
      'npm test -- src/components/Button.test.tsx',
      'npm run test:e2e'
    ]);
    assert.deepEqual(plan?.omittedChecks?.map((check) => ({
      command: check.command,
      reason: check.reason
    })), [
      { command: 'npm test', reason: 'max_checks' },
      { command: 'npm run lint', reason: 'max_checks' }
    ]);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner targets changed unit test files', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-targeted-unit-'));
  try {
    await mkdir(join(projectPath, 'tests/runtime'), { recursive: true });
    await writeFile(join(projectPath, 'tests/runtime/foo.test.ts'), 'import test from "node:test";\n');
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({
      type: 'module',
      scripts: {
        typecheck: 'tsc --noEmit',
        test: 'node --test'
      }
    }, null, 2));
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 tests/runtime/foo.test.ts');
    const plan = planActiveVerification({
      project,
      message: '修改 tests/runtime/foo.test.ts',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['tests/runtime/foo.test.ts']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), ['npm test -- tests/runtime/foo.test.ts', 'npm run typecheck']);
    assert.deepEqual(plan?.checks.map((check) => check.title), ['Run targeted tests', 'Run type check']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification planner prioritizes e2e script for e2e test changes', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-e2e-test-'));
  try {
    await mkdir(join(projectPath, 'tests/e2e'), { recursive: true });
    await writeFile(join(projectPath, 'tests/e2e/home.spec.ts'), 'import { test } from "@playwright/test";\n');
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({
      type: 'module',
      scripts: {
        typecheck: 'tsc --noEmit',
        test: 'node --test',
        e2e: 'playwright test'
      }
    }, null, 2));
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 tests/e2e/home.spec.ts');
    const plan = planActiveVerification({
      project,
      message: '修改 tests/e2e/home.spec.ts',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, 'active_write', {
      changedFiles: ['tests/e2e/home.spec.ts']
    });

    assert.deepEqual(plan?.checks.map((check) => check.command), ['npm run e2e -- tests/e2e/home.spec.ts', 'npm run typecheck', 'npm test']);
    assert.deepEqual(plan?.checks.map((check) => check.title), ['Run targeted browser/e2e verification', 'Run type check', 'Run automatic tests']);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification repair evidence reads changed files and failure paths', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-repair-evidence-'));
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src/broken.ts'), [
      'export function marker() {',
      "  return 'BROKEN_MARKER';",
      '}',
      ''
    ].join('\n'));
    const artifactContent = [
      'BEGIN_SHOULD_BE_TRUNCATED',
      'x'.repeat(16_000),
      'TAIL_FAILURE_CONTEXT: expected OK but got BROKEN_MARKER'
    ].join('\n');
    const artifactPath = join(projectPath, 'active-verify-output.txt');
    await writeFile(artifactPath, artifactContent);
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修复 src/broken.ts');
    const params = {
      project,
      message: '修复 src/broken.ts',
      plugins: [],
      context,
      permission: {
        mode: 'full-access' as const,
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    };
    const verification = {
      status: 'failed' as const,
      trigger: 'active_write' as const,
      blocking: true,
      summary: 'Active verification: 0/1 passed, 1 failed.',
      checks: [{
        id: 'active_verify_test',
        kind: 'test' as const,
        title: 'Run automatic tests',
        command: 'npm test',
        required: true,
        status: 'failed' as const,
        errorMessage: 'AssertionError: expected OK\n    at src/broken.ts:2:10',
        artifacts: [{
          type: 'command_output' as const,
          path: artifactPath,
          title: 'npm test',
          size: Buffer.byteLength(artifactContent, 'utf8')
        }]
      }, {
        id: 'active_verify_typecheck',
        kind: 'build' as const,
        title: 'Run type check',
        command: 'npm run typecheck',
        required: true,
        status: 'passed' as const
      }],
      omittedChecks: [{
        id: 'active_verify_lint',
        kind: 'command' as const,
        title: 'Run linter',
        command: 'npm run lint',
        required: true,
        reason: 'max_checks' as const
      }]
    };

    const evidence = collectActiveVerificationRepairEvidence(params, verification, {
      changedFiles: ['src/broken.ts']
    });
    assert.equal(evidence[0]?.path, 'src/broken.ts');
    assert.equal(evidence[0]?.source, 'changed_file');
    assert.match(evidence[0]?.excerpt ?? '', /BROKEN_MARKER/);
    assert.ok(evidence.some((file) => file.source === 'verification_output' && file.line === 2));

    const prompt = createActiveVerificationRepairPrompt({
      originalUserMessage: params.message,
      verification,
      relatedFiles: evidence,
      changeSummary: {
        source: 'changed_files',
        summary: 'Changed files recorded during this run:\n- src/broken.ts'
      }
    });
    assert.match(prompt, /Relevant files from failed verification/);
    assert.match(prompt, /Failure diagnosis|Changes to inspect/);
    assert.match(prompt, /Verification checks from failed run/);
    assert.match(prompt, /Run type check \[passed, required\]/);
    assert.match(prompt, /Omitted verification candidates from failed plan/);
    assert.match(prompt, /Run linter \[max_checks\]/);
    assert.match(prompt, /Artifact 1: npm test/);
    assert.match(prompt, /active-verify-output\.txt/);
    assert.match(prompt, /Excerpt \(tail, truncated\)/);
    assert.match(prompt, /TAIL_FAILURE_CONTEXT/);
    assert.doesNotMatch(prompt, /BEGIN_SHOULD_BE_TRUNCATED/);
    assert.match(prompt, /src\/broken\.ts/);
    assert.match(prompt, /BROKEN_MARKER/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification classifies failure kind for targeted repair', () => {
  const diagnosis = diagnoseActiveVerificationFailure([{
    id: 'active_verify_typecheck',
    kind: 'build',
    title: 'Run type check',
    command: 'npm run typecheck',
    required: true,
    status: 'failed',
    errorMessage: "src/app.ts:4:7 - error TS2322: Type 'string' is not assignable to type 'number'."
  }]);

  assert.equal(diagnosis?.kind, 'type_error');
  assert.match(diagnosis?.suggestedFocus ?? '', /type/i);
  assert.ok(diagnosis?.evidence.some((line) => /TS2322/.test(line)));
  assert.deepEqual(diagnosis?.references?.[0], {
    path: 'src/app.ts',
    line: 4,
    column: 7
  });
});

test('active verification diagnosis extracts Python traceback line references', () => {
  const diagnosis = diagnoseActiveVerificationFailure([{
    id: 'active_verify_python_compile',
    kind: 'build',
    title: 'Run Python compile check',
    command: 'python -m py_compile src/app.py',
    required: true,
    status: 'failed',
    errorMessage: [
      '  File "src/app.py", line 2',
      '    if True print("missing colon")',
      '            ^',
      'SyntaxError: invalid syntax'
    ].join('\n')
  }]);

  assert.equal(diagnosis?.kind, 'build_error');
  assert.match(diagnosis?.suggestedFocus ?? '', /Python syntax/i);
  assert.deepEqual(diagnosis?.references?.[0], {
    path: 'src/app.py',
    line: 2
  });
});

test('active verification diagnosis treats missing pytest runner as missing command', () => {
  const diagnosis = diagnoseActiveVerificationFailure([{
    id: 'active_verify_python_related_test',
    kind: 'test',
    title: 'Run related Python tests',
    command: 'python -m pytest tests/test_app.py',
    required: true,
    status: 'failed',
    errorMessage: "/usr/bin/python: No module named pytest"
  }]);

  assert.equal(diagnosis?.kind, 'missing_command');
  assert.match(diagnosis?.suggestedFocus ?? '', /verification runner/i);
  assert.ok(diagnosis?.evidence.some((line) => /pytest/.test(line)));
});

test('active verification diagnosis treats missing JS test runner as missing command', () => {
  const diagnosis = diagnoseActiveVerificationFailure([{
    id: 'active_verify_test',
    kind: 'test',
    title: 'Run automatic tests',
    command: 'npm test',
    required: true,
    status: 'failed',
    errorMessage: "Error: Cannot find module '/workspace/node_modules/vitest/vitest.mjs'"
  }]);

  assert.equal(diagnosis?.kind, 'missing_command');
  assert.match(diagnosis?.suggestedFocus ?? '', /dependency|runner|script/i);
});

test('active verification diagnosis treats Go test compile errors as build errors', () => {
  const diagnosis = diagnoseActiveVerificationFailure([{
    id: 'active_verify_go_related_test',
    kind: 'test',
    title: 'Run related Go tests',
    command: 'go test ./pkg/calc',
    required: true,
    status: 'failed',
    errorMessage: [
      '# example.com/demo/pkg/calc',
      'pkg/calc/calc.go:4:9: undefined: missingValue',
      'FAIL\texample.com/demo/pkg/calc [build failed]'
    ].join('\n')
  }]);

  assert.equal(diagnosis?.kind, 'build_error');
  assert.match(diagnosis?.suggestedFocus ?? '', /Go compile/i);
  assert.deepEqual(diagnosis?.references?.[0], {
    path: 'pkg/calc/calc.go',
    line: 4,
    column: 9
  });
});

test('active verification diagnosis treats Rust cargo compile errors as build errors', () => {
  const diagnosis = diagnoseActiveVerificationFailure([{
    id: 'active_verify_rust_test',
    kind: 'test',
    title: 'Run Rust tests',
    command: 'cargo test',
    required: true,
    status: 'failed',
    errorMessage: [
      'error[E0425]: cannot find value `missing` in this scope',
      ' --> src/lib.rs:2:5',
      '  |',
      '2 |     missing',
      '  |     ^^^^^^^ not found in this scope'
    ].join('\n')
  }]);

  assert.equal(diagnosis?.kind, 'build_error');
  assert.match(diagnosis?.suggestedFocus ?? '', /Rust compile/i);
  assert.deepEqual(diagnosis?.references?.[0], {
    path: 'src/lib.rs',
    line: 2,
    column: 5
  });
});

test('active verification repair evidence uses diagnosis file references', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-diagnosis-reference-'));
  try {
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src/from-diagnosis.ts'), [
      'export function value() {',
      "  return 'REFERENCE_MARKER';",
      '}',
      ''
    ].join('\n'));
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修复验证失败');
    const verification = {
      status: 'failed' as const,
      trigger: 'active_write' as const,
      blocking: true,
      summary: 'Active verification: 0/1 passed, 1 failed.',
      diagnosis: {
        kind: 'test_assertion' as const,
        summary: 'test_assertion in Run automatic tests',
        evidence: ['command=npm test'],
        references: [{
          path: 'src/from-diagnosis.ts',
          line: 2,
          column: 10
        }],
        suggestedFocus: 'Use the referenced file to repair behavior.'
      },
      checks: [{
        id: 'active_verify_test',
        kind: 'test' as const,
        title: 'Run automatic tests',
        command: 'npm test',
        required: true,
        status: 'failed' as const,
        errorMessage: 'AssertionError: expected OK'
      }]
    };

    const evidence = collectActiveVerificationRepairEvidence({
      project,
      message: '修复验证失败',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, verification);

    assert.equal(evidence[0]?.path, 'src/from-diagnosis.ts');
    assert.equal(evidence[0]?.line, 2);
    assert.equal(evidence[0]?.source, 'verification_output');
    assert.match(evidence[0]?.excerpt ?? '', /REFERENCE_MARKER/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification change summary falls back to changed file metadata', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-change-summary-'));
  try {
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '修改 src/app.ts');
    const summary = await collectActiveVerificationChangeSummary({
      project,
      message: '修改 src/app.ts',
      plugins: [],
      context,
      permission: {
        mode: 'full-access',
        allowWriteTools: true,
        allowSessionWriteTools: true
      }
    }, {
      changedFiles: ['src/app.ts', 'src/app.ts', '../escape.ts']
    });

    assert.equal(summary?.source, 'changed_files');
    assert.match(summary?.summary ?? '', /src\/app\.ts/);
    assert.doesNotMatch(summary?.summary ?? '', /escape/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('verification report records active command checks with blocking metadata', () => {
  const report = createVerificationReport({
    runId: 'arun_active_verify',
    createdAt: '2026-05-28T00:00:00.000Z'
  });
  const planMetadata = JSON.stringify({
    plannedChecks: [
      {
        id: 'active_verify_typecheck',
        kind: 'build',
        title: 'Run type check',
        command: 'npm run typecheck',
        cwd: '.',
        target: 'npm run typecheck',
        required: true
      },
      {
        id: 'active_verify_test',
        kind: 'test',
        title: 'Run automatic tests',
        command: 'npm test',
        cwd: '.',
        target: 'npm test',
        required: true
      }
    ],
    omittedChecks: [
      {
        id: 'active_verify_lint',
        kind: 'command',
        title: 'Run linter',
        command: 'npm run lint',
        cwd: '.',
        target: 'npm run lint',
        required: true,
        reason: 'max_checks'
      }
    ],
    sideEffects: [
      {
        toolName: 'run_command',
        kind: 'workspace_write',
        confidence: 'high',
        verificationTrigger: 'active_write',
        evidence: ['tool:command', 'command:node_file_write']
      }
    ]
  });
  const updated = updateVerificationReportFromToolResult(report, {
    toolUseId: 'tool_verify',
    toolName: 'run_command',
    content: `[Active verification]\nTrigger: active_write\nBlocking: yes\nPlan metadata: ${planMetadata}\nCheck: Run automatic tests\nDiagnosis: type_error\nSuggested focus: Repair type contracts.\nDiagnosis evidence: src/app.ts:1:1 - error TS2322\nDiagnosis reference: src/app.ts:1:1\n\nfailed`,
    command: {
      command: 'npm test',
      cwd: '.',
      exitCode: 1,
      timedOut: false,
      stdout: 'failed',
      stderr: 'src/app.ts:1:1 - error TS2322'
    },
    artifacts: [{
      type: 'command_output',
      path: '/tmp/funplay-agent-artifacts/test.txt',
      title: 'npm test'
    }]
  }, '2026-05-28T00:00:01.000Z');

  assert.equal(updated?.trigger, 'active_write');
  assert.equal(updated?.blocking, true);
  assert.deepEqual(updated?.plannedChecks?.map((check) => check.command), ['npm run typecheck', 'npm test']);
  assert.deepEqual(updated?.omittedChecks?.map((check) => ({
    command: check.command,
    reason: check.reason
  })), [{
    command: 'npm run lint',
    reason: 'max_checks'
  }]);
  assert.deepEqual(updated?.sideEffects, [{
    toolName: 'run_command',
    kind: 'workspace_write',
    confidence: 'high',
    verificationTrigger: 'active_write',
    evidence: ['tool:command', 'command:node_file_write']
  }]);
  assert.equal(updated?.checks[0]?.kind, 'test');
  assert.equal(updated?.checks[0]?.status, 'failed');
  assert.equal(updated?.failureDiagnosis?.kind, 'type_error');
  assert.match(updated?.failureDiagnosis?.suggestedFocus ?? '', /type contracts/);
  assert.deepEqual(updated?.failureDiagnosis?.references?.[0], {
    path: 'src/app.ts',
    line: 1,
    column: 1
  });
  assert.equal(updated?.checks[0]?.artifacts?.[0]?.type, 'command_output');
});

test('active verification gate emits plan metadata for verification reports', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-active-verify-gate-plan-'));
  try {
    const project = buildProject(projectPath);
    const context = buildGenericWorkspaceContext(project, [], getActiveProjectSession(project).id, '验证命令');
    const toolResults: Array<Parameters<typeof updateVerificationReportFromToolResult>[1]> = [];
    const result = await runActiveVerificationGate({
      params: {
        project,
        message: '验证命令',
        plugins: [],
        context,
        permission: {
          mode: 'full-access',
          allowWriteTools: true,
          allowSessionWriteTools: true
        }
      },
      plan: {
        trigger: 'active_write',
        blocking: true,
        checks: [{
          id: 'active_verify_test',
          kind: 'test',
          title: 'Run automatic tests',
          command: 'node -e "console.log(\'test passed\')"',
          target: 'node test command',
          required: true
        }],
        omittedChecks: [{
          id: 'active_verify_lint',
          kind: 'command',
          title: 'Run linter',
          command: 'npm run lint',
          target: 'npm run lint',
          required: true,
          reason: 'max_checks'
        }],
        sideEffects: [{
          toolName: 'run_command',
          kind: 'workspace_write',
          confidence: 'high',
          verificationTrigger: 'active_write',
          evidence: ['tool:command', 'command:node_file_write']
        }]
      },
      emitStage: () => undefined,
      emitToolUse: () => undefined,
      emitToolResult: (toolResult) => {
        toolResults.push(toolResult);
      }
    });
    const report = createVerificationReport({
      runId: 'arun_active_verify_gate',
      createdAt: '2026-05-28T00:00:00.000Z'
    });
    const updated = updateVerificationReportFromToolResult(report, toolResults[0]!, '2026-05-28T00:00:01.000Z');

    assert.equal(result.status, 'passed');
    assert.match(toolResults[0]?.content ?? '', /^Plan metadata:/m);
    assert.match(toolResults[0]?.content ?? '', /command:node_file_write/);
    assert.deepEqual(updated?.plannedChecks?.map((check) => check.command), ['node -e "console.log(\'test passed\')"']);
    assert.deepEqual(updated?.omittedChecks?.map((check) => ({
      command: check.command,
      reason: check.reason
    })), [{
      command: 'npm run lint',
      reason: 'max_checks'
    }]);
    assert.deepEqual(updated?.sideEffects, [{
      toolName: 'run_command',
      kind: 'workspace_write',
      confidence: 'high',
      verificationTrigger: 'active_write',
      evidence: ['tool:command', 'command:node_file_write']
    }]);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('active verification failure reply includes omitted verification candidates', () => {
  const reply = formatActiveVerificationFailureReply('已修改 src/App.tsx。', {
    status: 'failed',
    trigger: 'active_write',
    blocking: true,
    summary: 'Active verification: 0/1 passed, 1 failed.',
    checks: [{
      id: 'active_verify_test',
      kind: 'test',
      title: 'Run automatic tests',
      command: 'npm test',
      required: true,
      status: 'failed',
      errorMessage: 'Expected true to be false'
    }],
    omittedChecks: [{
      id: 'active_verify_lint',
      kind: 'command',
      title: 'Run linter',
      command: 'npm run lint',
      required: true,
      reason: 'max_checks'
    }]
  }, {
    repairAttempted: true,
    rollbackAvailable: true
  });

  assert.match(reply, /自动验证未通过/);
  assert.match(reply, /Run automatic tests: failed/);
  assert.match(reply, /未执行的验证候选/);
  assert.match(reply, /Run linter: 因计划上限省略/);
  assert.match(reply, /npm run lint/);
  assert.match(reply, /checkpoint_rollback/);
});

test('non-Unity engine adapter returns structured unsupported status', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-unreal-contract-'));
  try {
    await mkdir(join(projectPath, 'project'), { recursive: true });
    const project = {
      ...buildProject(projectPath),
      engine: {
        platform: 'unreal' as const,
        setupMode: 'import' as const,
        projectPath,
        dimension: 'unknown' as const
      }
    };
    const result = await executeAgentToolAction(project, {
      type: 'open_engine_project',
      platform: 'unreal',
      projectPath
    });

    assert.equal(result.ok, false);
    assert.equal(result.isError, true);
    assert.match(result.summary, /Engine platform: unreal/);
    assert.match(result.summary, /Capability: openProject/);
    assert.match(result.summary, /Capability matrix:/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});
