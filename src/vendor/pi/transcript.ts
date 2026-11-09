/**
 * 移植自 pi @earendil-works/pi-coding-agent@1.5.0
 * 原文件：packages/ai/dist/utils/transcript.js
 *
 * 只保留本仓库用到的函数；逻辑逐行保留。上游改动时需要重新对照。
 */
import type { AgentMessage, Message, SystemMessage, ToolDeclaration } from './types.ts';

/** 把文本内容块拼成字符串。 */
export function contentText(content: string | { type: string; text?: string }[], separator = '\n'): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join(separator);
}

/** 系统消息渲染成完整提示：正文 + 命名段落。 */
export function getSystemMessageText(message: SystemMessage): string {
  const parts: string[] = [contentText(message.content)];
  for (const text of Object.values(message.sections ?? {})) {
    if (text !== null) parts.push(text);
  }
  return parts.filter((part) => part.length > 0).join('\n\n');
}

function isSystemMessage(message: AgentMessage): message is SystemMessage {
  return message.role === 'system';
}

/**
 * 把 `systemPrompt` + `tools` 折进一条前置 system 消息。
 * 这是产出 TranscriptContext 的唯一入口。
 */
export function normalizeContext(context: {
  systemPrompt?: string;
  tools?: ToolDeclaration[];
  messages: AgentMessage[];
}): { messages: Message[] } {
  const hasSystemPrompt = context.systemPrompt !== undefined && context.systemPrompt.length > 0;
  const hasTools = context.tools !== undefined && context.tools.length > 0;
  const initial: SystemMessage | undefined =
    !hasSystemPrompt && !hasTools
      ? undefined
      : {
          role: 'system',
          content: context.systemPrompt ?? '',
          ...(hasTools ? { toolsAdded: context.tools } : {}),
          timestamp: 0,
        };
  const messages = initial ? [initial, ...context.messages] : context.messages;
  return { messages: messages as Message[] };
}

/** 依次应用 transcript 里的工具变更，得到当前可用工具。 */
export function getCurrentTools(messages: AgentMessage[]): ToolDeclaration[] {
  const tools = new Map<string, ToolDeclaration>();
  for (const message of messages) {
    if (!isSystemMessage(message)) continue;
    for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
    for (const tool of message.toolsAdded ?? []) tools.set(tool.name, tool);
  }
  return [...tools.values()];
}

/** 去掉执行期字段，只留模型可见的声明。 */
export function toToolDeclaration(tool: ToolDeclaration): ToolDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parameters: JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>,
  };
}

/** 两个工具声明是否等价（键顺序也一致，直接比序列化结果）。 */
export function declarationsEqual(left: ToolDeclaration, right: ToolDeclaration): boolean {
  return JSON.stringify(toToolDeclaration(left)) === JSON.stringify(toToolDeclaration(right));
}

/** 比较两份工具状态：定义变化记作「先移除再添加」。 */
export function getToolStateChanges(
  previous: ToolDeclaration[],
  current: ToolDeclaration[],
): { toolsAdded: ToolDeclaration[]; toolsRemoved: { name: string }[] } {
  const previousTools = new Map(previous.map((tool) => [tool.name, tool]));
  const currentTools = new Map(current.map((tool) => [tool.name, tool]));
  return {
    toolsAdded: current
      .filter((tool) => {
        const previousTool = previousTools.get(tool.name);
        return previousTool === undefined || !declarationsEqual(previousTool, tool);
      })
      .map(toToolDeclaration),
    toolsRemoved: previous
      .filter((tool) => {
        const currentTool = currentTools.get(tool.name);
        return currentTool === undefined || !declarationsEqual(tool, currentTool);
      })
      .map((tool) => ({ name: tool.name })),
  };
}
