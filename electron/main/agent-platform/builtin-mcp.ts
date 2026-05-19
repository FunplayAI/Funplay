import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, appendFileSync, realpathSync } from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { createSdkMcpServer, tool, type McpServerConfig as ClaudeAgentMcpServerConfig } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { cancelNotificationTask, listNotificationTasks, scheduleNotificationTask, sendAppNotification } from '../notification-service';
import type { Project } from '../../../shared/types';
import {
  extractMemoryEntryKinds,
  inferProjectMemoryEntryKind,
  normalizeProjectMemoryEntryKind,
  projectMemoryEntryKindTag
} from '../memory-service';
import { executeAgentToolAction } from './workspace-tools';
import { performWebFetchAction, performWebSearchAction, type WebSearchProvider } from './web-research-service';

const MAX_SNIPPET_CHARS = 3000;
const MAX_MEDIA_BYTES = 12 * 1024 * 1024;
const MAX_MEMORY_LINES = 200;
const MAX_MEMORY_BYTES = 25000;
const RECENT_MEMORY_DAYS = 3;
const SEARCH_SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'release', 'dist', 'build']);
const MEDIA_RESULT_MARKER = '__MEDIA_RESULT__';
const MEDIA_MIME_BY_EXTENSION = new Map<string, string>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.wav', 'audio/wav'],
  ['.mp3', 'audio/mpeg'],
  ['.ogg', 'audio/ogg'],
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.json', 'application/json'],
  ['.txt', 'text/plain']
]);
const MEDIA_EXTENSION_BY_MIME = new Map<string, string>([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
  ['image/svg+xml', '.svg'],
  ['audio/wav', '.wav'],
  ['audio/mpeg', '.mp3'],
  ['audio/ogg', '.ogg'],
  ['application/json', '.json'],
  ['text/plain', '.txt']
]);

export const BUILTIN_MEMORY_SYSTEM_PROMPT = `## Project Memory

Funplay exposes built-in memory tools:
- funplay_memory_recent: review recent daily memory and long-term memory.
- funplay_memory_search: search memory files before answering questions about past work, decisions, preferences, dates, or unresolved items. It can filter by memory_kind.
- funplay_memory_get: read a specific memory file.
- funplay_memory_remember: append stable facts or daily notes when the user asks you to remember something or when a durable project decision is made. Classify writes as user_preference, project_fact, decision, or task_state.

Project memory is persistent across sessions, but it is not raw chat history. Do not read memory automatically at the start of every new conversation. Use funplay_memory_recent or funplay_memory_search only when the user asks about remembered/past project context, asks for continuity, or the current request clearly depends on stored project decisions. When memory affects your answer, say that it came from project memory.`;

export const BUILTIN_NOTIFICATION_SYSTEM_PROMPT = `## Notifications

Funplay exposes built-in notification tools:
- funplay_notify: send an immediate in-app/system notification.
- funplay_schedule_task: schedule a reminder notification.
- funplay_list_tasks: list scheduled notification tasks.
- funplay_cancel_task: cancel a scheduled notification task.

Use these when the user asks to be notified, reminded, alerted, or wants to inspect/cancel reminders.`;

export const BUILTIN_MEDIA_SYSTEM_PROMPT = `## Media And Image Generation

Funplay exposes built-in media tools:
- funplay_media_attach_file: attach an existing workspace image, audio, or file as a rich chat media result.
- funplay_media_save_base64: save base64 media into the workspace attachments folder and attach it as a rich chat media result.
- funplay_image_generate: generate an image through the configured image API and attach the saved result. This requires FUNPLAY_IMAGE_API_KEY or OPENAI_API_KEY.

Use these when the user asks to show, attach, save, preview, or generate visual/audio assets. If image generation is not configured, say which environment variable is missing instead of pretending an image was generated.`;

export const BUILTIN_WEB_SYSTEM_PROMPT = `## Web Research

Funplay exposes built-in web research tools:
- funplay_web_search: search public web pages with domain filters, deduplication, cache, and official-source ranking.
- funplay_web_fetch: fetch a public http/https URL and extract readable page text, including document and browser-rendered fallback when available.

When the user asks for latest/current information, external docs, public web pages, or gives a URL, use these Funplay web tools. Do not rely on Claude Code built-in WebSearch/WebFetch. When web tools are used, cite the returned URLs with Markdown hyperlinks in the final answer.`;

