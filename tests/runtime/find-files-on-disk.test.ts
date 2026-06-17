import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '../../shared/types.ts';
import { listProjectFilesForProject } from '../../electron/main/project-file-service.ts';
import { findProjectFilesFromDisk } from '../../electron/main/agent-platform/project-search-tools.ts';

function buildProject(projectPath: string): Project {
  return { id: 'find_files_test', name: 'Find Files Test', engine: { projectPath } } as unknown as Project;
}

const TARGET_PATH = 'Assets/Scripts/Managers/ResManager.cs';

test('find_files locates files past the 1200-entry listing cap', async () => {
  const root = await mkdtemp(join(tmpdir(), 'funplay-find-files-'));
  try {
    // An alphabetically-early folder stuffed with >1200 files, so the capped
    // listing is exhausted before the walk ever reaches the target folder.
    const noiseDir = join(root, 'Assets', 'AAA_Noise');
    await mkdir(noiseDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 1300 }, (_item, index) =>
        writeFile(join(noiseDir, `noise_${String(index).padStart(4, '0')}.txt`), 'x')
      )
    );
    // The target lives in an alphabetically-later folder (Scripts > AAA_Noise).
    const targetDir = join(root, 'Assets', 'Scripts', 'Managers');
    await mkdir(targetDir, { recursive: true });
    await writeFile(join(targetDir, 'ResManager.cs'), 'public class ResManager {}');

    const project = buildProject(root);

    // The old code path (capped in-memory listing) cannot reach the target.
    const listed = await listProjectFilesForProject(project);
    assert.ok(listed.length >= 1200, 'listing should hit the entry cap');
    assert.ok(!listed.some((file) => file.path === TARGET_PATH), 'capped listing must not reach the target file');

    // find_files now walks the tree on disk, so the glob finds it regardless.
    const byGlob = await findProjectFilesFromDisk(project, { pattern: '**/ResManager.cs' });
    assert.ok(byGlob.some((file) => file.path === TARGET_PATH), '**/ResManager.cs should be found on disk');

    // Filename-only and path-scoped patterns also resolve it.
    const byName = await findProjectFilesFromDisk(project, { pattern: 'ResManager.cs' });
    assert.ok(byName.some((file) => file.path === TARGET_PATH), 'bare filename pattern should match');

    const scoped = await findProjectFilesFromDisk(project, { pattern: '**/*.cs', path: 'Assets/Scripts' });
    assert.ok(scoped.some((file) => file.path === TARGET_PATH), 'path-scoped glob should match');

    // A pattern that does not exist returns nothing.
    const missing = await findProjectFilesFromDisk(project, { pattern: '**/DoesNotExist.cs' });
    assert.equal(missing.length, 0, 'non-existent pattern returns no matches');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
