import type {
  ActivityItem,
  GameAgentExecutionPlan,
  AiProjectPlan,
  AiProjectUpdate,
  AssetItem,
  ChatMessageMetadata,
  CreateProjectInput,
  GameTemplateId,
  Project,
  ProjectBlueprint,
  ProjectContextSummary,
  ProjectMemory,
  Snapshot,
  TaskItem,
  TaskPhase
} from './types';
import { createProjectSessionRecord, ensureProjectSessions, getActiveProjectSession, replaceActiveProjectSession } from './project-sessions';

const templateProfiles: Record<
  GameTemplateId,
  {
    playerFantasy: string;
    targetAudience: string;
    coreLoop: string[];
    pillars: string[];
    differentiators: string[];
    starterTasks: Array<{
      title: string;
      phase: TaskPhase;
      owner: string;
      description: string;
    }>;
    starterAssets: Array<{
      name: string;
      type: AssetItem['type'];
      promptSeed: string;
      notes: string;
    }>;
  }
> = {
  'generic-workspace': {
    playerFantasy: '让使用者在同一个工作区里完成文件查看、内容整理、AI 对话和持续推进。',
    targetAudience: '需要管理代码、文档、素材或普通项目资料的非技术用户与轻量团队。',
    coreLoop: ['打开项目', '查看文件', '与 AI 对话', '编辑内容', '预览结果'],
    pillars: ['结构清晰', '上下文连续', '操作低门槛'],
    differentiators: ['不强制绑定游戏引擎', '优先服务通用项目协作', '支持从已有目录快速接入'],
    starterTasks: [
      {
        title: '梳理项目目标',
        phase: 'Concept',
        owner: 'AI Assistant',
        description: '确认当前项目的用途、关键目录和近期要完成的事项。'
      },
      {
        title: '建立文件上下文',
        phase: 'Content',
        owner: 'AI Assistant',
        description: '根据项目文件树整理可编辑、可预览和需要重点关注的文件。'
      },
      {
        title: '规划下一步工作',
        phase: 'Validation',
        owner: 'AI Assistant',
        description: '把用户需求拆成可执行步骤，并在对话中持续跟进。'
      }
    ],
    starterAssets: []
  },
  'engine-game-prototype': {
    playerFantasy: '让创作者先获得一个可运行、可验证、可持续迭代的游戏原型。',
    targetAudience: '正在探索玩法方向、引擎工程结构和首个可玩闭环的游戏创作者。',
    coreLoop: ['确认目标体验', '搭建场景骨架', '实现基础交互', '运行验证', '迭代体验'],
    pillars: ['先跑起来', '工程结构清晰', '验证路径明确'],
    differentiators: ['不预设具体游戏品类', '优先建立引擎连接与项目结构', '每次改动都尽量形成可验证结果'],
    starterTasks: [
      {
        title: '确认项目目标',
        phase: 'Concept',
        owner: 'AI Assistant',
        description: '根据用户输入和项目文件确认玩法方向、技术边界和近期目标。'
      },
      {
        title: '建立引擎项目骨架',
        phase: 'Unity',
        owner: 'Engine Agent',
        description: '确认场景、资源目录、脚本目录和引擎 Bridge / MCP 连接状态。'
      },
      {
        title: '实现首个可运行闭环',
        phase: 'Content',
        owner: 'AI Assistant',
        description: '围绕用户指定的玩法实现最小交互、反馈和基础 UI。'
      },
      {
        title: '运行验证并记录问题',
        phase: 'Validation',
        owner: 'QA Agent',
        description: '通过编辑器、预览或自动化检查验证当前原型是否可运行。'
      }
    ],
    starterAssets: []
  },
  '2d-roguelike': {
    playerFantasy: '让玩家持续感受到“每一局都能快速上手、不断变强”的爽感。',
    targetAudience: '偏爱重复游玩、成长选择和快节奏战斗的动作玩家。',
    coreLoop: ['进入房间', '战斗清场', '获得强化', '推进楼层', '面对更强敌人'],
    pillars: ['战斗反馈清晰', '成长选择有记忆点', '单局节奏短而紧凑'],
    differentiators: ['以单局 10 分钟可玩闭环优先', '先固化房间清怪体验', '优先实现角色移动、攻击、掉落三件套'],
    starterTasks: [
      {
        title: '固化游戏核心循环',
        phase: 'Concept',
        owner: 'PM Agent',
        description: '把用户创意压缩成 1 条核心循环和 3 条产品支柱。'
      },
      {
        title: '定义角色与敌人基础规格',
        phase: 'Content',
        owner: 'Design Agent',
        description: '输出主角、普通敌人、精英敌人的基础行为差异。'
      },
      {
        title: '搭建 Unity 场景骨架',
        phase: 'Unity',
        owner: 'Unity Agent',
        description: '建立主场景、房间节点、基础 UI 和输入预设。'
      },
      {
        title: '规划首轮 Play Mode 验证',
        phase: 'Validation',
        owner: 'QA Agent',
        description: '验证角色移动、攻击触发、敌人受击与结算流程。'
      }
    ],
    starterAssets: [
      {
        name: '主角立绘与行走循环',
        type: 'character',
        promptSeed: '2D 主角，强调辨识度和战斗姿态',
        notes: '首版优先确保轮廓与动作方向统一。'
      },
      {
        name: '基础地牢房间 tileset',
        type: 'environment',
        promptSeed: '2D 地牢地面、墙体、门与装饰元素',
        notes: '优先服务可玩性和空间识别。'
      },
      {
        name: '基础战斗 UI',
        type: 'ui',
        promptSeed: '血量条、技能槽、局内掉落提示',
        notes: '要求高对比度与信息层次。'
      },
      {
        name: '战斗音效与命中反馈',
        type: 'audio',
        promptSeed: '攻击、受击、掉落、结算的短音效',
        notes: '优先保证反馈明确。'
      }
    ]
  },
  'narrative-adventure': {
    playerFantasy: '让玩家沉浸在角色关系、对话抉择和氛围叙事中。',
    targetAudience: '偏爱轻叙事、探索和情绪表达的玩家。',
    coreLoop: ['探索场景', '触发对话', '做出选择', '推进剧情节点', '解锁新区域'],
    pillars: ['角色关系鲜明', '文本节奏轻快', '场景情绪稳定统一'],
    differentiators: ['先完成第一幕叙事闭环', '突出角色关系与情绪节点', '优先验证对话和过场体验'],
    starterTasks: [
      {
        title: '整理第一幕叙事结构',
        phase: 'Concept',
        owner: 'Narrative Agent',
        description: '确定开场冲突、关键选择点与章节收束。'
      },
      {
        title: '定义主要角色立场',
        phase: 'Content',
        owner: 'Narrative Agent',
        description: '给出主角和两位关键角色的关系与台词风格。'
      },
      {
        title: '搭建场景切换与对话 UI',
        phase: 'Unity',
        owner: 'Unity Agent',
        description: '建立基础场景切换、立绘和对话框结构。'
      },
      {
        title: '验证剧情推进可读性',
        phase: 'Validation',
        owner: 'QA Agent',
        description: '检验首幕推进逻辑、对话顺序和玩家选择回显。'
      }
    ],
    starterAssets: [
      {
        name: '主角与关键角色立绘',
        type: 'character',
        promptSeed: '角色立绘，强调表情层次与关系感',
        notes: '先做核心角色，保证统一风格。'
      },
      {
        name: '首幕关键场景背景',
        type: 'environment',
        promptSeed: '叙事场景背景，突出氛围和情绪灯光',
        notes: '优先做开场和冲突场景。'
      },
      {
        name: '对话与选择 UI',
        type: 'ui',
        promptSeed: '对话框、角色名牌、选择按钮',
        notes: '保证文本可读性。'
      },
      {
        name: '氛围音与环境声',
        type: 'audio',
        promptSeed: '环境底噪、按钮反馈、情绪音效',
        notes: '避免喧宾夺主。'
      }
    ]
  },
  'topdown-action': {
    playerFantasy: '让玩家快速进入战斗，通过操作与技能反馈获得爽感。',
    targetAudience: '偏爱即时操作、躲避和技能连携的动作玩家。',
    coreLoop: ['进入战场', '规避敌人', '释放技能', '清理敌波', '挑战强敌'],
    pillars: ['移动与攻击响应快', '敌人行为易读', '技能表现直接有冲击力'],
    differentiators: ['先打磨角色手感', '优先落地敌波压力设计', '首版以单张地图验证战斗体验'],
    starterTasks: [
      {
        title: '明确首张战斗地图目标',
        phase: 'Concept',
        owner: 'PM Agent',
        description: '确定地图节奏、敌波强度与目标时长。'
      },
      {
        title: '定义技能与敌人压制关系',
        phase: 'Content',
        owner: 'Design Agent',
        description: '列出基础技能、敌人类型和应对关系。'
      },
      {
        title: '搭建地图与战斗控制器',
        phase: 'Unity',
        owner: 'Unity Agent',
        description: '建立角色控制器、敌波刷怪和 UI。'
      },
      {
        title: '验证核心战斗反馈',
        phase: 'Validation',
        owner: 'QA Agent',
        description: '检查命中反馈、技能冷却和失败重试流程。'
      }
    ],
    starterAssets: [
      {
        name: '角色战斗动作包',
        type: 'character',
        promptSeed: '俯视角角色，待机、移动、攻击、受击动作',
        notes: '先保证战斗动作一致性。'
      },
      {
        name: '战场与障碍物素材',
        type: 'environment',
        promptSeed: '俯视角地图地面、障碍、装饰元素',
        notes: '服务战斗空间判断。'
      },
      {
        name: '局内信息 UI',
        type: 'ui',
        promptSeed: '技能冷却、血量、波次提示',
        notes: '强调可读性。'
      },
      {
        name: '技能与命中特效音',
        type: 'audio',
        promptSeed: '技能释放、命中、闪避、结算反馈',
        notes: '突出战斗节奏。'
      }
    ]
  }
};

