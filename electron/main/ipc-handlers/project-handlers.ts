import type { IpcMain } from 'electron';
import { shell } from 'electron';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import type { HandlerContext } from './types';
import {
  createProjectInputSchema,
  filePathSchema,
  mcpBindingKindSchema,
  noteSchema,
  pluginIdSchema,
  projectFileContentSchema,
  projectIdSchema,
  promptSchema,
  promptAttachmentsSchema,
  updateProjectAgentPolicySchema,
  updateSessionRuntimeSchema,
  validateIpcInput,
  agentUserInputResponseSchema
} from '../ipc-validation';
import {
  addProjectSnapshot,
  createProject,
  createProjectSession,
  deleteProject,
  deleteProjectSession,
  refreshProjectRuntimeState,
  previewSessionCheckpoint,
  renameProjectSession,
  restoreSessionCheckpoint,
  setActiveProjectSession,
  updateProjectAgentPolicy,
  updateProjectSessionRuntime,
  updateProjectMcpConfig,
  updateProjectMcpServerConfig,
  updateProjectWithPrompt
} from '../project-service';
import { listProjectFiles, readProjectFile, resolveProjectFileAbsolutePath, writeProjectFile } from '../project-file-service';
import { startProjectHtmlPreviewServer, stopProjectHtmlPreviewServer } from '../project-preview-dev-server';
import {
  cancelAgentExecutionPlanStream,
  executeAgentExecutionPlan,
  respondToAgentPermissionRequest,
  respondToAgentUserInputRequest,
  startAgentExecutionPlanStream
} from '../agent-platform/stream-manager';
import { cancelChatPromptStream, startChatPromptStream } from '../chat-stream-service';
import { syncProjectFileWatchers } from '../project-file-watcher';

