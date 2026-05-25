import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeMacUpdateMetadataEntries,
  verifyMacUpdateMetadata
} from '../../scripts/merge-mac-update-metadata.mjs';

function file(url: string, sha512 = `sha512:${url}`) {
  return {
    url,
    sha512,
    size: 123
  };
}

test('mac update metadata merge keeps split-arch zip artifacts instead of universal artifacts', () => {
  const merged = mergeMacUpdateMetadataEntries([
    {
      version: '0.2.0',
      files: [
        file('Funplay-0.2.0-arm64-mac.zip', 'arm64-zip'),
        file('Funplay-0.2.0-arm64.dmg', 'arm64-dmg')
      ],
      path: 'Funplay-0.2.0-arm64-mac.zip',
      sha512: 'arm64-zip',
      releaseDate: '2026-05-21T12:00:00.000Z'
    },
    {
      version: '0.2.0',
      files: [
        file('Funplay-0.2.0-mac.zip', 'x64-zip'),
        file('Funplay-0.2.0.dmg', 'x64-dmg')
      ],
      path: 'Funplay-0.2.0-mac.zip',
      sha512: 'x64-zip',
      releaseDate: '2026-05-22T12:00:00.000Z'
    }
  ]);

  assert.deepEqual(
    merged.files.map((entry) => entry.url),
    [
      'Funplay-0.2.0-arm64-mac.zip',
      'Funplay-0.2.0-arm64.dmg',
      'Funplay-0.2.0-mac.zip',
      'Funplay-0.2.0.dmg'
    ]
  );
  assert.equal(merged.path, 'Funplay-0.2.0-mac.zip');
  assert.equal(merged.sha512, 'x64-zip');
  assert.equal(merged.releaseDate, '2026-05-22T12:00:00.000Z');
  assert.equal(verifyMacUpdateMetadata(merged).arm64Zip, 'Funplay-0.2.0-arm64-mac.zip');
  assert.equal(verifyMacUpdateMetadata(merged).intelZip, 'Funplay-0.2.0-mac.zip');
});

test('mac update metadata verification rejects universal artifacts', () => {
  assert.throws(
    () => verifyMacUpdateMetadata({
      version: '0.2.0',
      files: [file('Funplay-0.2.0-universal-mac.zip')],
      path: 'Funplay-0.2.0-universal-mac.zip',
      sha512: 'universal-zip',
      releaseDate: '2026-05-22T12:00:00.000Z'
    }),
    /universal mac artifact/
  );
});

test('mac update metadata verification requires both architecture zips for public feed', () => {
  assert.throws(
    () => verifyMacUpdateMetadata({
      version: '0.2.0',
      files: [file('Funplay-0.2.0-arm64-mac.zip', 'arm64-zip')],
      path: 'Funplay-0.2.0-arm64-mac.zip',
      sha512: 'arm64-zip',
      releaseDate: '2026-05-22T12:00:00.000Z'
    }),
    /Intel\/x64 zip/
  );
});

test('mac update metadata verification allows single-arch intermediate metadata', () => {
  const result = verifyMacUpdateMetadata(
    {
      version: '0.2.0',
      files: [file('Funplay-0.2.0-arm64-mac.zip', 'arm64-zip')],
      path: 'Funplay-0.2.0-arm64-mac.zip',
      sha512: 'arm64-zip',
      releaseDate: '2026-05-22T12:00:00.000Z'
    },
    { requireSplit: false }
  );

  assert.equal(result.arm64Zip, 'Funplay-0.2.0-arm64-mac.zip');
  assert.equal(result.intelZip, undefined);
});