import { makeId, nowIso } from './utils';

function normalizePitch(pitch: string): string {
  return pitch.replace(/\s+/g, ' ').trim();
}

function buildBlueprint(input: CreateProjectInput): ProjectBlueprint {
  const profile = templateProfiles[input.templateId];
  const isGenericWorkspace = input.templateId === 'generic-workspace' || input.engine?.platform === 'web';
  const isEnginePrototype = input.templateId === 'engine-game-prototype';
  return {
    premise: isGenericWorkspace
      ? `${input.name} 是一个${normalizePitch(input.pitch)}。`
      : isEnginePrototype
        ? `${input.name}：${normalizePitch(input.pitch)}。`
        : `${input.name} 是一款 ${normalizePitch(input.pitch)} 的 ${input.templateId.replace(/-/g, ' ')} 游戏。`,
    playerFantasy: profile.playerFantasy,
    targetAudience: profile.targetAudience,
    artDirection: isGenericWorkspace
      ? `${input.artStyle}，并围绕“${profile.pillars[0]}”建立统一工作区表达。`
      : `${input.artStyle}，并围绕“${profile.pillars[0]}”建立统一视觉表达。`,
    coreLoop: [...profile.coreLoop],
    pillars: [...profile.pillars],
    differentiators: [...profile.differentiators]
  };
}

