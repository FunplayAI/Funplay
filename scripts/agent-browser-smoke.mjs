import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { createProjectFromInput } from '../shared/planner.ts';
import { ensureProjectSessions } from '../shared/project-sessions.ts';
import { createNativeWorkspaceTools } from '../electron/main/agent-platform/native/tool-adapter.ts';
import { disposeBrowserInspectionSessions } from '../electron/main/agent-platform/browser-inspection-store.ts';

function buildProject(projectPath) {
  return ensureProjectSessions(
    createProjectFromInput({
      name: 'Browser Tool Smoke',
      templateId: 'generic-workspace',
      artStyle: 'test',
      pitch: 'browser tool smoke',
      engine: {
        platform: 'web',
        setupMode: 'import',
        projectPath,
        dimension: 'unknown'
      }
    })
  );
}

async function startServer() {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (request.url === '/next') {
      response.end([
        '<!doctype html>',
        '<html>',
        '<head><title>Next Smoke Page</title></head>',
        '<body><h1>mimo-browser-next-672901</h1></body>',
        '</html>'
      ].join(''));
      return;
    }
    response.end([
      '<!doctype html>',
      '<html>',
      '<head><title>Browser Smoke Page</title></head>',
      '<body>',
      '<h1>Browser Smoke</h1>',
      '<label>Name <input id="name" /></label>',
      '<button id="go">Run Smoke</button>',
      '<output id="output"></output>',
      '<script>',
      "console.log('mimo-browser-console-load-672901');",
      "document.querySelector('#go').addEventListener('click', () => {",
      "  const value = document.querySelector('#name').value;",
      "  document.querySelector('#output').textContent = `Clicked ${value} mimo-browser-clicked-672901`;",
      "  console.log(`mimo-browser-console-clicked-672901 ${value}`);",
      '});',
      '</script>',
      '</body>',
      '</html>'
    ].join(''));
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.notEqual(address, null);
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    })
  };
}

async function runTool(tools, name, input) {
  const selected = tools[name];
  assert.equal(typeof selected?.execute, 'function', `${name} should be registered`);
  return await selected.execute(input, {});
}

function parseSessionId(summary) {
  const match = String(summary).match(/Browser session: (browser_[a-z0-9]+)/);
  assert.ok(match, `browser session id missing from: ${summary}`);
  return match[1];
}

function parseScreenshotPath(summary) {
  const match = String(summary).match(/Screenshot saved: (.+)/);
  assert.ok(match, `screenshot path missing from: ${summary}`);
  return match[1].trim();
}

async function main() {
  await app.whenReady();
  const projectPath = await mkdtemp(join(tmpdir(), 'funplay-browser-tool-smoke-'));
  const server = await startServer();
  try {
    const project = buildProject(projectPath);
    const permissionRequests = [];
    const tools = createNativeWorkspaceTools({
      project,
      includeCommandTools: true,
      permissionContext: {
        permission: {
          mode: 'read-only',
          allowWriteTools: false,
          allowSessionWriteTools: false
        },
        requestPermission: async (request) => {
          permissionRequests.push(request.toolName);
          return 'allow';
        }
      }
    });

    const opened = await runTool(tools, 'browser_open', {
      url: `${server.baseUrl}/`,
      width: 900,
      height: 700
    });
    assert.equal(opened.ok, true);
    const sessionId = parseSessionId(opened.summary);
    assert.equal(opened.browser?.sessionId, sessionId);
    assert.equal(opened.browser?.title, 'Browser Smoke Page');
    assert.deepEqual(opened.browser?.viewport, { width: 900, height: 700 });

    const firstSnapshot = await runTool(tools, 'browser_snapshot', {
      sessionId,
      maxTextChars: 4000
    });
    assert.match(String(firstSnapshot.summary), /Browser Smoke Page/);
    assert.match(String(firstSnapshot.summary), /Run Smoke/);

    const typed = await runTool(tools, 'browser_type', {
      sessionId,
      selector: '#name',
      text: 'MiMo Browser Smoke',
      clear: true
    });
    assert.equal(typed.ok, true);

    const clicked = await runTool(tools, 'browser_click', {
      sessionId,
      selector: '#go'
    });
    assert.equal(clicked.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const secondSnapshot = await runTool(tools, 'browser_snapshot', {
      sessionId,
      maxTextChars: 4000
    });
    assert.match(String(secondSnapshot.summary), /mimo-browser-clicked-672901/);
    assert.match(String(secondSnapshot.summary), /MiMo Browser Smoke/);

    const consoleOutput = await runTool(tools, 'browser_console', {
      sessionId
    });
    assert.match(String(consoleOutput.summary), /mimo-browser-console-load-672901/);
    assert.match(String(consoleOutput.summary), /mimo-browser-console-clicked-672901/);
    assert.equal(consoleOutput.browser?.sessionId, sessionId);
    assert.equal(consoleOutput.browser?.consoleMessageCount >= 2, true);

    const screenshot = await runTool(tools, 'browser_screenshot', {
      sessionId,
      fullPage: true
    });
    const screenshotPath = parseScreenshotPath(screenshot.summary);
    assert.equal(screenshot.browser?.sessionId, sessionId);
    assert.equal(screenshot.browser?.screenshotPath, screenshotPath);
    assert.equal(screenshot.artifacts?.[0]?.type, 'browser_screenshot');
    assert.equal(existsSync(screenshotPath), true);
    assert.equal((await stat(screenshotPath)).size > 500, true);
    await rm(screenshotPath, { force: true });

    const navigated = await runTool(tools, 'browser_navigate', {
      sessionId,
      url: `${server.baseUrl}/next`
    });
    assert.match(String(navigated.summary), /Next Smoke Page/);
    assert.equal(navigated.browser?.sessionId, sessionId);
    assert.equal(navigated.browser?.title, 'Next Smoke Page');

    const nextSnapshot = await runTool(tools, 'browser_snapshot', {
      sessionId,
      maxTextChars: 4000
    });
    assert.match(String(nextSnapshot.summary), /mimo-browser-next-672901/);

    const closed = await runTool(tools, 'browser_close', {
      sessionId
    });
    assert.match(String(closed.summary), new RegExp(sessionId));
    assert.equal(closed.browser?.sessionId, sessionId);

    const listed = await runTool(tools, 'browser_list', {});
    assert.match(String(listed.summary), /No browser inspection sessions/);

    assert.deepEqual(permissionRequests, [
      'browser_open',
      'browser_type',
      'browser_click',
      'browser_navigate',
      'browser_close'
    ]);
    console.log('agent-browser-smoke passed');
  } finally {
    disposeBrowserInspectionSessions();
    await server.close();
    await rm(projectPath, { recursive: true, force: true });
  }
}

main()
  .then(() => app.quit())
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
