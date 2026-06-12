import './test-helpers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createNativeWorkspaceTools } from '../../electron/main/agent-platform/native/tool-adapter.ts';
import { executeAgentToolAction, executeWorkspaceToolAction } from '../../electron/main/agent-platform/workspace-tools.ts';
import { disposePersistentTerminals } from '../../electron/main/agent-platform/persistent-terminal-store.ts';
import { closeBrowserPagesForProject } from '../../electron/main/agent-platform/browser-inspection-store.ts';
import { restoreFileCheckpoint } from '../../electron/main/agent-platform/file-checkpoint-store.ts';
import { getAgentToolDefinition } from '../../electron/main/agent-platform/tool-registry.ts';
import { buildProject, executeNativeWorkspaceTool } from './test-helpers.ts';

test('workspace todo tool updates plan without project path', async () => {
  const result = await executeWorkspaceToolAction(buildProject(), {
    type: 'update_todo_list',
    items: [
      {
        id: 'inspect',
        content: 'Read affected files',
        status: 'completed'
      },
      {
        id: 'build',
        content: 'Run verification',
        status: 'in_progress'
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.match(result.summary, /inspect: Read affected files/);
  assert.match(result.summary, /build: Run verification/);
});

test('workspace write tool writes inside project and blocks traversal', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-runtime-'));
  try {
    const project = buildProject(projectPath);
    const writeResult = await executeWorkspaceToolAction(project, {
      type: 'write_file',
      path: 'notes/hello.md',
      content: '# Hello',
      reason: 'test'
    });

    assert.equal(writeResult.ok, true);
    assert.match(writeResult.summary, /已写入 notes\/hello\.md/);
    assert.deepEqual(writeResult.changedFiles, [{
      path: 'notes/hello.md',
      operation: 'created',
      size: 7,
      error: undefined
    }]);
    assert.deepEqual(writeResult.edit, {
      strategy: 'write_file',
      patchFirst: false,
      preflight: 'passed',
      changedFileCount: 1
    });

    const directoryResult = await executeWorkspaceToolAction(project, {
      type: 'create_directory',
      path: 'assets/sprites',
      reason: 'test'
    });
    assert.equal(directoryResult.ok, true);
    assert.match(directoryResult.summary, /已创建目录 assets\/sprites/);
    assert.deepEqual(directoryResult.changedFiles, [{
      path: 'assets/sprites',
      operation: 'directory_created'
    }]);
    assert.equal((await stat(join(projectPath, 'assets', 'sprites'))).isDirectory(), true);

    const readResult = await executeWorkspaceToolAction(project, {
      type: 'read_file',
      path: 'notes/hello.md'
    });
    assert.equal(readResult.ok, true);
    assert.match(readResult.summary, /# Hello/);

    const traversalResult = await executeWorkspaceToolAction(project, {
      type: 'write_file',
      path: '../escape.txt',
      content: 'bad'
    });
    assert.equal(traversalResult.ok, false);
    assert.equal(traversalResult.isError, true);
    assert.equal(traversalResult.edit?.failureKind, 'path_error');
    assert.match(traversalResult.edit?.recoveryHint ?? '', /项目目录内/);

    const traversalDirectoryResult = await executeWorkspaceToolAction(project, {
      type: 'create_directory',
      path: '../escape-dir'
    });
    assert.equal(traversalDirectoryResult.ok, false);
    assert.equal(traversalDirectoryResult.isError, true);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('workspace find, read range, and edit tools support code-style workflows', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-tools-'));
  try {
    const project = buildProject(projectPath);
    await writeFile(join(projectPath, 'alpha.ts'), ['one', 'two', 'three'].join('\n'), 'utf8');
    await writeFile(join(projectPath, 'beta.md'), 'notes', 'utf8');

    const findResult = await executeWorkspaceToolAction(project, {
      type: 'find_files',
      pattern: '*.ts'
    });
    assert.equal(findResult.ok, true);
    assert.match(findResult.summary, /alpha\.ts/);
    assert.doesNotMatch(findResult.summary, /beta\.md/);

    const rangeResult = await executeWorkspaceToolAction(project, {
      type: 'read_file',
      path: 'alpha.ts',
      offset: 1,
      limit: 1
    });
    assert.equal(rangeResult.ok, true);
    assert.match(rangeResult.summary, /2\ttwo/);
    assert.doesNotMatch(rangeResult.summary, /1\tone/);

    await mkdir(join(projectPath, 'src'), { recursive: true });
    await writeFile(join(projectPath, 'src', 'component.tsx'), [
      'export function AlphaWidget() {',
      '  return <div>NeedleOne</div>;',
      '}'
    ].join('\n'), 'utf8');
    await writeFile(join(projectPath, 'src', 'component.test.tsx'), 'expect("NeedleOne").toBeTruthy();', 'utf8');
    await writeFile(join(projectPath, 'src', 'notes.md'), 'NeedleOne in docs', 'utf8');

    const regexSearch = await executeWorkspaceToolAction(project, {
      type: 'search_project_content',
      query: 'Needle[A-Z][a-z]+',
      regex: true,
      glob: 'src/**/*.tsx',
      outputMode: 'content',
      contextBefore: 1,
      contextAfter: 1,
      caseInsensitive: false,
      limit: 2
    });
    assert.equal(regexSearch.ok, true);
    assert.match(regexSearch.summary, /Mode: regex \| Case: sensitive/);
    assert.match(regexSearch.summary, /\[src\/component\.tsx:2\]/);
    assert.match(regexSearch.summary, /1\texport function AlphaWidget/);
    assert.match(regexSearch.summary, /3\t}/);
    assert.doesNotMatch(regexSearch.summary, /notes\.md/);

    const fileSearch = await executeWorkspaceToolAction(project, {
      type: 'search_project_content',
      query: 'NeedleOne',
      outputMode: 'files_with_matches',
      fileType: 'tsx',
      limit: 5
    });
    assert.equal(fileSearch.ok, true);
    assert.match(fileSearch.summary, /src\/component\.tsx \(1 matches\)/);
    assert.match(fileSearch.summary, /src\/component\.test\.tsx \(1 matches\)/);
    assert.doesNotMatch(fileSearch.summary, /notes\.md/);

    const editResult = await executeAgentToolAction(
      project,
      {
        type: 'edit_file',
        path: 'alpha.ts',
        oldText: 'two',
        newText: 'TWO',
        reason: 'test'
      },
      {
        checkpointSnapshotId: 'snapshot_edit_test'
      }
    );
    assert.equal(editResult.ok, true);
    assert.deepEqual(editResult.changedFiles, [{
      path: 'alpha.ts',
      operation: 'modified',
      size: 13,
      replacementCount: 1
    }]);
    assert.deepEqual(editResult.edit, {
      strategy: 'search_replace',
      patchFirst: false,
      preflight: 'passed',
      changedFileCount: 1,
      replacementCount: 1
    });
    assert.equal(await readFile(join(projectPath, 'alpha.ts'), 'utf8'), 'one\nTWO\nthree');

    const restored = await restoreFileCheckpoint(project, 'snapshot_edit_test');
    assert.deepEqual(restored.restoredFiles, ['alpha.ts']);
    assert.equal(await readFile(join(projectPath, 'alpha.ts'), 'utf8'), 'one\ntwo\nthree');

    const ambiguousResult = await executeWorkspaceToolAction(project, {
      type: 'edit_file',
      path: 'alpha.ts',
      oldText: 'e',
      newText: 'E'
    });
    assert.equal(ambiguousResult.ok, false);
    assert.equal(ambiguousResult.isError, true);
    assert.match(ambiguousResult.summary, /匹配了/);
    assert.equal(ambiguousResult.edit?.failureKind, 'ambiguous_match');
    assert.match(ambiguousResult.edit?.recoveryHint ?? '', /preview_patch/);

    const missingResult = await executeWorkspaceToolAction(project, {
      type: 'edit_file',
      path: 'alpha.ts',
      oldText: 'missing old text',
      newText: 'replacement'
    });
    assert.equal(missingResult.ok, false);
    assert.equal(missingResult.isError, true);
    assert.match(missingResult.summary, /没有在 alpha\.ts 中找到 oldText/);
    assert.equal(missingResult.edit?.failureKind, 'missing_match');
    assert.match(missingResult.edit?.recoveryHint ?? '', /更精确 oldText/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('workspace game project inspector recognizes web game workflows and assets', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-game-inspect-'));
  try {
    const project = buildProject(projectPath);
    await mkdir(join(projectPath, 'src'), { recursive: true });
    await mkdir(join(projectPath, 'assets', 'images'), { recursive: true });
    await mkdir(join(projectPath, 'assets', 'audio'), { recursive: true });
    await writeFile(join(projectPath, 'index.html'), '<canvas id="game"></canvas>', 'utf8');
    await writeFile(join(projectPath, 'src', 'main.ts'), 'console.log("play");', 'utf8');
    await writeFile(join(projectPath, 'assets', 'images', 'hero.png'), 'png', 'utf8');
    await writeFile(join(projectPath, 'assets', 'audio', 'theme.ogg'), 'ogg', 'utf8');
    await writeFile(join(projectPath, 'package.json'), JSON.stringify({
      scripts: {
        dev: 'vite --host 127.0.0.1',
        build: 'vite build'
      }
    }), 'utf8');

    const result = await executeWorkspaceToolAction(project, {
      type: 'inspect_game_project'
    });

    assert.equal(result.ok, true);
    assert.match(result.summary, /Detected kind: web-game/);
    assert.match(result.summary, /index\.html/);
    assert.match(result.summary, /dev: vite/);
    assert.match(result.summary, /assets\/images/);
    assert.match(result.summary, /images=1, audio=1/);
    assert.match(result.summary, /browser_console/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native media tools attach and save rich media blocks', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-media-'));
  try {
    const project = buildProject(projectPath);
    await mkdir(join(projectPath, 'media'), { recursive: true });
    await writeFile(join(projectPath, 'media', 'note.txt'), 'hello media', 'utf8');

    const attachResult = await executeWorkspaceToolAction(project, {
      type: 'media_attach_file',
      filePath: 'media/note.txt',
      title: 'Note'
    });
    assert.equal(attachResult.ok, true);
    assert.equal(attachResult.media?.[0]?.type, 'file');
    assert.equal(attachResult.media?.[0]?.title, 'Note');
    assert.match(attachResult.media?.[0]?.localPath ?? '', /media\/note\.txt$/);

    const absoluteAttachResult = await executeWorkspaceToolAction(project, {
      type: 'media_attach_file',
      filePath: join(projectPath, 'media', 'note.txt'),
      title: 'Absolute note'
    });
    assert.equal(absoluteAttachResult.ok, true);
    assert.match(absoluteAttachResult.summary, /Attached media: media\/note\.txt/);
    assert.equal(absoluteAttachResult.media?.[0]?.title, 'Absolute note');

    const externalDir = await mkdtemp(join(tmpdir(), 'funplay-external-media-'));
    const externalPath = join(externalDir, 'AppIcon.png');
    await writeFile(externalPath, Buffer.from('external media'));
    const externalAttachResult = await executeWorkspaceToolAction(project, {
      type: 'media_attach_file',
      filePath: externalPath,
      title: 'External App Icon'
    });
    assert.equal(externalAttachResult.ok, true);
    assert.match(externalAttachResult.summary, /Attached media: .*AppIcon\.png/);
    assert.equal(externalAttachResult.media?.[0]?.localPath, externalPath);
    assert.equal(externalAttachResult.media?.[0]?.title, 'External App Icon');
    await rm(externalDir, { recursive: true, force: true });

    const saveResult = await executeWorkspaceToolAction(project, {
      type: 'media_save_base64',
      dataBase64: Buffer.from('saved media').toString('base64'),
      mimeType: 'text/plain',
      fileName: 'saved.txt',
      title: 'Saved'
    });
    assert.equal(saveResult.ok, true);
    assert.equal(saveResult.media?.[0]?.type, 'file');
    assert.match(saveResult.media?.[0]?.localPath ?? '', /\.funplay-attachments\/media\/saved\.txt$/);
    assert.equal(await readFile(saveResult.media?.[0]?.localPath ?? '', 'utf8'), 'saved media');

    const tools = createNativeWorkspaceTools({
      project,
      includeWriteTools: false
    });
    const mediaTool = tools.media_attach_file as unknown as {
      execute: (input: Record<string, unknown>, options: Record<string, unknown>) => Promise<{
        summary: string;
        media?: Array<{ title?: string }>;
      }>;
    };
    const adapterResult = await mediaTool.execute({
      filePath: 'media/note.txt',
      title: 'Adapter note'
    }, {});
    assert.match(adapterResult.summary, /Attached media/);
    assert.equal(adapterResult.media?.[0]?.title, 'Adapter note');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native document read supports page ranges and ignores empty read_file pages', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-docs-'));
  try {
    const project = buildProject(projectPath);
    await mkdir(join(projectPath, 'docs'), { recursive: true });
    await writeFile(join(projectPath, 'docs', 'paged.txt'), ['Page one', 'Page two', 'Page three'].join('\f'), 'utf8');

    const documentResult = await executeWorkspaceToolAction(project, {
      type: 'read_document',
      path: 'docs/paged.txt',
      pages: '2-3',
      maxChars: 4000
    });
    assert.equal(documentResult.ok, true);
    assert.match(documentResult.summary, /Pages: 2-3/);
    assert.match(documentResult.summary, /Page two/);
    assert.match(documentResult.summary, /Page three/);
    assert.doesNotMatch(documentResult.summary, /Page one/);

    const readFileDefinition = getAgentToolDefinition('read_file');
    const readFileAction = readFileDefinition?.toAction({
      path: 'docs/paged.txt',
      pages: ''
    });
    assert.deepEqual(readFileAction, {
      type: 'read_file',
      path: 'docs/paged.txt',
      offset: undefined,
      limit: undefined,
      pages: undefined
    });
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('workspace multi_edit prevalidates all edits before writing', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-multi-edit-'));
  try {
    const project = buildProject(projectPath);
    await writeFile(join(projectPath, 'alpha.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf8');

    const multiEditResult = await executeAgentToolAction(
      project,
      {
        type: 'multi_edit',
        path: 'alpha.ts',
        edits: [
          {
            oldText: 'const a = 1;',
            newText: 'const a = 10;'
          },
          {
            oldText: 'const b = 2;',
            newText: 'const b = 20;'
          }
        ],
        reason: 'test multi edit'
      },
      {
        checkpointSnapshotId: 'snapshot_multi_edit_test'
      }
    );

    assert.equal(multiEditResult.ok, true);
    assert.match(multiEditResult.summary, /全部预检通过/);
    assert.match(multiEditResult.summary, /总替换 2 处/);
    assert.deepEqual(multiEditResult.edit, {
      strategy: 'multi_edit',
      patchFirst: false,
      preflight: 'passed',
      changedFileCount: 1,
      replacementCount: 2,
      editCount: 2
    });
    assert.equal(await readFile(join(projectPath, 'alpha.ts'), 'utf8'), 'const a = 10;\nconst b = 20;\nconst c = 3;\n');

    const restored = await restoreFileCheckpoint(project, 'snapshot_multi_edit_test');
    assert.deepEqual(restored.restoredFiles, ['alpha.ts']);
    assert.equal(await readFile(join(projectPath, 'alpha.ts'), 'utf8'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');

    const failed = await executeWorkspaceToolAction(project, {
      type: 'multi_edit',
      path: 'alpha.ts',
      edits: [
        {
          oldText: 'const a = 1;',
          newText: 'const a = 100;'
        },
        {
          oldText: 'missing symbol',
          newText: 'replacement'
        }
      ]
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.isError, true);
    assert.match(failed.summary, /第 2 个编辑/);
    assert.equal(failed.edit?.strategy, 'multi_edit');
    assert.equal(failed.edit?.preflight, 'failed');
    assert.equal(failed.edit?.editCount, 2);
    assert.equal(await readFile(join(projectPath, 'alpha.ts'), 'utf8'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('workspace patch tools preview and apply unified diffs with checkpoint', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-patch-edit-'));
  try {
    const project = buildProject(projectPath);
    await writeFile(join(projectPath, 'alpha.ts'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf8');

    const patch = [
      '--- a/alpha.ts',
      '+++ b/alpha.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 20;',
      '+const added = true;',
      ' const c = 3;'
    ].join('\n');

    const preview = await executeWorkspaceToolAction(project, {
      type: 'preview_patch',
      path: 'alpha.ts',
      patch
    });
    assert.equal(preview.ok, true);
    assert.match(preview.summary, /Patch preflight OK/);
    assert.match(preview.summary, /\+const added = true;/);
    assert.deepEqual(preview.edit, {
      strategy: 'unified_patch',
      patchFirst: true,
      preflight: 'passed',
      hunkCount: 1,
      addedLines: 2,
      removedLines: 1
    });
    assert.equal(await readFile(join(projectPath, 'alpha.ts'), 'utf8'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');

    const applied = await executeAgentToolAction(
      project,
      {
        type: 'patch_file',
        path: 'alpha.ts',
        patch,
        reason: 'test patch edit'
      },
      {
        checkpointSnapshotId: 'snapshot_patch_edit_test'
      }
    );
    assert.equal(applied.ok, true);
    assert.match(applied.summary, /已应用 patch/);
    assert.deepEqual(applied.edit, {
      strategy: 'unified_patch',
      patchFirst: true,
      preflight: 'passed',
      changedFileCount: 1,
      hunkCount: 1,
      addedLines: 2,
      removedLines: 1
    });
    assert.equal(await readFile(join(projectPath, 'alpha.ts'), 'utf8'), 'const a = 1;\nconst b = 20;\nconst added = true;\nconst c = 3;\n');

    const checkpointDiff = await executeAgentToolAction(
      project,
      {
        type: 'checkpoint_diff'
      },
      {
        checkpointSnapshotId: 'snapshot_patch_edit_test'
      }
    );
    assert.equal(checkpointDiff.ok, true);
    assert.match(checkpointDiff.summary, /Changed files: 1/);
    assert.match(checkpointDiff.summary, /\+const added = true;/);

    const rollback = await executeAgentToolAction(
      project,
      {
        type: 'checkpoint_rollback',
        reason: 'test rollback'
      },
      {
        checkpointSnapshotId: 'snapshot_patch_edit_test'
      }
    );
    assert.equal(rollback.ok, true);
    assert.match(rollback.summary, /Restored files: alpha\.ts/);
    assert.deepEqual(rollback.edit, {
      strategy: 'checkpoint_rollback',
      patchFirst: false,
      preflight: 'not_applicable',
      changedFileCount: 1
    });
    assert.equal(await readFile(join(projectPath, 'alpha.ts'), 'utf8'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');

    const diffPreview = await executeWorkspaceToolAction(project, {
      type: 'preview_file_diff',
      path: 'alpha.ts',
      content: 'const a = 10;\nconst b = 2;\nconst c = 3;\n'
    });
    assert.equal(diffPreview.ok, true);
    assert.match(diffPreview.summary, /Diff preview/);
    assert.match(diffPreview.summary, /-const a = 1;/);
    assert.match(diffPreview.summary, /\+const a = 10;/);

    const failed = await executeWorkspaceToolAction(project, {
      type: 'preview_patch',
      path: 'alpha.ts',
      patch: [
        '@@ -1,1 +1,1 @@',
        '-missing context',
        '+replacement'
      ].join('\n')
    });
    assert.equal(failed.ok, false);
    assert.equal(failed.isError, true);
    assert.match(failed.summary, /校验失败/);
    assert.equal(failed.edit?.strategy, 'unified_patch');
    assert.equal(failed.edit?.patchFirst, true);
    assert.equal(failed.edit?.preflight, 'failed');
    assert.equal(failed.edit?.failureKind, 'invalid_patch');
    assert.equal(await readFile(join(projectPath, 'alpha.ts'), 'utf8'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('workspace run_command executes in project with timeout and cwd guards', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-command-'));
  try {
    const project = buildProject(projectPath);
    const commandResult = await executeWorkspaceToolAction(project, {
      type: 'run_command',
      command: 'printf command-ok',
      timeoutMs: 5_000
    });
    assert.equal(commandResult.ok, true);
    assert.match(commandResult.summary, /command-ok/);
    assert.match(commandResult.summary, /退出码：0/);
    assert.equal(commandResult.command?.exitCode, 0);
    assert.equal(commandResult.command?.stdout, 'command-ok');
    assert.equal(commandResult.command?.stderr, '');
    assert.equal(commandResult.command?.cwd, '.');
    assert.equal(commandResult.artifacts?.[0]?.type, 'command_output');

    const longOutputResult = await executeWorkspaceToolAction(project, {
      type: 'run_command',
      command: "node -e \"process.stdout.write('x'.repeat(70000))\"",
      timeoutMs: 5_000
    });
    assert.equal(longOutputResult.ok, true);
    assert.equal(longOutputResult.command?.outputTruncated, true);
    assert.equal(longOutputResult.artifacts?.[0]?.type, 'command_output');
    assert.ok(longOutputResult.artifacts?.[0]?.path);
    assert.equal((await stat(longOutputResult.artifacts?.[0]?.path ?? '')).isFile(), true);
    assert.match(await readFile(longOutputResult.artifacts?.[0]?.path ?? '', 'utf8'), /Command: node -e/);

    const quotedAmpersandResult = await executeWorkspaceToolAction(project, {
      type: 'run_command',
      command: "printf 'a & b'",
      timeoutMs: 5_000
    });
    assert.equal(quotedAmpersandResult.ok, true);
    assert.equal(quotedAmpersandResult.command?.stdout, 'a & b');

    const backgroundResult = await executeWorkspaceToolAction(project, {
      type: 'run_command',
      command: 'node -e "setInterval(() => {}, 1000)" &',
      timeoutMs: 5_000
    });
    assert.equal(backgroundResult.ok, false);
    assert.equal(backgroundResult.isError, true);
    assert.match(backgroundResult.summary, /已拒绝执行后台命令/);
    assert.match(backgroundResult.summary, /background:true/);
    assert.match(backgroundResult.summary, /terminal_start/);

    const timeoutResult = await executeWorkspaceToolAction(project, {
      type: 'run_command',
      command: 'node -e "setTimeout(() => {}, 2000)"',
      timeoutMs: 1_000
    });
    assert.equal(timeoutResult.ok, false);
    assert.equal(timeoutResult.isError, true);
    assert.match(timeoutResult.summary, /timeout/);
    assert.equal(timeoutResult.command?.timedOut, true);

    const traversalResult = await executeWorkspaceToolAction(project, {
      type: 'run_command',
      command: 'pwd',
      cwd: '../'
    });
    assert.equal(traversalResult.ok, false);
    assert.equal(traversalResult.isError, true);
    assert.match(traversalResult.summary, /非法目录路径/);
  } finally {
    disposePersistentTerminals();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('browser inspection sessions can be cleaned up by project without Electron windows', () => {
  assert.equal(closeBrowserPagesForProject('project_none'), 'Closed 0 browser inspection session(s).');
});

test('workspace persistent terminal reuses shell state and can be stopped', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-terminal-'));
  try {
    await mkdir(join(projectPath, 'subdir'), { recursive: true });
    const project = buildProject(projectPath);
    const started = await executeAgentToolAction(project, {
      type: 'terminal_start',
      name: 'runtime terminal test',
      cwd: '.',
      reason: 'test'
    });
    assert.equal(started.ok, true);
    assert.equal(started.terminal?.status, 'running');
    assert.equal(started.terminal?.cwd, '.');
    assert.equal(started.terminal?.serviceKind, 'test-runner');
    const sessionId = started.summary.match(/ID: (term_[a-z0-9]+)/)?.[1];
    assert.ok(sessionId);
    assert.equal(started.terminal?.sessionId, sessionId);

    const written = await executeAgentToolAction(project, {
      type: 'terminal_write',
      sessionId,
      input: "printf 'Local: http://localhost:5173\\n' && cd subdir && pwd",
      reason: 'test shell state'
    });
    assert.equal(written.ok, true);
    assert.equal(written.terminal?.sessionId, sessionId);
    assert.equal(written.terminal?.status, 'running');

    let readSummary = '';
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const read = await executeAgentToolAction(project, {
        type: 'terminal_read',
        sessionId,
        maxChars: 12000
      });
      readSummary = read.summary;
      if (readSummary.includes('/subdir')) {
        break;
      }
    }
    assert.match(readSummary, /subdir/);
    assert.match(readSummary, /nextSeq=/);
    const finalRead = await executeAgentToolAction(project, {
      type: 'terminal_read',
      sessionId,
      maxChars: 12000
    });
    assert.equal(finalRead.terminal?.sessionId, sessionId);
    assert.equal(finalRead.terminal?.status, 'running');
    assert.equal(typeof finalRead.terminal?.nextSeq, 'number');
    assert.equal(finalRead.terminal?.detectedPorts?.includes(5173), true);
    assert.match(finalRead.terminal?.logTail ?? '', /localhost:5173/);
    assert.equal((finalRead.terminal?.outputChunkCount ?? 0) > 0, true);
    assert.equal((finalRead.terminal?.totalOutputChars ?? 0) > 0, true);

    const listed = await executeAgentToolAction(project, {
      type: 'terminal_list'
    });
    assert.equal(listed.ok, true);
    assert.match(listed.summary, new RegExp(sessionId));

    const stopped = await executeAgentToolAction(project, {
      type: 'terminal_stop',
      sessionId,
      signal: 'SIGTERM',
      reason: 'test cleanup'
    });
    assert.equal(stopped.ok, true);
    assert.match(stopped.summary, new RegExp(sessionId));
    assert.equal(stopped.terminal?.sessionId, sessionId);
    assert.equal(stopped.terminal?.status, 'stopped');
    assert.equal(stopped.terminal?.detectedPorts?.includes(5173), true);
  } finally {
    disposePersistentTerminals();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('workspace terminal_read writes command_output artifact for truncated terminal logs', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-terminal-artifact-'));
  try {
    const project = buildProject(projectPath);
    const started = await executeAgentToolAction(project, {
      type: 'terminal_start',
      name: 'terminal artifact test',
      cwd: '.',
      reason: 'test terminal artifact'
    });
    const sessionId = started.summary.match(/ID: (term_[a-z0-9]+)/)?.[1];
    assert.ok(sessionId);

    const written = await executeAgentToolAction(project, {
      type: 'terminal_write',
      sessionId,
      input: "node -e \"for (let i = 0; i < 180; i += 1) console.log('artifact-line-' + i)\"",
      reason: 'produce long terminal output'
    });
    assert.equal(written.ok, true);

    let read = await executeAgentToolAction(project, {
      type: 'terminal_read',
      sessionId,
      maxChars: 1000
    });
    for (let attempt = 0; attempt < 10 && !read.summary.includes('artifact-line-179'); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      read = await executeAgentToolAction(project, {
        type: 'terminal_read',
        sessionId,
        maxChars: 1000
      });
    }

    assert.match(read.summary, /output=tail\(1000 chars\)/);
    assert.equal(read.artifacts?.[0]?.type, 'command_output');
    assert.ok(read.artifacts?.[0]?.path);
    assert.equal((await stat(read.artifacts[0].path)).isFile(), true);
    const artifactContent = await readFile(read.artifacts[0].path, 'utf8');
    assert.match(artifactContent, new RegExp(`Terminal: ${sessionId}`));
    assert.match(artifactContent, /artifact-line-0/);
    assert.match(artifactContent, /artifact-line-179/);

    await executeAgentToolAction(project, {
      type: 'terminal_stop',
      sessionId,
      signal: 'SIGTERM',
      reason: 'test cleanup'
    });
  } finally {
    disposePersistentTerminals();
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native command tool is high-risk and permission-gated in plan mode', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-native-command-'));
  try {
    const project = buildProject(projectPath);
    const deniedTools = createNativeWorkspaceTools({
      project,
      includeCommandTools: true,
      permissionContext: {
        permission: {
          mode: 'read-only',
          allowWriteTools: false,
          allowSessionWriteTools: false
        }
      }
    });
    const denied = await executeNativeWorkspaceTool(deniedTools, 'run_command', {
      command: 'printf denied'
    });
    assert.equal(denied.ok, false);
    assert.equal(denied.isError, true);

    const requests: Array<{
      risk: 'low' | 'medium' | 'high';
      toolName?: string;
    }> = [];
    const allowedTools = createNativeWorkspaceTools({
      project,
      includeCommandTools: true,
      permissionContext: {
        permission: {
          mode: 'read-only',
          allowWriteTools: false,
          allowSessionWriteTools: false
        },
        requestPermission: async (request) => {
          requests.push({
            risk: request.risk,
            toolName: request.toolName
          });
          return 'allow';
        }
      }
    });
    const allowed = await executeNativeWorkspaceTool(allowedTools, 'run_command', {
      command: 'printf allowed',
      timeoutMs: 5_000
    });
    assert.equal(allowed.ok, true);
    assert.match(allowed.summary, /allowed/);
    assert.equal(requests[0]?.risk, 'high');
    assert.equal(requests[0]?.toolName, 'run_command');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('native create directory tool is permission-gated in ask mode', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-native-create-dir-'));
  try {
    const project = buildProject(projectPath);
    const requests: Array<{
      risk: 'low' | 'medium' | 'high';
      toolName?: string;
    }> = [];
    const tools = createNativeWorkspaceTools({
      project,
      includeWriteTools: true,
      permissionContext: {
        permission: {
          mode: 'ask',
          allowWriteTools: false,
          allowSessionWriteTools: false
        },
        requestPermission: async (request) => {
          requests.push({
            risk: request.risk,
            toolName: request.toolName
          });
          return 'allow';
        }
      }
    });

    const result = await executeNativeWorkspaceTool(tools, 'create_directory', {
      path: 'assets/audio',
      reason: 'test create dir'
    });

    assert.equal(result.ok, true);
    assert.equal(requests[0]?.toolName, 'create_directory');
    assert.equal(requests[0]?.risk, 'medium');
    assert.equal((await stat(join(projectPath, 'assets', 'audio'))).isDirectory(), true);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('workspace write tool records file checkpoint for rewind', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-checkpoint-'));
  try {
    const project = buildProject(projectPath);
    await writeFile(join(projectPath, 'notes.md'), 'before', 'utf8');

    const writeResult = await executeAgentToolAction(
      project,
      {
        type: 'write_file',
        path: 'notes.md',
        content: 'after'
      },
      {
        checkpointSnapshotId: 'snapshot_runtime_test'
      }
    );
    assert.equal(writeResult.ok, true);
    assert.equal(await readFile(join(projectPath, 'notes.md'), 'utf8'), 'after');

    const restored = await restoreFileCheckpoint(project, 'snapshot_runtime_test');
    assert.deepEqual(restored.restoredFiles, ['notes.md']);
    assert.equal(await readFile(join(projectPath, 'notes.md'), 'utf8'), 'before');
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});