function buildTasks(input: CreateProjectInput): TaskItem[] {
  return templateProfiles[input.templateId].starterTasks.map((task, index) => ({
    id: makeId('task'),
    title: task.title,
    phase: task.phase,
    owner: task.owner,
    description: task.description,
    status: index === 0 ? 'in_progress' : 'pending'
  }));
}

function buildAssets(input: CreateProjectInput): AssetItem[] {
  return templateProfiles[input.templateId].starterAssets.map((asset) => ({
    id: makeId('asset'),
    name: asset.name,
    type: asset.type,
    status: 'planned',
    prompt: `${asset.promptSeed}，风格方向：${input.artStyle}。项目概念：${normalizePitch(input.pitch)}`,
    notes: asset.notes
  }));
}

function buildInitialActivity(project: Project): ActivityItem[] {
  if (project.templateId === 'generic-workspace' || project.engine?.platform === 'web') {
    return [
      {
        id: makeId('act'),
        kind: 'project',
        title: '项目已创建',
        detail: `已接入通用工作区：${project.engine?.projectPath || project.name}。`,
        createdAt: project.createdAt
      },
      {
        id: makeId('act'),
        kind: 'planning',
        title: '初始工作流已准备',
        detail: `共生成 ${project.tasks.length} 条通用协作任务。`,
        createdAt: project.createdAt
      }
    ];
  }

  if (project.templateId === 'engine-game-prototype') {
    return [
      {
        id: makeId('act'),
        kind: 'project',
        title: '项目已创建',
        detail: `已接入引擎项目：${project.engine?.projectPath || project.name}。`,
        createdAt: project.createdAt
      },
      {
        id: makeId('act'),
        kind: 'planning',
        title: '基础工作流已准备',
        detail: `共生成 ${project.tasks.length} 条引擎项目协作任务。`,
        createdAt: project.createdAt
      }
    ];
  }

  return [
    {
      id: makeId('act'),
      kind: 'project',
      title: '项目已创建',
      detail: `已根据“${project.pitch}”生成首版项目蓝图。`,
      createdAt: project.createdAt
    },
    {
      id: makeId('act'),
      kind: 'planning',
      title: '首版计划已生成',
      detail: `共生成 ${project.tasks.length} 条任务与 ${project.assets.length} 项资源需求。`,
      createdAt: project.createdAt
    }
  ];
}

