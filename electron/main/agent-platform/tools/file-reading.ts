import { z } from 'zod';
import { registerAgentTool } from '../tool-registry-core';

registerAgentTool({
  name: 'scan_file_tree',
  title: 'Scan File Tree',
  description: '查看当前项目的文件树摘要。适合用户询问项目结构、有哪些文件、目录概览时使用。',
  inputSchema: z.object({}),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: () => ({
    type: 'scan_file_tree'
  })
});

registerAgentTool({
  name: 'read_file',
  title: 'Read File',
  description: '读取当前项目内的文本文件。路径必须是项目内相对路径；可用 offset/limit 读取指定行范围；读取 PDF/Office/RTF 或传 pages 时会自动走文档抽取。',
  inputSchema: z.object({
    path: z.string().min(1).describe('项目内相对文件路径，例如 src/App.tsx。'),
    offset: z.number().int().min(0).optional().describe('可选，0-based 起始行。'),
    limit: z.number().int().min(1).max(2000).optional().describe('可选，最多读取的行数。'),
    pages: z.string().optional().describe('可选，读取文档页码。支持 "3"、"1-5" 或 "1,3-5"；没有具体页码时请省略，空字符串会被忽略。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'read_file',
    path: String(input.path),
    offset: typeof input.offset === 'number' ? input.offset : undefined,
    limit: typeof input.limit === 'number' ? input.limit : undefined,
    pages: typeof input.pages === 'string' && input.pages.trim() ? input.pages.trim() : undefined
  })
});

registerAgentTool({
  name: 'read_document',
  title: 'Read Document',
  description: '读取项目内 PDF、RTF、DOCX、PPTX、XLSX 或带分页文本文件并抽取可读文本。支持 1-based pages，例如 "1-3"、"5" 或 "1,3-5"；空 pages 会被忽略。',
  inputSchema: z.object({
    path: z.string().min(1).describe('项目内相对文档路径，例如 docs/spec.pdf 或 slides/demo.pptx。'),
    pages: z.string().optional().describe('可选页码/幻灯片/工作表范围，格式 "1-5"、"3" 或 "1,3-5"。不要传空字符串。'),
    maxChars: z.number().int().min(1000).max(20000).optional().describe('最多返回多少字符，默认 12000，最大 20000。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'read_document',
    path: String(input.path),
    pages: typeof input.pages === 'string' && input.pages.trim() ? input.pages.trim() : undefined,
    maxChars: typeof input.maxChars === 'number' ? input.maxChars : undefined
  })
});

registerAgentTool({
  name: 'find_files',
  title: 'Find Files',
  description: '按 glob 文件名或路径模式查找项目文件，例如 *.ts、**/*.tsx、src/**/*.json。',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('glob 文件名或路径模式，例如 **/*.ts。'),
    path: z.string().optional().describe('可选，限制搜索的项目内相对目录。'),
    maxResults: z.number().int().min(1).max(120).optional().describe('可选，最多返回多少个文件。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'find_files',
    pattern: String(input.pattern),
    path: typeof input.path === 'string' ? input.path : undefined,
    maxResults: typeof input.maxResults === 'number' ? input.maxResults : undefined
  })
});

registerAgentTool({
  name: 'search_project_content',
  title: 'Search Project Content',
  description: '在当前项目文本文件中搜索关键词、正则或符号。支持 regex、glob/path 限制、上下文行、大小写、文件类型、输出模式和分页。',
  inputSchema: z.object({
    query: z.string().min(1).describe('要搜索的关键词、符号名、正则表达式或错误信息。'),
    regex: z.boolean().optional().describe('是否把 query 当作正则表达式。默认 false。'),
    glob: z.string().optional().describe('可选，限制文件路径 glob，例如 **/*.tsx 或 src/**/*.ts。'),
    path: z.string().optional().describe('可选，限制搜索的项目内相对目录或文件。'),
    outputMode: z.enum(['content', 'files_with_matches', 'count']).optional().describe('输出模式：content 返回匹配片段，files_with_matches 只列文件，count 只返回计数。默认 content。'),
    contextBefore: z.number().int().min(0).max(20).optional().describe('每个匹配前返回多少行上下文。默认 0。'),
    contextAfter: z.number().int().min(0).max(20).optional().describe('每个匹配后返回多少行上下文。默认 0。'),
    caseInsensitive: z.boolean().optional().describe('是否大小写不敏感。默认 true。'),
    fileType: z.string().optional().describe('可选文件类型/扩展名过滤，例如 ts、tsx、md 或 .json。'),
    limit: z.number().int().min(1).max(50).optional().describe('最多返回多少个匹配项或文件，默认 8，最大 50。'),
    offset: z.number().int().min(0).optional().describe('可选分页 offset，跳过前 N 个匹配项。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'search_project_content',
    query: String(input.query),
    regex: typeof input.regex === 'boolean' ? input.regex : undefined,
    glob: typeof input.glob === 'string' ? input.glob : undefined,
    path: typeof input.path === 'string' ? input.path : undefined,
    outputMode: input.outputMode,
    contextBefore: typeof input.contextBefore === 'number' ? input.contextBefore : undefined,
    contextAfter: typeof input.contextAfter === 'number' ? input.contextAfter : undefined,
    caseInsensitive: typeof input.caseInsensitive === 'boolean' ? input.caseInsensitive : undefined,
    fileType: typeof input.fileType === 'string' ? input.fileType : undefined,
    limit: typeof input.limit === 'number' ? input.limit : undefined,
    offset: typeof input.offset === 'number' ? input.offset : undefined
  })
});

registerAgentTool({
  name: 'summarize_directory',
  title: 'Summarize Directory',
  description: '汇总当前项目内某个目录的直接子项与文件数量。路径必须是项目内相对目录路径。',
  inputSchema: z.object({
    path: z.string().min(1).describe('项目内相对目录路径，例如 src 或 electron/main。')
  }),
  risk: 'low',
  permissionPolicy: 'always',
  checkpointPolicy: 'none',
  readOnly: true,
  toAction: (input) => ({
    type: 'summarize_directory',
    path: String(input.path)
  })
});
