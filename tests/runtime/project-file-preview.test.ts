import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectFromInput } from '../../shared/planner.ts';
import { ensureProjectSessions } from '../../shared/project-sessions.ts';
import { listProjectFilesForProject, readProjectFileForProject } from '../../electron/main/project-file-service.ts';
import { buildPptxPreviewCacheKey } from '../../electron/main/pptx-preview-renderer.ts';

function buildMinimalPdf(): string {
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n',
    '4 0 obj\n<< /Length 48 >>\nstream\nBT /F1 18 Tf 40 90 Td (Funplay PDF Preview) Tj ET\nendstream\nendobj\n',
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  ];
  let body = '%PDF-1.4\n';
  const offsets = objects.map((object) => {
    const offset = Buffer.byteLength(body, 'utf8');
    body += object;
    return offset;
  });
  const xrefOffset = Buffer.byteLength(body, 'utf8');
  const xrefLines = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(xrefOffset),
    '%%EOF'
  ];
  return `${body}${xrefLines.join('\n')}\n`;
}

test('PPTX preview cache key tracks path mtime and size', () => {
  const base = buildPptxPreviewCacheKey({
    absolutePath: '/tmp/deck.pptx',
    fileStat: { mtimeMs: 1000, size: 42 }
  });

  assert.equal(base, buildPptxPreviewCacheKey({
    absolutePath: '/tmp/deck.pptx',
    fileStat: { mtimeMs: 1000.8, size: 42 }
  }));
  assert.notEqual(base, buildPptxPreviewCacheKey({
    absolutePath: '/tmp/other-deck.pptx',
    fileStat: { mtimeMs: 1000, size: 42 }
  }));
  assert.notEqual(base, buildPptxPreviewCacheKey({
    absolutePath: '/tmp/deck.pptx',
    fileStat: { mtimeMs: 1001, size: 42 }
  }));
  assert.notEqual(base, buildPptxPreviewCacheKey({
    absolutePath: '/tmp/deck.pptx',
    fileStat: { mtimeMs: 1000, size: 43 }
  }));
});

test('project file listing includes empty directories', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-empty-directories-'));
  try {
    await mkdir(join(projectPath, 'assets', 'images'), { recursive: true });
    await mkdir(join(projectPath, 'assets', 'audio'), { recursive: true });
    await writeFile(join(projectPath, 'memory.md'), 'notes', 'utf8');

    const project = ensureProjectSessions(createProjectFromInput({
      name: 'Empty Directories',
      templateId: 'generic-workspace',
      artStyle: 'test',
      pitch: 'empty folders',
      engine: {
        platform: 'web',
        setupMode: 'import',
        projectPath,
        dimension: 'unknown'
      }
    }));

    const entries = await listProjectFilesForProject(project);
    assert.deepEqual(
      entries.map((entry) => [entry.path, entry.type]),
      [
        ['assets', 'directory'],
        ['assets/audio', 'directory'],
        ['assets/images', 'directory'],
        ['memory.md', 'file']
      ]
    );
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('project file preview extracts PPTX slide text and MIME type', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-pptx-preview-'));
  const pptxRoot = join(projectPath, 'pptx-src');
  const slidesDir = join(pptxRoot, 'ppt', 'slides');

  try {
    await mkdir(slidesDir, { recursive: true });
    await writeFile(
      join(slidesDir, 'slide1.xml'),
      '<p:sld><p:cSld><p:spTree><a:t>Bird 项目目标</a:t><a:t>做一个可交付的 8 页中文 PPT</a:t></p:spTree></p:cSld></p:sld>',
      'utf8'
    );
    await writeFile(
      join(slidesDir, 'slide2.xml'),
      '<p:sld><p:cSld><p:spTree><a:t>验收标准</a:t><a:t>可以在 FunPlay 内部预览文本</a:t></p:spTree></p:cSld></p:sld>',
      'utf8'
    );
    execFileSync('zip', ['-qr', join(projectPath, 'deck.pptx'), '.'], {
      cwd: pptxRoot
    });

    const project = ensureProjectSessions(createProjectFromInput({
      name: 'PPTX Preview',
      templateId: 'generic-workspace',
      artStyle: 'test',
      pitch: 'preview pptx',
      engine: {
        platform: 'web',
        setupMode: 'import',
        projectPath,
        dimension: 'unknown'
      }
    }));

    const file = await readProjectFileForProject(project, 'deck.pptx');

    assert.equal(file.isBinary, true);
    assert.equal(file.mimeType, 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    assert.equal(file.documentPreview?.kind, 'pptx');
    assert.equal(file.documentPreview?.pageCount, 2);
    assert.match(file.documentPreview?.pages[0]?.text ?? '', /Bird 项目目标/);
    assert.match(file.documentPreview?.pages[1]?.text ?? '', /FunPlay 内部预览/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('project file preview extracts DOCX text and MIME type', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-docx-preview-'));
  const docxRoot = join(projectPath, 'docx-src');
  const wordDir = join(docxRoot, 'word');

  try {
    await mkdir(wordDir, { recursive: true });
    await writeFile(
      join(wordDir, 'document.xml'),
      [
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>',
        '<w:p><w:r><w:t>2025 五一最热门旅游城市 TOP10</w:t></w:r></w:p>',
        '<w:p><w:r><w:t>上海、北京、成都、重庆、杭州</w:t></w:r></w:p>',
        '</w:body></w:document>'
      ].join(''),
      'utf8'
    );
    execFileSync('zip', ['-qr', join(projectPath, 'travel.docx'), '.'], {
      cwd: docxRoot
    });

    const project = ensureProjectSessions(createProjectFromInput({
      name: 'DOCX Preview',
      templateId: 'generic-workspace',
      artStyle: 'test',
      pitch: 'preview docx',
      engine: {
        platform: 'web',
        setupMode: 'import',
        projectPath,
        dimension: 'unknown'
      }
    }));

    const file = await readProjectFileForProject(project, 'travel.docx');

    assert.equal(file.isBinary, true);
    assert.equal(file.mimeType, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    assert.equal(file.documentPreview?.kind, 'docx');
    assert.equal(file.documentPreview?.extraction, 'docx-xml');
    assert.match(file.documentPreview?.pages[0]?.text ?? '', /2025 五一最热门旅游城市 TOP10/);
    assert.match(file.content, /上海、北京、成都/);
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});

test('project file preview exposes PDF data URL and MIME type', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-pdf-preview-'));

  try {
    await writeFile(join(projectPath, 'travel.pdf'), buildMinimalPdf(), 'utf8');

    const project = ensureProjectSessions(createProjectFromInput({
      name: 'PDF Preview',
      templateId: 'generic-workspace',
      artStyle: 'test',
      pitch: 'preview pdf',
      engine: {
        platform: 'web',
        setupMode: 'import',
        projectPath,
        dimension: 'unknown'
      }
    }));

    const file = await readProjectFileForProject(project, 'travel.pdf');

    assert.equal(file.isBinary, true);
    assert.equal(file.mimeType, 'application/pdf');
    assert.match(file.previewDataUrl ?? '', /^data:application\/pdf;base64,/);
    if (file.documentPreview) {
      assert.equal(file.documentPreview.kind, 'pdf');
      assert.match(file.documentPreview.pages[0]?.thumbnailDataUrl ?? '', /^data:image\/png;base64,/);
    }
  } finally {
    await rm(projectPath, { recursive: true, force: true });
  }
});