function createEmptyMemory(createdAt: string): ProjectMemory {
  return {
    designDirectives: [],
    artDirectives: [],
    technicalConstraints: [],
    openQuestions: [],
    updatedAt: createdAt
  };
}

function createEmptyContextSummary(createdAt: string): ProjectContextSummary {
  return {
    projectBrief: '',
    currentGoal: '',
    recentDecisions: [],
    activeTasks: [],
    recentActivity: [],
    compressedFrom: 0,
    updatedAt: createdAt
  };
}

export function materializeExecutionPlan(
  plan: AiProjectPlan['executionPlan'] | AiProjectUpdate['executionPlan'] | undefined
): GameAgentExecutionPlan | undefined {
  if (!plan) {
    return undefined;
  }

  return {
    summary: plan.summary,
    rationale: plan.rationale,
    actions: plan.actions.map((action) => ({
      id: makeId('action'),
      pluginKind: action.pluginKind,
      title: action.title,
      objective: action.objective,
      suggestedTools: [...action.suggestedTools],
      inputs: [...action.inputs],
      operations: (action.operations ?? []).map((operation) => ({
        type: operation.type,
        target: operation.target,
        arguments: operation.arguments ? { ...operation.arguments } : undefined
      })),
      successCriteria: [...action.successCriteria],
      status: 'suggested'
    }))
  };
}

export function createProjectFromInput(input: CreateProjectInput): Project {
  const timestamp = nowIso();
  const project: Project = {
    id: makeId('project'),
    name: input.name.trim(),
    templateId: input.templateId,
    artStyle: input.artStyle.trim(),
    pitch: normalizePitch(input.pitch),
    status: 'planning',
    engine: input.engine
      ? {
          platform: input.engine.platform,
          setupMode: input.engine.setupMode,
          projectPath: input.engine.projectPath,
          dimension: input.engine.dimension,
          unityEditorVersion: input.engine.unityEditorVersion
        }
      : undefined,
    runtimeState: undefined,
    mcpPluginId: undefined,
    mcpBindings: {},
    createdAt: timestamp,
    updatedAt: timestamp,
    blueprint: buildBlueprint(input),
    tasks: buildTasks(input),
    assets: buildAssets(input),
    assetGenerationJobs: [],
    assetGenerationPresets: [],
    sessions: [],
    activeSessionId: undefined,
    chat: [],
    activity: [],
    snapshots: [],
    memory: createEmptyMemory(timestamp),
    contextSummary: createEmptyContextSummary(timestamp)
  };

  const initialSession = createProjectSessionRecord({
    title: project.name,
    chat: project.chat,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    autoTitle: false
  });
  project.sessions = [initialSession];
  project.activeSessionId = initialSession.id;
  project.activity = buildInitialActivity(project);
  return project;
}

