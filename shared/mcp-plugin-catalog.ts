import type { McpPluginPreset } from './types';

export const MCP_PLUGIN_PRESETS: McpPluginPreset[] = [
  {
    id: 'custom-mcp',
    name: 'Custom MCP Server',
    kind: 'custom',
    transport: 'http',
    baseUrl: '',
    description: '任意兼容 MCP HTTP JSON-RPC 的 Server。'
  },
  {
    id: 'unity-mcp',
    name: 'Unity MCP',
    kind: 'engine',
    transport: 'http',
    baseUrl: 'http://127.0.0.1:8765/',
    description: 'GameBooom / FunseaAI Unity MCP 预设。'
  },
  {
    id: 'custom-stdio-mcp',
    name: 'Custom stdio MCP Server',
    kind: 'custom',
    transport: 'stdio',
    baseUrl: '',
    command: '',
    args: [],
    description: '通过本地命令启动的 MCP stdio Server。'
  },
  {
    id: 'custom-streamable-mcp',
    name: 'Custom Streamable HTTP MCP Server',
    kind: 'custom',
    transport: 'streamable-http',
    baseUrl: '',
    description: '兼容新版 MCP Streamable HTTP transport 的远端 Server。'
  },
  {
    id: 'custom-sse-mcp',
    name: 'Custom SSE MCP Server',
    kind: 'custom',
    transport: 'sse',
    baseUrl: '',
    description: '兼容旧版 MCP SSE transport 的远端 Server。'
  },
  {
    id: 'custom-engine-mcp',
    name: 'Custom MCP Server',
    kind: 'custom',
    transport: 'http',
    baseUrl: '',
    description: '任意兼容 MCP HTTP JSON-RPC 的 Server。'
  },
  {
    id: 'custom-asset-mcp',
    name: 'Custom MCP Server',
    kind: 'custom',
    transport: 'http',
    baseUrl: '',
    description: '任意兼容 MCP HTTP JSON-RPC 的 Server。'
  }
];
