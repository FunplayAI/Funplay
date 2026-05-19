import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

registerAgentTool({
  name: 'web_search',
  title: 'Web Search',
  description: '在互联网上搜索公开网页。支持域名过滤、去重和官方文档优先排序；适合用户要求查最新信息、外部文档、网页资料或当前事件时使用。',
  inputSchema: z.object({
    query: z.string().min(1).describe('搜索关键词或问题。'),
    maxResults: z.number().int().min(1).max(8).optional().describe('最多返回多少条搜索结果，默认 5。'),
    domains: z.array(z.string()).optional().describe('可选，只返回这些域名或其子域名的结果；可传多个，执行时会清洗去重并使用前几个有效域名。'),
    blockedDomains: z.array(z.string()).optional().describe('可选，排除这些域名或其子域名的结果。'),
    preferOfficial: z.boolean().optional().describe('是否优先官方文档、API reference、developer/docs 页面。'),
    provider: z.enum(['auto', 'duckduckgo', 'brave', 'bing']).optional().describe('搜索 provider。auto 会优先使用已配置 API Key 的 Brave/Bing，否则使用 duckduckgo。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'web_search',
    query: String(input.query),
    maxResults: typeof input.maxResults === 'number' ? input.maxResults : undefined,
    domains: Array.isArray(input.domains) ? input.domains.map(String) : undefined,
    blockedDomains: Array.isArray(input.blockedDomains) ? input.blockedDomains.map(String) : undefined,
    preferOfficial: typeof input.preferOfficial === 'boolean' ? input.preferOfficial : undefined,
    provider: input.provider
  })
});

registerAgentTool({
  name: 'web_fetch',
  title: 'Web Fetch',
  description: '读取一个公开 http/https 网页并提取正文文本。适合打开用户给出的 URL 或搜索结果 URL。',
  inputSchema: z.object({
    url: z.string().url().describe('要读取的 http/https URL。'),
    maxChars: z.number().int().min(1000).max(20000).optional().describe('最多返回多少字符，默认 20000。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'web_fetch',
    url: String(input.url),
    maxChars: typeof input.maxChars === 'number' ? input.maxChars : undefined
  })
});