export function applyAiProjectPlan(project: Project, plan: AiProjectPlan): Project {
  const updatedAt = nowIso();
  const next: Project = {
    ...project,
    updatedAt,
    status: 'active',
    blueprint: {
      premise: plan.premise,
      playerFantasy: plan.playerFantasy,
      targetAudience: plan.targetAudience,
      artDirection: plan.artDirection,
      coreLoop: [...plan.coreLoop],
      pillars: [...plan.pillars],
      differentiators: [...plan.differentiators]
    },
    tasks: plan.tasks.map((task, index) => ({
      id: makeId('task'),
      title: task.title,
      phase: task.phase,
      owner: task.owner,
      description: task.description,
      status: index === 0 ? 'in_progress' : 'pending'
    })),
    assets: plan.assets.map((asset) => ({
      id: makeId('asset'),
      name: asset.name,
      type: asset.type,
      prompt: asset.prompt,
      notes: asset.notes,
      status: 'planned'
    })),
    chat: [
      {
        id: makeId('msg'),
        role: 'assistant',
        createdAt: updatedAt,
        content: plan.assistantReply
      }
    ],
    activity: [
      {
        id: makeId('act'),
        kind: 'project',
        title: 'AI 已生成首版蓝图',
        detail: `已基于当前提供商生成 ${plan.tasks.length} 条任务与 ${plan.assets.length} 项资源。`,
        createdAt: updatedAt
      }
    ],
    memory: project.memory,
    contextSummary: project.contextSummary,
    currentExecutionPlan: materializeExecutionPlan(plan.executionPlan)
  };
  const ensured = ensureProjectSessions(next);
  const activeSession = getActiveProjectSession(ensured);
  return replaceActiveProjectSession(ensured, {
    ...activeSession,
    chat: [...next.chat],
    updatedAt,
    autoTitle: activeSession.autoTitle
  });
}

function ensureTask(project: Project, title: string, phase: TaskPhase, owner: string, description: string): void {
  const exists = project.tasks.some((task) => task.title === title);
  if (exists) {
    return;
  }

  project.tasks.push({
    id: makeId('task'),
    title,
    phase,
    owner,
    description,
    status: 'pending'
  });
}

function ensureAsset(project: Project, name: string, type: AssetItem['type'], prompt: string, notes: string): void {
  const exists = project.assets.some((asset) => asset.name === name);
  if (exists) {
    return;
  }

  project.assets.push({
    id: makeId('asset'),
    name,
    type,
    prompt,
    notes,
    status: 'planned'
  });
}

function addActivity(project: Project, title: string, detail: string, kind: ActivityItem['kind'] = 'planning'): void {
  project.activity.unshift({
    id: makeId('act'),
    kind,
    title,
    detail,
    createdAt: nowIso()
  });
}

function updateArtDirection(project: Project, message: string): string[] {
  const changes: string[] = [];

  if (/(可爱|q版|萌)/i.test(message)) {
    project.blueprint.artDirection = `${project.artStyle}，整体角色比例更亲和，表情和轮廓更偏可爱化表达。`;
    changes.push('已将视觉方向调整为更可爱、亲和的角色表达。');
    ensureAsset(
      project,
      '主角表情与头像补充包',
      'character',
      `可爱风主角头像、表情变化、半身像，统一 ${project.artStyle} 风格。`,
      '用于强化角色亲和力。'
    );
  }

  if (/(赛博|cyber|科幻)/i.test(message)) {
    project.blueprint.artDirection = `${project.artStyle}，加入赛博科技感、霓虹对比和高识别度界面语言。`;
    changes.push('已将美术方向补充赛博科技元素。');
    ensureAsset(
      project,
      '赛博风界面组件包',
      'ui',
      `赛博霓虹风格 UI，包含按钮、状态条、提示框和悬浮信息。`,
      '适配局内 HUD 与菜单。'
    );
  }

  return changes;
}

function updateGameplay(project: Project, message: string): string[] {
  const changes: string[] = [];

  if (/(节奏更快|更快|爽快|加快)/i.test(message)) {
    project.blueprint.pillars = [
      '战斗反馈更高频',
      ...project.blueprint.pillars.filter((item) => item !== '战斗反馈更高频')
    ].slice(0, 3);
    ensureTask(project, '提升战斗节奏与反馈频率', 'Content', 'Design Agent', '调整敌波间隔、攻击前摇和掉落节奏。');
    ensureTask(project, '验证高频战斗下的手感稳定性', 'Validation', 'QA Agent', '重点回放移动、攻击和命中音效的连续体验。');
    changes.push('已加入更快战斗节奏的设计与验证任务。');
  }

  if (/(boss|首领|精英)/i.test(message)) {
    ensureTask(project, '设计首个 Boss 战', 'Content', 'Design Agent', '定义 Boss 行为树、阶段变化和弱点机制。');
    ensureAsset(
      project,
      'Boss 角色与攻击特效',
      'vfx',
      `首个 Boss 的攻击轮廓、技能警示、命中与死亡特效，匹配 ${project.artStyle}。`,
      '优先服务可读性和压迫感。'
    );
    changes.push('已补充 Boss 战相关任务和特效资源。');
  }

  if (/(剧情|叙事|对话)/i.test(message)) {
    ensureTask(project, '补充关键剧情节点', 'Concept', 'Narrative Agent', '梳理开场、转折和结尾的三段式结构。');
    ensureAsset(
      project,
      '剧情对话与角色立绘扩展',
      'character',
      `用于剧情演出的角色半身像与表情变化，风格统一为 ${project.artStyle}。`,
      '用于增强叙事表达。'
    );
    changes.push('已补充剧情推进与角色演出需求。');
  }

  return changes;
}

