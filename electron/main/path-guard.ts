import nodePath from 'node:path';

/** Minimal `node:path` surface we depend on — lets tests inject `path.win32`. */
type PathModule = Pick<typeof nodePath, 'relative' | 'isAbsolute'>;

/**
 * Cross-platform "is `candidate` contained within `rootPath`" check.
 *
 * The old pattern `candidate.startsWith(`${rootPath}/`)` is broken on Windows:
 * `path.resolve()` there returns backslash-separated paths (e.g.
 * `C:\Users\me\proj\index.html`), so a hardcoded forward-slash prefix
 * (`C:\Users\me\proj/`) never matches and EVERY path — even a relative
 * `index.html` resolved against the root — is rejected as "非法文件路径".
 *
 * `path.relative` normalises separators per platform: a path inside the root
 * yields a relative path that neither escapes upward (`..`) nor is absolute. On
 * Windows a different drive letter yields an absolute path, which we also reject.
 * Both `rootPath` and `candidate` must already be absolute, OS-native paths
 * (typically from `path.resolve`). `pathImpl` defaults to `node:path`; tests
 * pass `path.win32` / `path.posix` to exercise either platform's semantics.
 */
export function isPathInsideRoot(
  rootPath: string,
  candidate: string,
  pathImpl: PathModule = nodePath
): boolean {
  if (candidate === rootPath) {
    return true;
  }
  const rel = pathImpl.relative(rootPath, candidate);
  return rel.length > 0 && !rel.startsWith('..') && !pathImpl.isAbsolute(rel);
}
