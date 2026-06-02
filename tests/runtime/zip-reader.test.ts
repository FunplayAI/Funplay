import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { listZipEntries, readZipEntryText } from '../../electron/main/zip-reader.ts';

// Build a minimal store-mode (uncompressed) zip in pure JS so the test needs no
// system `unzip` (the very thing we replaced) and no extra dependency.
function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildStoreZip(entries: Array<{ name: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 10); // method = store
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + data.length;
  }
  const localPart = Buffer.concat(locals);
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralDir, eocd]);
}

test('zip-reader lists entries and reads one as UTF-8 text (no system unzip)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'funplay-zip-reader-'));
  try {
    const zipPath = join(dir, 'sample.docx'); // docx is a zip
    await writeFile(
      zipPath,
      buildStoreZip([
        { name: 'word/document.xml', content: '<w:document>你好 Windows</w:document>' },
        { name: '[Content_Types].xml', content: '<Types/>' },
        { name: 'word/', content: '' } // directory entry — must be excluded
      ])
    );

    const entries = await listZipEntries(zipPath);
    assert.ok(entries.includes('word/document.xml'), 'lists nested file entry');
    assert.ok(entries.includes('[Content_Types].xml'), 'lists root file entry');
    assert.ok(!entries.includes('word/'), 'excludes directory entries');

    const xml = await readZipEntryText(zipPath, 'word/document.xml');
    assert.equal(xml, '<w:document>你好 Windows</w:document>');
    assert.equal(await readZipEntryText(zipPath, 'missing.xml'), undefined, 'missing entry → undefined');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('zip-reader fails soft on a missing archive', async () => {
  assert.deepEqual(await listZipEntries('/no/such/archive.zip'), []);
  assert.equal(await readZipEntryText('/no/such/archive.zip', 'a.txt'), undefined);
});