export function registerProjectHandlers(ipcMain: IpcMain, ctx: HandlerContext): void {
  ipcMain.handle('projects:create', async (_, input: unknown) => {
    const state = ctx.getState();
    const project = await createProject(state, validateIpcInput(createProjectInputSchema, input, 'projects:create'));
    await ctx.setState({ ...state });
    syncProjectFileWatchers(state, ctx.dispatchProjectFileTreeChangedEvent);
    return project;
  });

  ipcMain.handle('projects:delete', async (_, projectId: unknown, deleteSourceFiles = false) => {
    const state = ctx.getState();
    const result = await deleteProject(state, validateIpcInput(projectIdSchema, projectId, 'projects:delete'), deleteSourceFiles);
    await ctx.setState({ ...state });
    syncProjectFileWatchers(state, ctx.dispatchProjectFileTreeChangedEvent);
    return result;
  });

  ipcMain.handle('projects:listFiles', async (_, projectId: unknown) => {
    return listProjectFiles(ctx.getState(), validateIpcInput(projectIdSchema, projectId, 'projects:listFiles'));
  });

  ipcMain.handle('projects:readFile', async (_, projectId: unknown, filePath: unknown) => {
    return readProjectFile(
      ctx.getState(),
      validateIpcInput(projectIdSchema, projectId, 'projects:readFile(projectId)'),
      validateIpcInput(filePathSchema, filePath, 'projects:readFile(filePath)')
    );
  });

  ipcMain.handle('projects:writeFile', async (_, projectId: unknown, filePath: unknown, content: unknown) => {
    return writeProjectFile(
      ctx.getState(),
      validateIpcInput(projectIdSchema, projectId, 'projects:writeFile(projectId)'),
      validateIpcInput(filePathSchema, filePath, 'projects:writeFile(filePath)'),
      validateIpcInput(projectFileContentSchema, content, 'projects:writeFile(content)')
    );
  });

  ipcMain.handle('projects:openFile', async (_, projectId: unknown, filePath: unknown) => {
    const absolutePath = resolveProjectFileAbsolutePath(
      ctx.getState(),
      validateIpcInput(projectIdSchema, projectId, 'projects:openFile(projectId)'),
      validateIpcInput(filePathSchema, filePath, 'projects:openFile(filePath)')
    );
    if (!existsSync(absolutePath)) {
      throw new Error(`Project file does not exist: ${absolutePath}`);
    }
    const errorMessage = await shell.openPath(absolutePath);
    if (errorMessage) {
      throw new Error(errorMessage);
    }
    return { success: true as const };
  });

  ipcMain.handle('projects:revealFile', async (_, projectId: unknown, filePath: unknown) => {
    const absolutePath = resolveProjectFileAbsolutePath(
      ctx.getState(),
      validateIpcInput(projectIdSchema, projectId, 'projects:revealFile(projectId)'),
      validateIpcInput(filePathSchema, filePath, 'projects:revealFile(filePath)')
    );
    if (!existsSync(absolutePath)) {
      throw new Error(`Project file does not exist: ${absolutePath}`);
    }
    shell.showItemInFolder(absolutePath);
    return { success: true as const };
  });

  ipcMain.handle('projects:startHtmlPreviewServer', async (_, projectId: unknown) => {
    return startProjectHtmlPreviewServer(
      ctx.getState(),
      validateIpcInput(projectIdSchema, projectId, 'projects:startHtmlPreviewServer(projectId)')
    );
  });

  ipcMain.handle('projects:stopHtmlPreviewServer', async (_, projectId: unknown) => {
    return stopProjectHtmlPreviewServer(
      validateIpcInput(projectIdSchema, projectId, 'projects:stopHtmlPreviewServer(projectId)')
    );
  });

  ipcMain.handle('projects:refreshRuntimeState', async (_, projectId: unknown) => {
    const state = ctx.getState();
    const project = await refreshProjectRuntimeState(state, validateIpcInput(projectIdSchema, projectId, 'projects:refreshRuntimeState'));
    await ctx.setState({ ...state });
    return project;
  });

  ipcMain.handle('projects:createSession', async (_, projectId: unknown, title: unknown) => {
    const state = ctx.getState();
    const project = createProjectSession(
      state,
      validateIpcInput(projectIdSchema, projectId, 'projects:createSession(projectId)'),
      validateIpcInput(z.string().trim().max(120).optional(), title, 'projects:createSession(title)')
    );
    await ctx.setState({ ...state });
    return project;
  });

  ipcMain.handle('projects:renameSession', async (_, projectId: unknown, sessionId: unknown, title: unknown) => {
    const state = ctx.getState();
    const project = renameProjectSession(
      state,
      validateIpcInput(projectIdSchema, projectId, 'projects:renameSession(projectId)'),
      validateIpcInput(projectIdSchema, sessionId, 'projects:renameSession(sessionId)'),
      validateIpcInput(z.string().trim().min(1).max(120), title, 'projects:renameSession(title)')
    );
    await ctx.setState({ ...state });
    return project;
  });

  ipcMain.handle('projects:deleteSession', async (_, projectId: unknown, sessionId: unknown) => {
    const state = ctx.getState();
    const project = deleteProjectSession(
      state,
      validateIpcInput(projectIdSchema, projectId, 'projects:deleteSession(projectId)'),
      validateIpcInput(projectIdSchema, sessionId, 'projects:deleteSession(sessionId)')
    );
    await ctx.setState({ ...state });
    return project;
  });

  ipcMain.handle('projects:setActiveSession', async (_, projectId: unknown, sessionId: unknown) => {
    const state = ctx.getState();
    const project = setActiveProjectSession(
      state,
      validateIpcInput(projectIdSchema, projectId, 'projects:setActiveSession(projectId)'),
      validateIpcInput(projectIdSchema, sessionId, 'projects:setActiveSession(sessionId)')
    );
    await ctx.setState({ ...state });
    return project;
  });

  ipcMain.handle('projects:updateAgentPolicy', async (_, projectId: unknown, policy: unknown) => {
    const state = ctx.getState();
    const project = updateProjectAgentPolicy(
      state,
      validateIpcInput(projectIdSchema, projectId, 'projects:updateAgentPolicy(projectId)'),
      validateIpcInput(updateProjectAgentPolicySchema, policy, 'projects:updateAgentPolicy(policy)')
    );
    await ctx.setState({ ...state });
    return project;
  });

  ipcMain.handle('projects:updateSessionRuntime', async (_, projectId: unknown, sessionId: unknown, runtime: unknown) => {
    const state = ctx.getState();
    const project = updateProjectSessionRuntime(
      state,
      validateIpcInput(projectIdSchema, projectId, 'projects:updateSessionRuntime(projectId)'),
      validateIpcInput(projectIdSchema, sessionId, 'projects:updateSessionRuntime(sessionId)'),
      validateIpcInput(updateSessionRuntimeSchema, runtime, 'projects:updateSessionRuntime(runtime)')
    );
    await ctx.setState({ ...state });
    return project;
  });

  ipcMain.handle('projects:sendPrompt', async (_, projectId: unknown, message: unknown) => {
    const state = ctx.getState();
    const project = await updateProjectWithPrompt(
      state,
      validateIpcInput(projectIdSchema, projectId, 'projects:sendPrompt(projectId)'),
      validateIpcInput(promptSchema, message, 'projects:sendPrompt(message)')
    );
    await ctx.setState({ ...state });
    return project;
  });

  ipcMain.handle('projects:startPromptStream', async (_, projectId: unknown, message: unknown, sessionId: unknown, attachments: unknown) => {
    const validatedProjectId = validateIpcInput(projectIdSchema, projectId, 'projects:startPromptStream(projectId)');
    const validatedMessage = validateIpcInput(promptSchema, message, 'projects:startPromptStream(message)');
    const validatedSessionId = validateIpcInput(projectIdSchema.optional(), sessionId, 'projects:startPromptStream(sessionId)');
    const validatedAttachments = validateIpcInput(promptAttachmentsSchema, attachments, 'projects:startPromptStream(attachments)');
    return startChatPromptStream({
      getState: ctx.getState,
      persistState: ctx.setState,
      projectId: validatedProjectId,
      sessionId: validatedSessionId,
      message: validatedMessage,
      attachments: validatedAttachments,
      dispatchEvent: ctx.dispatchPromptStreamEvent
    });
  });

  ipcMain.handle('projects:cancelPromptStream', async (_, streamId: unknown) => {
    const validatedStreamId = validateIpcInput(projectIdSchema, streamId, 'projects:cancelPromptStream(streamId)');
    cancelAgentExecutionPlanStream(validatedStreamId);
    return cancelChatPromptStream(validatedStreamId);
  });

  ipcMain.handle('projects:respondPromptPermission', async (_, requestId: unknown, decision: unknown) => {
    return respondToAgentPermissionRequest(
      validateIpcInput(projectIdSchema, requestId, 'projects:respondPromptPermission(requestId)'),
      validateIpcInput(z.enum(['allow', 'allow_session', 'deny']), decision, 'projects:respondPromptPermission(decision)'),
      ctx.dispatchPromptStreamEvent
    );
  });

  ipcMain.handle('projects:respondPromptUserInput', async (_, requestId: unknown, response: unknown) => {
    return respondToAgentUserInputRequest(
      validateIpcInput(projectIdSchema, requestId, 'projects:respondPromptUserInput(requestId)'),
      validateIpcInput(agentUserInputResponseSchema, response, 'projects:respondPromptUserInput(response)')
    );
  });

  ipcMain.handle('projects:createSnapshot', async (_, projectId: unknown, note: unknown) => {
    const state = ctx.getState();
    const project = addProjectSnapshot(
      state,
      validateIpcInput(projectIdSchema, projectId, 'projects:createSnapshot(projectId)'),
      validateIpcInput(noteSchema, note, 'projects:createSnapshot(note)')
    );
    await ctx.setState({ ...state });
    return project;
  });

  ipcMain.handle('projects:previewSessionCheckpoint', async (_, projectId: unknown, snapshotId: unknown) => {
    return previewSessionCheckpoint(
      ctx.getState(),
      validateIpcInput(projectIdSchema, projectId, 'projects:previewSessionCheckpoint(projectId)'),
      validateIpcInput(projectIdSchema, snapshotId, 'projects:previewSessionCheckpoint(snapshotId)')
    );
  });

  ipcMain.handle('projects:restoreSessionCheckpoint', async (_, projectId: unknown, snapshotId: unknown) => {
    const state = ctx.getState();
    const project = await restoreSessionCheckpoint(
      state,
      validateIpcInput(projectIdSchema, projectId, 'projects:restoreSessionCheckpoint(projectId)'),
      validateIpcInput(projectIdSchema, snapshotId, 'projects:restoreSessionCheckpoint(snapshotId)')
    );
    await ctx.setState({ ...state });
    return project;
  });

  ipcMain.handle('projects:updateMcpConfig', async (_, projectId: unknown, kind: unknown, pluginId: unknown) => {
    const state = ctx.getState();
    const project = updateProjectMcpConfig(
      state,
      validateIpcInput(projectIdSchema, projectId, 'projects:updateMcpConfig(projectId)'),
      validateIpcInput(mcpBindingKindSchema, kind, 'projects:updateMcpConfig(kind)'),
      validateIpcInput(pluginIdSchema.or(z.literal('')), pluginId, 'projects:updateMcpConfig(pluginId)')
    );
    await ctx.setState({ ...state });
    return project;
  });

  ipcMain.handle('projects:updateMcpServers', async (_, projectId: unknown, pluginIds: unknown) => {
    const state = ctx.getState();
    const project = updateProjectMcpServerConfig(
      state,
      validateIpcInput(projectIdSchema, projectId, 'projects:updateMcpServers(projectId)'),
      validateIpcInput(z.array(pluginIdSchema), pluginIds, 'projects:updateMcpServers(pluginIds)')
    );
    await ctx.setState({ ...state });
    return project;
  });

  ipcMain.handle('projects:executePlan', async (_, projectId: unknown) => {
    const state = ctx.getState();
    const project = await executeAgentExecutionPlan(state, validateIpcInput(projectIdSchema, projectId, 'projects:executePlan'));
    await ctx.setState({ ...state });
    return project;
  });

  ipcMain.handle('projects:startExecutePlanStream', async (_, projectId: unknown) => {
    return startAgentExecutionPlanStream({
      getState: ctx.getState,
      persistState: ctx.setState,
      projectId: validateIpcInput(projectIdSchema, projectId, 'projects:startExecutePlanStream(projectId)'),
      dispatchEvent: ctx.dispatchPromptStreamEvent
    });
  });
}
