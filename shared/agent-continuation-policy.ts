const AGENT_FILE_REFERENCE_PATTERN = /(?:^|[\s"'`（(：:])[\w@./\\-]+\.(?:html|css|js|jsx|ts|tsx|json|md|txt|yml|yaml|xml|svg|py|cs|java|go|rs|sh|sql|vue|svelte)(?:$|[\s"'`，,。.!！?？）)；;:：])/i;
const AGENT_UNFINISHED_WRITE_PATTERN = /(现在|接下来|继续|马上|下一步|最后|再来|还要|还需要|开始)(?:[\s\S]{0,40})(写|创建|生成|实现|补上)|(?:now|next|then|continue|will|going to)(?:[\s\S]{0,40})(write|create|implement|add)/i;
const AGENT_TODO_CONTINUATION_PATTERN = /还没|未完成|继续|马上|下一步|pending|in_progress|not done|continue|next/i;
const AGENT_LENGTH_FINISH_PATTERN = /^(length|max_tokens|max_output_tokens)$/i;

export interface AgentTodoContinuationItemSnapshot {
  id?: string;
  content: string;
  status: string;
  priority?: string;
}

export interface AgentTodoContinuationSnapshot {
  items: AgentTodoContinuationItemSnapshot[];
  incompleteItems: AgentTodoContinuationItemSnapshot[];
  hasInProgress: boolean;
}

export function containsAgentFileReference(value: string): boolean {
  return AGENT_FILE_REFERENCE_PATTERN.test(value);
}

export function looksLikeUnfinishedAgentWriteReply(value: string): boolean {
  const normalized = value.trim();
  if (!containsAgentFileReference(normalized)) {
    return false;
  }
  return AGENT_UNFINISHED_WRITE_PATTERN.test(normalized);
}

export function looksLikeAgentTodoContinuationReply(value: string): boolean {
  return AGENT_TODO_CONTINUATION_PATTERN.test(value);
}

export function isAgentLengthLimitedFinishReason(finishReason?: string): boolean {
  return AGENT_LENGTH_FINISH_PATTERN.test(finishReason?.trim() ?? '');
}

export function createAgentPartialWriteContinuationPrompt(assistantMessage: string): string {
  return [
    '你的上一条回复看起来还在执行多文件写入任务，而不是最终答复：',
    assistantMessage,
    '',
    '如果还有文件要创建或修改，请继续调用协议级工具（write_file、edit_file、multi_edit、patch_file 或 create_directory）完成剩余文件。',
    '不要只在正文里说“现在写/接下来写”；只有确认全部请求的文件都已经通过工具写入后，才能给最终答复。'
  ].join('\n');
}

export function createAgentIncompleteTodoContinuationPrompt(snapshot: AgentTodoContinuationSnapshot, assistantMessage: string): string {
  const incomplete = snapshot.incompleteItems.slice(0, 10).map((item, index) => {
    const id = item.id ?? String(index + 1);
    return `- [${item.status}] ${id}: ${item.content}`;
  });
  return [
    '你的上一轮工具状态显示任务清单还没有完成，但你已经结束了回复：',
    assistantMessage.trim() || '<empty assistant reply>',
    '',
    '未完成项：',
    ...incomplete,
    '',
    '请继续调用协议级工具完成这些 in_progress/pending 项，并在每个关键步骤后更新 update_todo_list。',
    '如果需要创建或修改文件，下一步必须调用 write_file、edit_file、multi_edit、patch_file 或 create_directory；不要在正文里输出完整源码来代替工具调用。',
    '只有全部必要项都完成后，才能给用户最终答复；如果确实需要用户选择或外部信息，请调用 ask_user。'
  ].join('\n');
}

export function createAgentLengthContinuationPrompt(assistantMessage: string): string {
  return [
    '上一轮模型输出因为长度限制被截断，任务不能在这里结束。',
    assistantMessage.trim() ? '继续上一轮未完成的位置，不要重复已经完成的说明。' : '上一轮没有返回可显示文本，请继续推进任务。',
    '如果仍有未完成改动，必须继续调用工具完成；只有确认任务完成后，才用简短最终回复收尾。'
  ].join('\n');
}