export function applyPromptToProject(project: Project, message: string): Project {
  const baseProject = ensureProjectSessions(project);
  const prompt = normalizePitch(message);
  const updatedProject: Project = {
    ...baseProject,
    chat: [...baseProject.chat],
    tasks: [...baseProject.tasks],
    assets: [...baseProject.assets],
    activity: [...baseProject.activity],
    snapshots: [...baseProject.snapshots],
    blueprint: {
      ...baseProject.blueprint,
      coreLoop: [...baseProject.blueprint.coreLoop],
      pillars: [...baseProject.blueprint.pillars],
      differentiators: [...baseProject.blueprint.differentiators]
    }
  };

  updatedProject.chat.push({
    id: makeId('msg'),
    role: 'user',
    content: prompt,
    createdAt: nowIso()
  });

  const artChanges = updateArtDirection(updatedProject, prompt);
  const gameplayChanges = updateGameplay(updatedProject, prompt);
  const changes = [...artChanges, ...gameplayChanges];

  if (changes.length === 0) {
    ensureTask(updatedProject, '整理新增需求影响面', 'Concept', 'PM Agent', `评估新增需求“${prompt}”对玩法、美术和 Unity 实装的影响。`);
    changes.push('已记录本次需求，并新增影响面评估任务。');
  }

  updatedProject.updatedAt = nowIso();
  updatedProject.status = 'active';

  updatedProject.chat.push({
    id: makeId('msg'),
    role: 'assistant',
    createdAt: updatedProject.updatedAt,
    content: `收到，我已经根据这次需求更新项目蓝图。\n\n- ${changes.join('\n- ')}\n\n接下来我会优先推进结构化任务和资源清单，再把这些变更同步给 Unity 执行层。`
  });

  addActivity(updatedProject, '需求已吸收进蓝图', `新增指令：“${prompt}”。当前任务数 ${updatedProject.tasks.length}，资源项 ${updatedProject.assets.length}。`);

  const activeSession = getActiveProjectSession(updatedProject);
  return replaceActiveProjectSession(updatedProject, {
    ...activeSession,
    chat: [...updatedProject.chat],
    updatedAt: updatedProject.updatedAt
  });
}

export function applyAiPromptToProject(
  project: Project,
  message: string,
  update: AiProjectUpdate,
  assistantMetadata?: ChatMessageMetadata
): Project {
  const baseProject = ensureProjectSessions(project);
  const prompt = normalizePitch(message);
  const updatedAt = nowIso();
  const next: Project = {
    ...baseProject,
    updatedAt,
    status: 'active',
    blueprint: {
      ...baseProject.blueprint,
      premise: update.premise || baseProject.blueprint.premise,
      playerFantasy: update.playerFantasy || baseProject.blueprint.playerFantasy,
      targetAudience: update.targetAudience || baseProject.blueprint.targetAudience,
      artDirection: update.artDirection || baseProject.blueprint.artDirection,
      coreLoop: update.coreLoop?.length ? [...update.coreLoop] : [...baseProject.blueprint.coreLoop],
      pillars: update.pillars?.length ? [...update.pillars] : [...baseProject.blueprint.pillars],
      differentiators: update.differentiators?.length
        ? [...update.differentiators]
        : [...baseProject.blueprint.differentiators]
    },
    tasks: [...baseProject.tasks],
    assets: [...baseProject.assets],
    chat: [
      ...baseProject.chat,
      {
        id: makeId('msg'),
        role: 'user',
        content: prompt,
        createdAt: updatedAt
      }
    ],
    activity: [...baseProject.activity],
    snapshots: [...baseProject.snapshots],
    memory: baseProject.memory,
    contextSummary: baseProject.contextSummary,
    lastAgentRun: baseProject.lastAgentRun,
    currentExecutionPlan: materializeExecutionPlan(update.executionPlan) ?? baseProject.currentExecutionPlan
  };

  update.tasksToAdd.forEach((task) => {
    ensureTask(next, task.title, task.phase, task.owner, task.description);
  });

  update.assetsToAdd.forEach((asset) => {
    ensureAsset(next, asset.name, asset.type, asset.prompt, asset.notes);
  });

  next.chat.push({
    id: makeId('msg'),
    role: 'assistant',
    createdAt: updatedAt,
    content: update.assistantReply,
    metadata: assistantMetadata
  });

  addActivity(next, 'AI 已更新项目蓝图', update.activitySummary || `已吸收新增需求：“${prompt}”。`);
  const activeSession = getActiveProjectSession(next);
  return replaceActiveProjectSession(next, {
    ...activeSession,
    chat: [...next.chat],
    updatedAt
  });
}

