import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isHtmlPreviewExternalUrl,
  resolveHtmlPreviewProjectPath,
  stripHtmlPreviewUrlSuffix
} from '../../src/lib/html-preview.ts';
import {
  buildHtmlProjectPreviewUrl,
  decodeHtmlPreviewProjectHost,
  encodeHtmlPreviewProjectHost,
  HTML_PROJECT_PREVIEW_PROTOCOL
} from '../../shared/html-preview-protocol.ts';
import {
  extractLocalPreviewUrl,
  selectHtmlPreviewDevScript,
  stopProjectHtmlPreviewServer
} from '../../electron/main/project-preview-dev-server.ts';

test('html preview strips query and hash from project asset urls', () => {
  assert.equal(stripHtmlPreviewUrlSuffix('style.css?v=1#main'), 'style.css');
  assert.equal(stripHtmlPreviewUrlSuffix('sprite.png#frame'), 'sprite.png');
  assert.equal(stripHtmlPreviewUrlSuffix('main.js?cache=1'), 'main.js');
});

test('html preview resolves relative assets within the project', () => {
  assert.equal(resolveHtmlPreviewProjectPath('index.html', 'style.css'), 'style.css');
  assert.equal(resolveHtmlPreviewProjectPath('pages/index.html', '../style.css'), 'style.css');
  assert.equal(resolveHtmlPreviewProjectPath('pages/level/index.html', './main.js?v=2'), 'pages/level/main.js');
  assert.equal(resolveHtmlPreviewProjectPath('pages/index.html', '/assets/ship.png#sprite'), 'assets/ship.png');
  assert.equal(resolveHtmlPreviewProjectPath('pages/index.html', 'space%20ship.png'), 'pages/space ship.png');
});

test('html preview rejects external and escaping asset urls', () => {
  assert.equal(isHtmlPreviewExternalUrl('https://cdn.example/style.css'), true);
  assert.equal(isHtmlPreviewExternalUrl('data:text/css,body{}'), true);
  assert.equal(isHtmlPreviewExternalUrl('//cdn.example/main.js'), true);
  assert.equal(isHtmlPreviewExternalUrl('#hud'), true);
  assert.equal(resolveHtmlPreviewProjectPath('index.html', '../secret.js'), undefined);
  assert.equal(resolveHtmlPreviewProjectPath('pages/index.html', '../../secret.js'), undefined);
  assert.equal(resolveHtmlPreviewProjectPath('index.html', 'javascript:alert(1)'), undefined);
});

test('html preview protocol encodes project id in host and file path in pathname', () => {
  const host = encodeHtmlPreviewProjectHost('project_中文');
  assert.equal(decodeHtmlPreviewProjectHost(host), 'project_中文');
  assert.equal(
    buildHtmlProjectPreviewUrl('project_中文', 'pages/level one/index.html', { mode: 'fit' }),
    `${HTML_PROJECT_PREVIEW_PROTOCOL}://${host}/pages/level%20one/index.html?funplayPreviewMode=fit`
  );
});

test('html preview dev server helpers select a safe project script and local url', () => {
  assert.equal(selectHtmlPreviewDevScript({
    preview: 'vite preview',
    dev: 'vite'
  }), 'dev');
  assert.equal(selectHtmlPreviewDevScript({
    build: 'vite build'
  }), undefined);
  assert.equal(
    extractLocalPreviewUrl('  ➜  Local:   http://localhost:5173/'),
    'http://localhost:5173/'
  );
  assert.equal(
    extractLocalPreviewUrl('Network: http://0.0.0.0:4321/'),
    'http://localhost:4321/'
  );
  assert.equal(extractLocalPreviewUrl(undefined, [5173]), 'http://localhost:5173/');
  assert.equal(extractLocalPreviewUrl('https://example.com:443/'), undefined);
  assert.deepEqual(stopProjectHtmlPreviewServer('missing-project'), {
    success: true,
    stopped: false
  });
});
