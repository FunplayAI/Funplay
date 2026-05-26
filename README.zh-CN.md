# Funplay

<p align="center">
  <img src="./Logo.png" alt="Funplay" width="144" />
</p>

<p align="center">
  面向多种游戏引擎的 AI 游戏开发工作台，把创意推进成高质量可玩的游戏。
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Electron-41%2B-47848f?logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=111111" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white" alt="TypeScript strict" />
  <img src="https://img.shields.io/badge/License-MIT-green" alt="MIT License" />
</p>

Funplay 是一个开源桌面端 AI 游戏创作工作台。它面向那些有游戏想法、但不想被引擎配置、项目结构、素材流程、编辑器面板、构建步骤和复杂工程细节卡住的人。

Funplay 的产品目标很直接：你描述想做的游戏，连接自己信任的游戏引擎和 AI Provider，Funplay 帮你规划、开发、生成素材、检查运行状态、测试改动，并持续把项目推进到高质量可玩的结果。

当前 Unity 是第一优先支持的引擎工作流。但 Funplay 的架构不是绑定某一个编辑器：MCP、引擎状态面板、项目检查器、工具契约和 runtime adapter 都按多引擎方向设计，后续可以让 Godot、Unreal、自定义 Web 游戏和其他引擎工作流复用同一个 AI 工作台。

## Funplay 能帮你做什么

- 把粗略的游戏创意拆成可执行的开发计划。
- 把陌生的游戏引擎流程拆成更容易理解和执行的步骤。
- 让 Agent 在理解当前项目文件的基础上创建和修改代码。
- 使用不同 AI Provider 完成编码、策划、审查、素材提示词和长链路工具调用。
- 打开和检查引擎项目，当前重点是 Unity Editor 和 Unity MCP 工作流。
- 生成并管理游戏素材，包括 2D 图片、UI、纹理、音频、3D 和动画相关任务。
- 用清晰的摘要、详情弹层、权限检查和恢复信息展示工具调用过程。
- 在本地保存项目、会话、Provider 设置、生成素材和 Agent 运行历史。

## 核心特性

- 项目优先的桌面工作区：会话、文件、素材、Provider 和引擎状态都围绕真实本地项目组织。
- Native Agent runtime：支持文件读取、补丁修改、终端、浏览器检查、Web 搜索、MCP、记忆、通知和 checkpoint 工具。
- Claude Code runtime 选项：可以在同一个桌面壳里使用接近 Claude Code 的项目自动化能力。
- 多 Provider 配置：支持 OpenAI 兼容协议、Anthropic、Google、Bedrock 和自定义端点。
- 素材生成中心：支持外部 Provider 的生成任务、确定性文件命名和项目素材发现。
- 引擎集成层：当前支持 Unity 工作流，并通过 MCP 和引擎适配器继续扩展到更多引擎。
- 本地优先持久化：使用 SQLite 保存项目和会话状态，密钥保存在主进程，不暴露给渲染进程。
- 桌面打包自动化：支持 macOS 分架构构建和 Windows 安装包。

## 项目结构

```text
electron/main/      主进程服务、IPC handler、存储和 Agent runtime
electron/preload/   暴露给渲染进程的安全 context bridge
src/                React 渲染进程 UI
shared/             跨进程类型、Provider catalog 和共享 planner
tests/              Runtime 和确定性 Agent 测试
scripts/            构建、smoke、benchmark 和发布辅助脚本
resources/          图标和 runtime 资源占位
```

重要边界：

- `src/` 中的渲染进程代码不能 import `electron/main/`。
- `electron/main/` 中的主进程代码不能 import `src/`。
- 跨进程契约应放在 `shared/` 和 preload bridge 中。
- 新增 IPC 时需要同步更新类型、preload 暴露、主进程 handler 和 Zod 校验。

## Agent 与引擎架构

Funplay 把 runtime 编排、Provider 集成和引擎集成拆开：

- `electron/main/agent-core/` 负责 runtime 无关的编排：run registry、controller、权限、事件流、checkpoint 和 transcript ledger 行为。
- `electron/main/agent-platform/` 负责 Provider runtime adapter、工具契约、MCP 集成、引擎控制工具和 workspace action。
- `src/` 把 Agent Core parts 投影成桌面对话、设置页、素材库、引擎面板和素材生成中心。

目标形态是让一条 Agent message stream 成为唯一事实来源。UI、operation log、持久化视图和工具详情都只是它的读侧投影，而不是各自维护一套账本。

## Provider、素材与密钥

Funplay 分别支持聊天/模型 Provider、素材生成 Provider 和 MCP Server 配置。API Key 由主进程密钥存储管理，不会发送到渲染进程。

常用开发环境变量：

- `FUNPLAY_CLAUDE_CODE_CLI_PATH` - 覆盖 Claude Code CLI 可执行文件路径。
- `FUNPLAY_CLAUDE_CODE_FORCE_CLI=1` - 强制使用旧 Claude CLI stream 路径。
- `FUNPLAY_ALLOW_LOCAL_WEB_TOOLS=1` - 允许 Web 工具测试访问本地 URL。
- `BRAVE_SEARCH_API_KEY` / `BING_SEARCH_API_KEY` - 启用 Web Search Provider。
- `FUNPLAY_E2E_CLAUDE_API_KEY` + `FUNPLAY_E2E_CLAUDE_MODEL` - 启用 live Claude SDK E2E 检查。

## 本地开发

本地启动应用：

```bash
npm install
npm run dev
```

`npm run dev` 会先为 Electron ABI 重建原生依赖，然后启动 Electron Vite 开发服务器。

首次启动建议：

1. 打开应用设置。
2. 添加至少一个 AI Provider。
3. 创建或打开一个游戏项目。
4. 选择 runtime、模型、权限模式和引擎工作流。
5. 从一个明确目标开始，例如“做一个可玩的 Web Demo”或“打开这个 Unity 项目并加入第一关循环”。

常用开发命令：

```bash
npm run dev                 # 启动桌面端开发模式
npm run build               # 类型检查并构建所有 Electron target
npm run test:runtime        # 运行 runtime 测试，并处理原生依赖 ABI
npm run ui:smoke            # Renderer UI smoke 检查
npm run ui:electron-smoke   # Electron UI smoke 场景
npm run ui:maturity-gate    # UI 成熟度检查
npm run agent:e2e           # 确定性的 Agent E2E 检查
```

打包相关：

```bash
npm run dist:mac:split
npm run release:verify-mac-updates
npm run dist:win:x64
```

如果你手动运行单个 Node 测试文件，结束后需要恢复 Electron 原生依赖 ABI：

```bash
npm run rebuild:native:force
```

## 参与贡献

小而聚焦的 PR 最容易 review。提交 PR 前建议先运行：

```bash
npm run build
npm run test:runtime
```

如果改了 UI，也建议运行：

```bash
npm run ui:smoke
npm run ui:electron-smoke
npm run ui:maturity-gate
```

更多仓库边界和 PR 要求见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 项目状态

Funplay 仍处于 pre-1.0 阶段。公开版本线从 `v0.3.0` 开始，目前重点稳定：

- 多引擎 Agent 工作流
- Native 工具可靠性和权限表达
- Provider 与素材生成契约
- 桌面端 UI 体验
- 打包、签名和更新元数据自动化

## License

Funplay 使用 [MIT License](LICENSE)。