export function createSnapshot(
  project: Project,
  note: string,
  options?: { sessionId?: string; includeSessionCheckpoint?: boolean; triggerUserMessageId?: string }
): Snapshot {
  const ensured = ensureProjectSessions(project);
  const checkpointSession =
    options?.includeSessionCheckpoint
      ? ensured.sessions.find((session) => session.id === options.sessionId) ?? getActiveProjectSession(ensured)
      : undefined;
  const createdAt = nowIso();

  return {
    id: makeId('snapshot'),
    note: note.trim() || '手动快照',
    summary: `${project.blueprint.premise} 当前共有 ${project.tasks.length} 条任务、${project.assets.length} 项资源。`,
    createdAt,
    sessionCheckpoint: checkpointSession
      ? {
          sessionId: checkpointSession.id,
          sessionTitle: checkpointSession.title,
          activeSessionId: ensured.activeSessionId,
          triggerUserMessageId: options?.triggerUserMessageId,
          chat: [...checkpointSession.chat],
          capturedAt: createdAt
        }
      : undefined
  };
}

export function formatProjectDocument(project: Project): string {
  const lines = [
    `# ${project.name}`,
    '',
    '## 项目概述',
    project.blueprint.premise,
    '',
    '## 美术方向',
    project.blueprint.artDirection,
    '',
    '## 玩家体验目标',
    project.blueprint.playerFantasy,
    '',
    '## 核心循环',
    ...project.blueprint.coreLoop.map((item) => `- ${item}`),
    '',
    '## 设计支柱',
    ...project.blueprint.pillars.map((item) => `- ${item}`),
    '',
    '## 差异化策略',
    ...project.blueprint.differentiators.map((item) => `- ${item}`),
    '',
    '## 项目记忆',
    ...project.memory.designDirectives.map((item) => `- 设计：${item}`),
    ...project.memory.artDirectives.map((item) => `- 美术：${item}`),
    ...project.memory.technicalConstraints.map((item) => `- 技术：${item}`),
    ...project.memory.openQuestions.map((item) => `- 待确认：${item}`),
    '',
    '## 当前阶段摘要',
    `- 项目摘要：${project.contextSummary.projectBrief}`,
    `- 当前目标：${project.contextSummary.currentGoal}`,
    ...project.contextSummary.recentDecisions.map((item) => `- 近期决策：${item}`),
    ...project.contextSummary.activeTasks.map((item) => `- 活跃任务：${item}`),
    ...project.contextSummary.recentActivity.map((item) => `- 最近活动：${item}`),
    '',
    '## 多插件执行计划',
    ...(project.currentExecutionPlan
      ? [
          `- 摘要：${project.currentExecutionPlan.summary}`,
          `- 原因：${project.currentExecutionPlan.rationale}`,
          ...project.currentExecutionPlan.actions.map(
            (action) =>
              `- ${action.pluginKind} / ${action.title}：${action.objective} | tools=${action.suggestedTools.join(', ')}`
          )
        ]
      : ['- 暂无执行计划']),
    '',
    '## 制作任务',
    ...project.tasks.map((task) => `- [${task.status}] ${task.phase} / ${task.title}：${task.description}`),
    '',
    '## 资源清单',
    ...project.assets.map((asset) => `- ${asset.type} / ${asset.name}：${asset.prompt}`),
    ''
  ];

  return lines.join('\n');
}
