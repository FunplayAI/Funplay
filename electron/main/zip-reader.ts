import yauzl from 'yauzl';

/**
 * Cross-platform zip entry reading for Office documents (docx/pptx/xlsx are zip
 * archives) and plain zips.
 *
 * Previously each caller shelled out to `spawn('unzip', ...)`, which is absent
 * on Windows by default → `spawn unzip ENOENT`, breaking docx/pptx/xlsx text
 * extraction and preview there. yauzl is a pure-JS zip reader already present
 * via electron → extract-zip, so this works on every platform with no system
 * dependency. Only the two operations the callers need are exposed: list entry
 * names (`unzip -Z1`) and read one entry as text (`unzip -p`).
 */

export const MAX_ZIP_TEXT_BYTES = 2 * 1024 * 1024;

/** List non-directory entry names. Returns [] on any error (matches old fail-soft behavior). */
export async function listZipEntries(absolutePath: string): Promise<string[]> {
  return new Promise((resolveResult) => {
    yauzl.open(absolutePath, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) {
        resolveResult([]);
        return;
      }
      const names: string[] = [];
      zipfile.on('entry', (entry) => {
        if (!entry.fileName.endsWith('/')) {
          names.push(entry.fileName);
        }
        zipfile.readEntry();
      });
      zipfile.on('end', () => resolveResult(names));
      zipfile.on('error', () => resolveResult(names));
      zipfile.readEntry();
    });
  });
}

/** Read a single entry as UTF-8 text, capped at maxBytes. Returns undefined if missing/error. */
export async function readZipEntryText(
  absolutePath: string,
  entryName: string,
  maxBytes = MAX_ZIP_TEXT_BYTES
): Promise<string | undefined> {
  return new Promise((resolveResult) => {
    yauzl.open(absolutePath, { lazyEntries: true }, (error, zipfile) => {
      if (error || !zipfile) {
        resolveResult(undefined);
        return;
      }
      let settled = false;
      const finish = (value: string | undefined): void => {
        if (!settled) {
          settled = true;
          resolveResult(value);
        }
        zipfile.close();
      };
      zipfile.on('entry', (entry) => {
        if (entry.fileName !== entryName) {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            finish(undefined);
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          stream.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > maxBytes) {
              stream.destroy();
              finish(Buffer.concat(chunks).toString('utf8'));
              return;
            }
            chunks.push(chunk);
          });
          stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
          stream.on('error', () => finish(undefined));
        });
      });
      zipfile.on('end', () => finish(undefined));
      zipfile.on('error', () => finish(undefined));
      zipfile.readEntry();
    });
  });
}
