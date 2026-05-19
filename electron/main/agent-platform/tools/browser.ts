import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

registerAgentTool({
  name: 'browser_open',
  title: 'Open Browser Page',
  description: '用隐藏 Electron 窗口打开网页。允许公网 http/https、本机 localhost 或项目目录内 file URL；会拦截内网、链路本地和 .local 地址；高风险，host 会在执行点做权限判断。',
  inputSchema: z.object({
    url: z.string().url().describe('要打开的 URL，例如 https://example.com 或 http://localhost:5173。'),
    width: z.number().int().min(320).max(2400).optional().describe('视口宽度，默认 1440。'),
    height: z.number().int().min(320).max(1800).optional().describe('视口高度，默认 900。'),
    reason: z.string().optional().describe('为什么需要打开浏览器页面。')
  }),
  risk: 'high',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'browser_open',
    url: String(input.url),
    width: typeof input.width === 'number' ? input.width : undefined,
    height: typeof input.height === 'number' ? input.height : undefined,
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});

registerAgentTool({
  name: 'browser_navigate',
  title: 'Navigate Browser Page',
  description: '让已打开的浏览器会话跳转到另一个网页。允许公网 http/https、本机 localhost 或项目目录内 file URL；会拦截内网、链路本地和 .local 地址；高风险，host 会在执行点做权限判断。',
  inputSchema: z.object({
    sessionId: z.string().min(1).describe('browser_open 返回的浏览器会话 ID。'),
    url: z.string().url().describe('要跳转的 URL。'),
    reason: z.string().optional().describe('为什么需要跳转网页。')
  }),
  risk: 'high',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'browser_navigate',
    sessionId: String(input.sessionId),
    url: String(input.url),
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});

registerAgentTool({
  name: 'browser_snapshot',
  title: 'Read Browser Snapshot',
  description: '读取已打开页面的 DOM 文本、标题、视口、标题元素和可交互控件摘要。适合检查页面结构、文案和基础可访问性。',
  inputSchema: z.object({
    sessionId: z.string().min(1).describe('browser_open 返回的浏览器会话 ID。'),
    maxTextChars: z.number().int().min(1000).max(20000).optional().describe('最多返回 body text 字符数，默认 6000。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'browser_snapshot',
    sessionId: String(input.sessionId),
    maxTextChars: typeof input.maxTextChars === 'number' ? input.maxTextChars : undefined
  })
});

registerAgentTool({
  name: 'browser_screenshot',
  title: 'Capture Browser Screenshot',
  description: '保存已打开页面的截图到临时目录，并返回图片路径。适合验证布局、空白屏和视觉回归。',
  inputSchema: z.object({
    sessionId: z.string().min(1).describe('browser_open 返回的浏览器会话 ID。'),
    fullPage: z.boolean().optional().describe('是否先滚动到页面顶部再截图。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'browser_screenshot',
    sessionId: String(input.sessionId),
    fullPage: typeof input.fullPage === 'boolean' ? input.fullPage : undefined
  })
});

registerAgentTool({
  name: 'browser_click',
  title: 'Click Browser Element',
  description: '在已打开页面中点击 selector 或文本匹配的元素。适合验证按钮、菜单、表单流程；高风险，host 会在执行点做权限判断。',
  inputSchema: z.object({
    sessionId: z.string().min(1).describe('browser_open 返回的浏览器会话 ID。'),
    selector: z.string().optional().describe('CSS selector，例如 button[type="submit"] 或 [data-testid="save"]。'),
    text: z.string().optional().describe('没有 selector 时按可交互元素文本或 aria-label 匹配。'),
    reason: z.string().optional().describe('为什么需要点击这个元素。')
  }),
  risk: 'high',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'browser_click',
    sessionId: String(input.sessionId),
    selector: typeof input.selector === 'string' ? input.selector : undefined,
    text: typeof input.text === 'string' ? input.text : undefined,
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});

registerAgentTool({
  name: 'browser_type',
  title: 'Type In Browser',
  description: '向已打开页面的输入控件写入文本。适合验证 composer、表单或搜索框；高风险，host 会在执行点做权限判断。',
  inputSchema: z.object({
    sessionId: z.string().min(1).describe('browser_open 返回的浏览器会话 ID。'),
    selector: z.string().min(1).describe('目标输入控件 CSS selector。'),
    text: z.string().describe('要输入的文本。'),
    clear: z.boolean().optional().describe('输入前是否清空现有内容。默认 false。'),
    reason: z.string().optional().describe('为什么需要输入文本。')
  }),
  risk: 'high',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'browser_type',
    sessionId: String(input.sessionId),
    selector: String(input.selector),
    text: String(input.text),
    clear: typeof input.clear === 'boolean' ? input.clear : undefined,
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});

registerAgentTool({
  name: 'browser_console',
  title: 'Read Browser Console',
  description: '读取已打开页面最近的 console 消息。适合排查前端运行错误。',
  inputSchema: z.object({
    sessionId: z.string().min(1).describe('browser_open 返回的浏览器会话 ID。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'browser_console',
    sessionId: String(input.sessionId)
  })
});

registerAgentTool({
  name: 'browser_list',
  title: 'List Browser Pages',
  description: '列出当前项目已打开的本地浏览器检查会话。',
  inputSchema: z.object({}),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: () => ({
    type: 'browser_list'
  })
});

registerAgentTool({
  name: 'browser_close',
  title: 'Close Browser Page',
  description: '关闭一个或全部本地浏览器检查会话。高风险，host 会在执行点做权限判断。',
  inputSchema: z.object({
    sessionId: z.string().optional().describe('可选，不填则关闭全部浏览器检查会话。'),
    reason: z.string().optional().describe('为什么需要关闭浏览器会话。')
  }),
  risk: 'high',
  permissionPolicy: 'ask',
  checkpointPolicy: 'external_best_effort',
  readOnly: false,
  toAction: (input) => ({
    type: 'browser_close',
    sessionId: typeof input.sessionId === 'string' ? input.sessionId : undefined,
    reason: typeof input.reason === 'string' ? input.reason : undefined
  })
});