export const CLAUDE_NATIVE_WEB_SYSTEM_PROMPT = `## Web Research

The active Claude Code runtime can use Claude Code built-in WebSearch/WebFetch. For latest/current information, external docs, public web pages, or user-provided URLs, try Claude Code built-in WebSearch/WebFetch first.

Funplay also exposes fallback web research tools in this runtime:
- funplay_web_search: search public web pages with domain filters, deduplication, cache, and official-source ranking.
- funplay_web_fetch: fetch a public http/https URL and extract readable page text, including document and browser-rendered fallback when available.

If Claude Code built-in WebSearch/WebFetch returns an API Error, bad_response_status_code, HTTP 400/403/404/429/500/503, or no usable sources, retry the same research once with funplay_web_search/funplay_web_fetch. When any web tool is used, cite the returned URLs with Markdown hyperlinks in the final answer.`;

export const BUILTIN_WORKSPACE_WRITE_SYSTEM_PROMPT = `## Host-Controlled Workspace Writes

Funplay exposes host-controlled workspace write tools:
- funplay_workspace_write_file: write a complete text file.
- funplay_workspace_edit_file: replace text in an existing text file.
- funplay_workspace_multi_edit: apply multiple text replacements to one file.
- funplay_workspace_patch_file: apply a unified patch to one text file.
- funplay_workspace_run_command: run a command in the project with host permission and timeout controls.
- funplay_workspace_checkpoint_diff: inspect checkpointed file changes.
- funplay_workspace_checkpoint_rollback: roll back checkpointed file changes.

When these tools are available, use them instead of Claude Code native Write/Edit/MultiEdit/NotebookEdit/Bash for project file changes.`;

function localDateString(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function ensureMemoryFiles(workspacePath: string): void {
  mkdirSync(join(workspacePath, 'memory', 'daily'), { recursive: true });
  const memoryPath = join(workspacePath, 'memory.md');
  if (!existsSync(memoryPath)) {
    writeFileSync(memoryPath, '# Memory\n\n', 'utf8');
  }
}

function capMemoryContent(content: string): string {
  let result = content;
  let byteTruncated = false;
  const lines = result.split('\n');
  if (lines.length > MAX_MEMORY_LINES) {
    result = `${lines.slice(0, MAX_MEMORY_LINES).join('\n')}\n\n[...truncated at 200 lines]`;
  }
  while (Buffer.byteLength(result) > MAX_MEMORY_BYTES) {
    const lastNewline = result.lastIndexOf('\n');
    if (lastNewline <= 0) {
      result = result.slice(0, Math.floor(result.length * 0.8));
      byteTruncated = true;
      break;
    }
    result = result.slice(0, lastNewline);
    byteTruncated = true;
  }
  if (byteTruncated && !result.includes('[...truncated at 25KB]')) {
    result += '\n\n[...truncated at 25KB]';
  }
  return result;
}

function isPathInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return Boolean(rel) && !rel.startsWith('..') && !/^(?:[A-Za-z]:)?[\\/]/.test(rel);
}

