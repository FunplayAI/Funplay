import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { logEngineDebug, logEngineWarn } from './engine-log';

// Supervises Funplay-managed `cocos start-mcp-server` processes — one per cocos4
// project. cocos-cli serves a stateless streamable-http MCP endpoint at
// http://127.0.0.1:<port>/mcp with no GUI, so Funplay can spawn it like any
// background service and point its generic MCP client at the URL.

export interface CocosCliServerHandle {
  projectPath: string;
  port: number;
  url: string;
}

interface RunningCocosCliServer extends CocosCliServerHandle {
  child: ChildProcess;
}

const servers = new Map<string, RunningCocosCliServer>();

function normalizeKey(projectPath: string): string {
  return projectPath.replace(/\/+$/g, '');
}

// Reserve a free TCP port by briefly binding to :0, so we hand cocos-cli a known
// port rather than guessing and parsing its retry behaviour out of stdout.
export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('failed to reserve a free port'))));
    });
  });
}

export type CocosCliServerSpawner = (port: number, projectPath: string) => ChildProcess;

function defaultSpawner(cliPath: string): CocosCliServerSpawner {
  return (port, projectPath) =>
    spawn('node', [cliPath, 'start-mcp-server', '--project', projectPath, '--port', String(port)], {
      stdio: ['ignore', 'ignore', 'pipe']
    });
}

// Poll the MCP endpoint with an initialize handshake until it answers or the
// deadline passes (cocos-cli boots the engine headlessly in a few seconds).
async function waitForCocosCliReady(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'funplay', version: '0' } }
        })
      });
      if (response.ok) {
        return true;
      }
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && !child.killed;
}

// Ensure a cocos-cli MCP server is running for the project, reusing a live one.
// Returns the endpoint to point an MCP connection at.
export async function ensureCocosCliServer(options: {
  projectPath: string;
  cliPath: string;
  spawner?: CocosCliServerSpawner;
  readyProbe?: (url: string) => Promise<boolean>;
  timeoutMs?: number;
}): Promise<CocosCliServerHandle> {
  const key = normalizeKey(options.projectPath);
  const existing = servers.get(key);
  if (existing && isAlive(existing.child)) {
    return { projectPath: existing.projectPath, port: existing.port, url: existing.url };
  }
  if (existing) {
    servers.delete(key);
  }

  const port = await findFreePort();
  const url = `http://127.0.0.1:${port}/mcp`;
  const spawner = options.spawner ?? defaultSpawner(options.cliPath);
  const child = spawner(port, options.projectPath);
  const entry: RunningCocosCliServer = { projectPath: options.projectPath, port, url, child };
  servers.set(key, entry);
  child.on('exit', (code) => {
    logEngineDebug('cocos-cli', `start-mcp-server exited (code ${code}) for ${options.projectPath}`);
    if (servers.get(key) === entry) {
      servers.delete(key);
    }
  });
  child.on('error', (error) => {
    logEngineWarn('cocos-cli', `start-mcp-server spawn error for ${options.projectPath}`, error);
    if (servers.get(key) === entry) {
      servers.delete(key);
    }
  });

  const ready = options.readyProbe
    ? await options.readyProbe(url)
    : await waitForCocosCliReady(url, options.timeoutMs ?? 30000);
  if (!ready) {
    await stopCocosCliServer(options.projectPath);
    throw new Error(`cocos-cli MCP server 未能在端口 ${port} 就绪。`);
  }
  return { projectPath: options.projectPath, port, url };
}

export function getCocosCliServer(projectPath: string): CocosCliServerHandle | undefined {
  const entry = servers.get(normalizeKey(projectPath));
  if (!entry || !isAlive(entry.child)) {
    return undefined;
  }
  return { projectPath: entry.projectPath, port: entry.port, url: entry.url };
}

export async function stopCocosCliServer(projectPath: string): Promise<void> {
  const key = normalizeKey(projectPath);
  const entry = servers.get(key);
  if (!entry) {
    return;
  }
  servers.delete(key);
  if (isAlive(entry.child)) {
    entry.child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      if (entry.child.exitCode === null) {
        entry.child.kill('SIGKILL');
      }
    }, 2000);
    killTimer.unref?.();
  }
}

// Stop every managed server — call on app shutdown so no headless cocos-cli
// process is orphaned.
export async function stopAllCocosCliServers(): Promise<void> {
  await Promise.all([...servers.keys()].map((projectPath) => stopCocosCliServer(projectPath)));
}

export type CocosCliCommandRunner = (command: string, args: string[]) => Promise<{ code: number; stderrTail?: string }>;

function runCocosCliCommand(command: string, args: string[]): Promise<{ code: number; stderrTail?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-2000);
    });
    child.on('error', (error) => resolve({ code: -1, stderrTail: error.message }));
    child.on('exit', (code) => resolve({ code: code ?? -1, stderrTail }));
  });
}

// Create a cocos4 project headlessly via `cocos create --project <path> --type
// 2d|3d` — no Cocos Creator GUI. Runner is injectable for tests.
export async function createCocosProjectViaCli(options: {
  cliPath: string;
  projectPath: string;
  dimension: '2d' | '3d';
  run?: CocosCliCommandRunner;
}): Promise<{ ok: boolean; message: string }> {
  const run = options.run ?? runCocosCliCommand;
  const result = await run('node', [
    options.cliPath,
    'create',
    '--project',
    options.projectPath,
    '--type',
    options.dimension
  ]);
  if (result.code !== 0) {
    return {
      ok: false,
      message: `cocos create 失败（exit ${result.code}）。${result.stderrTail ? `\n${result.stderrTail.slice(-600)}` : ''}`
    };
  }
  return {
    ok: true,
    message: `已通过 cocos-cli 创建 ${options.dimension.toUpperCase()} 项目：${options.projectPath}`
  };
}