function safeResolve(root: string, relativePath: string): string | undefined {
  const rootPath = resolve(root);
  const target = resolve(rootPath, relativePath);
  if (!isPathInside(rootPath, target) && target !== rootPath) {
    return undefined;
  }
  if (existsSync(target)) {
    try {
      const realRoot = realpathSync(rootPath);
      const realTarget = realpathSync(target);
      if (!isPathInside(realRoot, realTarget) && realTarget !== realRoot) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
  return target;
}

function mediaMimeForPath(filePath: string): string | undefined {
  return MEDIA_MIME_BY_EXTENSION.get(extname(filePath).toLowerCase());
}

function mediaTypeForMime(mimeType: string | undefined): 'image' | 'audio' | 'file' {
  if (mimeType?.startsWith('image/')) return 'image';
  if (mimeType?.startsWith('audio/')) return 'audio';
  return 'file';
}

function sanitizeMediaFileName(value: string | undefined, fallback: string): string {
  const cleaned = (value ?? '')
    .trim()
    .replace(/[\\/]/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned || fallback;
}

function mediaResultText(text: string, media: Array<{
  type: 'image' | 'audio' | 'file';
  mimeType?: string;
  localPath: string;
  title?: string;
}>): string {
  return `${text}\n\n${MEDIA_RESULT_MARKER}\n${JSON.stringify(media)}`;
}

function ensureAttachmentDir(root: string, name: string): string {
  const dir = join(root, '.funplay-attachments', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function stripDataUrlPrefix(value: string): string {
  const marker = ';base64,';
  const index = value.indexOf(marker);
  return index >= 0 ? value.slice(index + marker.length) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function walkMarkdownFiles(root: string, dir = root, output: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SEARCH_SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(root, absolute, output);
      continue;
    }
    if (entry.isFile() && /\.md$/i.test(entry.name)) {
      const rel = relative(root, absolute).replace(/\\/g, '/');
      if (/^memory\.md$/i.test(rel) || rel.startsWith('memory/')) {
        output.push(rel);
      }
    }
  }
  return output;
}

function tokenize(value: string): string[] {
  return [...new Set(
    [
      ...value.toLowerCase().matchAll(/\b[a-z0-9_.#:/-]{2,}\b/g),
      ...value.matchAll(/[\u4e00-\u9fa5]{2,}/g)
    ].map((match) => match[0])
  )].slice(0, 20);
}

function extractTags(content: string): string[] {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  const tagLines = frontmatter?.[1]?.match(/tags:\s*\[?([^\]\n]+)\]?/i)?.[1] ?? '';
  const frontmatterTags = tagLines.split(/[, ]+/).map((tag) => tag.trim().replace(/^#/, '')).filter(Boolean);
  const inlineTags = [...content.matchAll(/(^|\s)#([\p{L}\p{N}_/-]+)/gu)].map((match) => match[2]);
  return [...new Set([...frontmatterTags, ...inlineTags].map((tag) => tag.toLowerCase()))];
}

function sanitizeMemoryTag(value: string): string {
  return value
    .trim()
    .replace(/^#/, '')
    .replace(/[^\p{L}\p{N}_/-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

function buildMemoryTagText(tags: string[] | undefined, memoryKind: ReturnType<typeof inferProjectMemoryEntryKind>): string {
  const normalizedTags = [...new Set((tags ?? []).map(sanitizeMemoryTag).filter(Boolean))];
  const kindTag = projectMemoryEntryKindTag(memoryKind);
  if (!normalizedTags.includes(kindTag)) {
    normalizedTags.push(kindTag);
  }
  return normalizedTags.length ? ` ${normalizedTags.map((tag) => `#${tag}`).join(' ')}` : '';
}

function scoreMemory(path: string, content: string, query: string, filterTags: string[]): number {
  const tokens = tokenize(query);
  if (tokens.length === 0) {
    return 0;
  }
  const lower = `${path}\n${content}`.toLowerCase();
  let score = tokens.reduce((total, token) => total + (lower.includes(token) ? 1 : 0), 0);
  if (filterTags.length > 0) {
    const tags = extractTags(content);
    if (!filterTags.some((tag) => tags.includes(tag.toLowerCase().replace(/^#/, '')))) {
      return 0;
    }
    score += 1;
  }
  const dateMatch = path.match(/(\d{4}-\d{2}-\d{2})\.md$/);
  if (dateMatch) {
    const ageDays = Math.max(0, (Date.now() - Date.parse(dateMatch[1])) / 86_400_000);
    score *= Math.exp(-(Math.log(2) / 30) * ageDays);
  }
  return score;
}

function makeSnippet(content: string, query: string): string {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  const token = tokenize(query)[0];
  if (!token) {
    return normalized.slice(0, 220);
  }
  const index = normalized.toLowerCase().indexOf(token.toLowerCase());
  if (index < 0) {
    return normalized.slice(0, 220);
  }
  const start = Math.max(0, index - 90);
  return normalized.slice(start, start + 240);
}

function createMemoryMcpServer(workspacePath: string): ClaudeAgentMcpServerConfig {
  const root = resolve(workspacePath);
  return createSdkMcpServer({
    name: 'funplay-memory',
    version: '1.0.0',
    tools: [
      tool(
        'funplay_memory_search',
        'Search project memory files with keyword matching and temporal decay. Supports tags and memory type filters.',
        {
          query: z.string().describe('Search keywords'),
          tags: z.array(z.string()).optional().describe('Optional tag filter'),
          file_type: z.enum(['all', 'daily', 'longterm']).optional().default('all'),
          memory_kind: z.enum(['all', 'user_preference', 'project_fact', 'decision', 'task_state']).optional().default('all'),
          limit: z.number().int().min(1).max(20).optional().default(5)
        },
        async ({ query, tags, file_type, memory_kind, limit }) => {
          ensureMemoryFiles(root);
          const files = walkMarkdownFiles(root);
          const filterTags = tags ?? [];
          const filterMemoryKind = normalizeProjectMemoryEntryKind(memory_kind === 'all' ? undefined : memory_kind);
          const results = files
            .filter((filePath) => {
              if (file_type === 'daily') return filePath.startsWith('memory/daily/');
              if (file_type === 'longterm') return /^memory\.md$/i.test(filePath);
              return true;
            })
            .map((filePath) => {
              const absolute = safeResolve(root, filePath);
              const content = absolute ? readFileSync(absolute, 'utf8') : '';
              if (filterMemoryKind && !extractMemoryEntryKinds(content).includes(filterMemoryKind)) {
                return {
                  path: filePath,
                  content,
                  score: 0
                };
              }
              return {
                path: filePath,
                content,
                score: scoreMemory(filePath, content, query, filterTags)
              };
            })
            .filter((result) => result.score > 0)
            .sort((left, right) => right.score - left.score)
            .slice(0, limit ?? 5);

          if (results.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No matching memories found.' }] };
          }

          return {
            content: [{
              type: 'text' as const,
              text: results.map((result, index) => {
                const tagText = extractTags(result.content).map((tag) => `#${tag}`).join(' ');
                return `${index + 1}. [${result.path}]${tagText ? ` ${tagText}` : ''} (score: ${result.score.toFixed(2)})\n${makeSnippet(result.content, query)}`;
              }).join('\n\n')
            }]
          };
        }
      ),
      tool(
        'funplay_memory_get',
        'Read a specific project memory file. Paths must be relative to the project root.',
        {
          file_path: z.string().describe('Relative path, for example memory.md or memory/daily/2026-04-24.md'),
          line_start: z.number().int().min(1).optional(),
          line_end: z.number().int().min(1).optional()
        },
        async ({ file_path, line_start, line_end }) => {
          ensureMemoryFiles(root);
          const absolute = safeResolve(root, file_path);
          if (!absolute) {
            return { content: [{ type: 'text' as const, text: 'Access denied: path is outside workspace.' }] };
          }
          if (!existsSync(absolute)) {
            return { content: [{ type: 'text' as const, text: `File not found: ${file_path}` }] };
          }
          let content = readFileSync(absolute, 'utf8');
          if (/^memory\.md$/i.test(basename(file_path))) {
            content = capMemoryContent(content);
          }
          if (line_start || line_end) {
            const lines = content.split('\n');
            const start = Math.max(0, (line_start ?? 1) - 1);
            const end = Math.min(lines.length, line_end ?? lines.length);
            content = lines.slice(start, end).join('\n');
          }
          if (content.length > MAX_SNIPPET_CHARS) {
            content = `${content.slice(0, MAX_SNIPPET_CHARS)}\n\n[...truncated...]`;
          }
          const wikilinks = [...content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)].map((match) => match[1].trim());
          const related = wikilinks.length ? `\n\n---\nLinked files: ${[...new Set(wikilinks)].map((link) => `[[${link}]]`).join(', ')}` : '';
          return { content: [{ type: 'text' as const, text: `${content || '(empty file)'}${related}` }] };
        }
      ),
      tool(
        'funplay_memory_recent',
        'Get recent daily memories and long-term memory summary when the user asks about remembered or prior project context.',
        {},
        async () => {
          ensureMemoryFiles(root);
          const parts: string[] = [];
          const memoryPath = join(root, 'memory.md');
          if (existsSync(memoryPath)) {
            const memory = capMemoryContent(readFileSync(memoryPath, 'utf8').trim());
            if (memory) {
              parts.push(`## Long-term Memory\n${memory.length > 700 ? `${memory.slice(0, 700)}...` : memory}`);
            }
          }
          const dailyDir = join(root, 'memory', 'daily');
          if (existsSync(dailyDir)) {
            const files = readdirSync(dailyDir)
              .filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file))
              .sort()
              .reverse()
              .slice(0, RECENT_MEMORY_DAYS);
            for (const file of files) {
              const content = readFileSync(join(dailyDir, file), 'utf8').trim();
              if (content) {
                parts.push(`## ${file.replace('.md', '')}\n${content.length > 900 ? `${content.slice(0, 900)}...` : content}`);
              }
            }
          }
          return { content: [{ type: 'text' as const, text: parts.join('\n\n') || 'No recent memories found.' }] };
        }
      ),
      tool(
        'funplay_memory_remember',
        'Append a durable project memory note. Use for explicit "remember this" requests or stable project decisions/preferences.',
        {
          note: z.string().describe('The fact, decision, preference, or daily note to remember'),
          memory_type: z.enum(['longterm', 'daily']).optional().default('daily'),
          memory_kind: z.enum(['user_preference', 'project_fact', 'decision', 'task_state']).optional(),
          tags: z.array(z.string()).optional()
        },
        async ({ note, memory_type, memory_kind, tags }) => {
          ensureMemoryFiles(root);
          const resolvedMemoryKind = memory_kind ?? inferProjectMemoryEntryKind({
            note,
            memoryType: memory_type,
            tags
          });
          const tagText = buildMemoryTagText(tags, resolvedMemoryKind);
          if (memory_type === 'longterm') {
            appendFileSync(join(root, 'memory.md'), `\n- ${note.trim()}${tagText}\n`, 'utf8');
            return { content: [{ type: 'text' as const, text: `Saved to memory.md. Kind: ${resolvedMemoryKind}.` }] };
          }
          const date = localDateString();
          const dailyPath = join(root, 'memory', 'daily', `${date}.md`);
          if (!existsSync(dailyPath)) {
            writeFileSync(dailyPath, `# ${date}\n\n`, 'utf8');
          }
          appendFileSync(dailyPath, `\n- ${note.trim()}${tagText}\n`, 'utf8');
          return { content: [{ type: 'text' as const, text: `Saved to memory/daily/${date}.md. Kind: ${resolvedMemoryKind}.` }] };
        }
      )
    ]
  });
}

function createNotificationMcpServer(): ClaudeAgentMcpServerConfig {
  return createSdkMcpServer({
    name: 'funplay-notify',
    version: '1.0.0',
    tools: [
      tool(
        'funplay_notify',
        'Send an immediate notification to the user. Low priority is in-app only; normal and urgent also use system notifications.',
        {
          title: z.string().describe('Notification title'),
          body: z.string().describe('Notification body text'),
          priority: z.enum(['low', 'normal', 'urgent']).optional().default('normal')
        },
        async ({ title, body, priority }) => {
          const notification = await sendAppNotification({
            title,
            body,
            priority,
            source: 'funplay-notify'
          });
          return { content: [{ type: 'text' as const, text: `Notification sent: "${notification.title}"` }] };
        }
      ),
      tool(
        'funplay_schedule_task',
        'Schedule a reminder notification. Supports once (ISO timestamp), interval (30m, 2h), or simple daily cron (0 9 * * *).',
        {
          name: z.string(),
          prompt: z.string().describe('Reminder body'),
          schedule_type: z.enum(['cron', 'interval', 'once']),
          schedule_value: z.string(),
          priority: z.enum(['low', 'normal', 'urgent']).optional().default('normal'),
          notify_on_complete: z.boolean().optional().default(true),
          durable: z.boolean().optional().default(true)
        },
        async ({ name, prompt, schedule_type, schedule_value, priority, notify_on_complete, durable }) => {
          const task = await scheduleNotificationTask({
            name,
            prompt,
            scheduleType: schedule_type,
            scheduleValue: schedule_value,
            priority,
            notifyOnComplete: notify_on_complete,
            durable
          });
          return { content: [{ type: 'text' as const, text: `Task "${task.name}" scheduled. ID: ${task.id}, next run: ${task.nextRun}` }] };
        }
      ),
      tool(
        'funplay_list_tasks',
        'List scheduled notification tasks.',
        {
          status: z.enum(['active', 'completed', 'cancelled', 'all']).optional().default('all')
        },
        async ({ status }) => {
          const tasks = listNotificationTasks().filter((task) => status === 'all' || task.status === status);
          if (tasks.length === 0) {
            return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
          }
          return {
            content: [{
              type: 'text' as const,
              text: tasks.map((task, index) =>
                `${index + 1}. [${task.id}] ${task.name}\nType: ${task.scheduleType} (${task.scheduleValue})\nStatus: ${task.status} | Next: ${task.nextRun ?? '-'} | Durable: ${task.durable ? 'yes' : 'no'}`
              ).join('\n\n')
            }]
          };
        }
      ),
      tool(
        'funplay_cancel_task',
        'Cancel a scheduled notification task by ID.',
        {
          task_id: z.string()
        },
        async ({ task_id }) => {
          await cancelNotificationTask(task_id);
          return { content: [{ type: 'text' as const, text: `Task ${task_id} cancelled.` }] };
        }
      )
    ]
  });
}

function formatToolError(toolName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${toolName} failed: ${message}`;
}

function createMediaMcpServer(workspacePath: string): ClaudeAgentMcpServerConfig {
  const root = resolve(workspacePath);
  return createSdkMcpServer({
    name: 'funplay-media',
    version: '1.0.0',
    tools: [
      tool(
        'funplay_media_attach_file',
        'Attach an existing workspace image, audio, or file to the chat as a rich media result.',
        {
          file_path: z.string().describe('Workspace-relative path to attach.'),
          title: z.string().optional().describe('Optional display title.')
        },
        async ({ file_path, title }) => {
          const absolute = safeResolve(root, file_path);
          if (!absolute) {
            return { content: [{ type: 'text' as const, text: 'Access denied: path is outside workspace.' }] };
          }
          if (!existsSync(absolute)) {
            return { content: [{ type: 'text' as const, text: `File not found: ${file_path}` }] };
          }
          const stat = statSync(absolute);
          if (!stat.isFile()) {
            return { content: [{ type: 'text' as const, text: `Not a file: ${file_path}` }] };
          }
          if (stat.size > MAX_MEDIA_BYTES) {
            return { content: [{ type: 'text' as const, text: `File is too large to attach: ${file_path}` }] };
          }
          const mimeType = mediaMimeForPath(absolute);
          return {
            content: [{
              type: 'text' as const,
              text: mediaResultText(`Attached media: ${file_path}`, [{
                type: mediaTypeForMime(mimeType),
                mimeType,
                localPath: absolute,
                title: title?.trim() || basename(file_path)
              }])
            }]
          };
        }
      ),
      tool(
        'funplay_media_save_base64',
        'Save a base64-encoded media payload into the workspace attachments folder and attach it to the chat.',
        {
          data_base64: z.string().describe('Raw base64 data, or a data URL containing base64 data.'),
          mime_type: z.string().optional().default('image/png'),
          file_name: z.string().optional(),
          title: z.string().optional()
        },
        async ({ data_base64, mime_type, file_name, title }) => {
          const base64 = stripDataUrlPrefix(data_base64).replace(/\s+/g, '');
          const bytes = Buffer.from(base64, 'base64');
          if (bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) {
            return { content: [{ type: 'text' as const, text: 'Media payload is empty or too large.' }] };
          }
          const mimeType = mime_type?.trim() || 'image/png';
          const extension = MEDIA_EXTENSION_BY_MIME.get(mimeType) ?? '.bin';
          const attachmentDir = ensureAttachmentDir(root, 'media');
          const targetName = sanitizeMediaFileName(file_name, `media-${Date.now()}${extension}`);
          const targetPath = join(attachmentDir, targetName.includes('.') ? targetName : `${targetName}${extension}`);
          writeFileSync(targetPath, bytes);
          return {
            content: [{
              type: 'text' as const,
              text: mediaResultText(`Saved media: ${targetPath}`, [{
                type: mediaTypeForMime(mimeType),
                mimeType,
                localPath: targetPath,
                title: title?.trim() || basename(targetPath)
              }])
            }]
          };
        }
      )
    ]
  });
}

function createImageGenMcpServer(workspacePath: string): ClaudeAgentMcpServerConfig {
  const root = resolve(workspacePath);
  return createSdkMcpServer({
    name: 'funplay-image-gen',
    version: '1.0.0',
    tools: [
      tool(
        'funplay_image_generate',
        'Generate an image through a configured image generation API and attach the saved result to the chat. Requires FUNPLAY_IMAGE_API_KEY or OPENAI_API_KEY.',
        {
          prompt: z.string().describe('Image generation prompt.'),
          size: z.enum(['1024x1024', '1024x1536', '1536x1024']).optional().default('1024x1024'),
          model: z.string().optional().describe('Optional image model override. Defaults to FUNPLAY_IMAGE_MODEL or gpt-image-1.'),
          file_name: z.string().optional(),
          title: z.string().optional()
        },
        async ({ prompt, size, model, file_name, title }) => {
          const apiKey = process.env.FUNPLAY_IMAGE_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim();
          if (!apiKey) {
            return {
              content: [{
                type: 'text' as const,
                text: 'Image generation is not configured. Set FUNPLAY_IMAGE_API_KEY or OPENAI_API_KEY, then retry.'
              }]
            };
          }

          const baseUrl = (process.env.FUNPLAY_IMAGE_API_BASE_URL?.trim() || 'https://api.openai.com/v1').replace(/\/+$/, '');
          const imageModel = model?.trim() || process.env.FUNPLAY_IMAGE_MODEL?.trim() || 'gpt-image-1';
          const response = await fetch(`${baseUrl}/images/generations`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: imageModel,
              prompt,
              size,
              n: 1
            })
          });
          const responseText = await response.text();
          if (!response.ok) {
            return { content: [{ type: 'text' as const, text: `Image generation failed: HTTP ${response.status} ${responseText.slice(0, 1200)}` }] };
          }

          const parsed = JSON.parse(responseText) as unknown;
          const first = isRecord(parsed) && Array.isArray(parsed.data) && isRecord(parsed.data[0]) ? parsed.data[0] : undefined;
          let bytes: Buffer | undefined;
          let mimeType = 'image/png';
          if (typeof first?.b64_json === 'string') {
            bytes = Buffer.from(first.b64_json, 'base64');
          } else if (typeof first?.url === 'string') {
            const imageResponse = await fetch(first.url);
            if (!imageResponse.ok) {
              return { content: [{ type: 'text' as const, text: `Generated image URL fetch failed: HTTP ${imageResponse.status}` }] };
            }
            const contentType = imageResponse.headers.get('content-type');
            if (contentType?.startsWith('image/')) {
              mimeType = contentType.split(';')[0];
            }
            bytes = Buffer.from(await imageResponse.arrayBuffer());
          }

          if (!bytes || bytes.length === 0 || bytes.length > MAX_MEDIA_BYTES) {
            return { content: [{ type: 'text' as const, text: 'Image generation response did not include a usable image payload.' }] };
          }

          const extension = MEDIA_EXTENSION_BY_MIME.get(mimeType) ?? '.png';
          const attachmentDir = ensureAttachmentDir(root, 'image-gen');
          const targetName = sanitizeMediaFileName(file_name, `image-${Date.now()}${extension}`);
          const targetPath = join(attachmentDir, targetName.includes('.') ? targetName : `${targetName}${extension}`);
          writeFileSync(targetPath, bytes);
          return {
            content: [{
              type: 'text' as const,
              text: mediaResultText(`Generated image: ${targetPath}`, [{
                type: 'image',
                mimeType,
                localPath: targetPath,
                title: title?.trim() || basename(targetPath)
              }])
            }]
          };
        }
      )
    ]
  });
}

function createWebMcpServer(): ClaudeAgentMcpServerConfig {
  return createSdkMcpServer({
    name: 'funplay-web',
    version: '1.0.0',
    tools: [
      tool(
        'funplay_web_search',
        'Search public web pages through Funplay web research. Use for latest/current information, public docs, external references, or user-requested web lookup. Returns citation URLs that must be cited in the final answer.',
        {
          query: z.string().describe('Search keywords or question.'),
          max_results: z.number().int().min(1).max(8).optional().default(5),
          domains: z.array(z.string()).optional().describe('Optional domain filters. Extra domains are accepted and the search service will use the first supported normalized domains.'),
          blocked_domains: z.array(z.string()).optional().describe('Optional domains to exclude from results.'),
          prefer_official: z.boolean().optional().default(false).describe('Prefer official documentation/reference sources.'),
          provider: z.enum(['auto', 'duckduckgo', 'brave', 'bing']).optional().default('auto')
        },
        async ({ query, max_results, domains, blocked_domains, prefer_official, provider }) => {
          try {
            const result = await performWebSearchAction({
              query,
              maxResults: max_results,
              domains,
              blockedDomains: blocked_domains,
              preferOfficial: prefer_official,
              provider: provider as WebSearchProvider | undefined
            });
            return { content: [{ type: 'text' as const, text: result.summary }] };
          } catch (error) {
            return { content: [{ type: 'text' as const, text: formatToolError('funplay_web_search', error) }] };
          }
        }
      ),
      tool(
        'funplay_web_fetch',
        'Fetch a public http/https URL through Funplay web research and extract readable text. Use after search results or when the user provides a URL. Returns citation URL and extracted text.',
        {
          url: z.string().url().describe('Public http/https URL to fetch.'),
          max_chars: z.number().int().min(1000).max(20000).optional().default(20000)
        },
        async ({ url, max_chars }) => {
          try {
            const result = await performWebFetchAction({
              url,
              maxChars: max_chars
            });
            return { content: [{ type: 'text' as const, text: result.summary }] };
          } catch (error) {
            return { content: [{ type: 'text' as const, text: formatToolError('funplay_web_fetch', error) }] };
          }
        }
      )
    ]
  });
}

function workspaceToolText(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] };
}

function createWorkspaceWriteMcpServer(project: Project, checkpointSnapshotId?: string): ClaudeAgentMcpServerConfig {
  const execute = async (action: Parameters<typeof executeAgentToolAction>[1]) => {
    const result = await executeAgentToolAction(project, action, { checkpointSnapshotId });
    return workspaceToolText(result.summary);
  };

  return createSdkMcpServer({
    name: 'funplay-workspace-write',
    version: '1.0.0',
    tools: [
      tool(
        'funplay_workspace_write_file',
        'Write a complete text file in the project through Funplay host-controlled checkpointing.',
        {
          path: z.string(),
          content: z.string(),
          reason: z.string().optional()
        },
        async ({ path, content, reason }) => execute({ type: 'write_file', path, content, reason })
      ),
      tool(
        'funplay_workspace_edit_file',
        'Replace text in a project file through Funplay host-controlled checkpointing.',
        {
          path: z.string(),
          old_text: z.string(),
          new_text: z.string(),
          replace_all: z.boolean().optional(),
          reason: z.string().optional()
        },
        async ({ path, old_text, new_text, replace_all, reason }) =>
          execute({ type: 'edit_file', path, oldText: old_text, newText: new_text, replaceAll: replace_all, reason })
      ),
      tool(
        'funplay_workspace_multi_edit',
        'Apply multiple text replacements to one project file through Funplay host-controlled checkpointing.',
        {
          path: z.string(),
          edits: z.array(z.object({
            old_text: z.string(),
            new_text: z.string(),
            replace_all: z.boolean().optional()
          })).min(1).max(30),
          reason: z.string().optional()
        },
        async ({ path, edits, reason }) =>
          execute({
            type: 'multi_edit',
            path,
            edits: edits.map((edit) => ({
              oldText: edit.old_text,
              newText: edit.new_text,
              replaceAll: edit.replace_all
            })),
            reason
          })
      ),
      tool(
        'funplay_workspace_patch_file',
        'Apply a unified patch to a project file through Funplay host-controlled checkpointing.',
        {
          path: z.string(),
          patch: z.string(),
          reason: z.string().optional()
        },
        async ({ path, patch, reason }) => execute({ type: 'patch_file', path, patch, reason })
      ),
      tool(
        'funplay_workspace_run_command',
        'Run a shell command in the project through Funplay host permission and timeout controls.',
        {
          command: z.string(),
          cwd: z.string().optional(),
          timeout_ms: z.number().int().min(1000).max(120000).optional(),
          reason: z.string().optional()
        },
        async ({ command, cwd, timeout_ms, reason }) => execute({ type: 'run_command', command, cwd, timeoutMs: timeout_ms, reason })
      ),
      tool(
        'funplay_workspace_checkpoint_diff',
        'Inspect checkpointed file changes for the current Funplay run.',
        {},
        async () => execute({ type: 'checkpoint_diff' })
      ),
      tool(
        'funplay_workspace_checkpoint_rollback',
        'Roll back checkpointed file changes for the current Funplay run.',
        {
          reason: z.string().optional()
        },
        async ({ reason }) => execute({ type: 'checkpoint_rollback', reason })
      )
    ]
  });
}

export function buildBuiltinAgentMcpServers(workspacePath: string, options: {
  includeWeb?: boolean;
  includeMemory?: boolean;
  includeMedia?: boolean;
  includeImageGeneration?: boolean;
  includeNotifications?: boolean;
  includeWorkspaceWrite?: boolean;
  project?: Project;
  checkpointSnapshotId?: string;
} = {}): Record<string, ClaudeAgentMcpServerConfig> {
  const includeWeb = options.includeWeb ?? true;
  const includeMemory = options.includeMemory ?? true;
  const includeMedia = options.includeMedia ?? true;
  const includeImageGeneration = options.includeImageGeneration ?? true;
  const includeNotifications = options.includeNotifications ?? true;
  const includeWorkspaceWrite = Boolean(options.includeWorkspaceWrite && options.project);
  const webServers: Record<string, ClaudeAgentMcpServerConfig> = includeWeb ? { 'funplay-web': createWebMcpServer() } : {};
  const workspaceWriteServers: Record<string, ClaudeAgentMcpServerConfig> = includeWorkspaceWrite && options.project
    ? { 'funplay-workspace-write': createWorkspaceWriteMcpServer(options.project, options.checkpointSnapshotId) }
    : {};
  const root = resolve(workspacePath);
  const optionalServers = (): Record<string, ClaudeAgentMcpServerConfig> => ({
    ...(includeImageGeneration ? { 'funplay-image-gen': createImageGenMcpServer(root) } : {}),
    ...(includeNotifications ? { 'funplay-notify': createNotificationMcpServer() } : {}),
    ...workspaceWriteServers
  });
  try {
    const stat = statSync(root);
    if (!stat.isDirectory()) {
      return {
        ...webServers,
        ...optionalServers()
      };
    }
  } catch {
    return {
      ...webServers,
      ...optionalServers()
    };
  }

  return {
    ...webServers,
    ...(includeMemory ? { 'funplay-memory': createMemoryMcpServer(root) } : {}),
    ...(includeMedia ? { 'funplay-media': createMediaMcpServer(root) } : {}),
    ...optionalServers()
  };
}
