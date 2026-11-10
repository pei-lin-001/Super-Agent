/**
 * pi 的 openai-completions 适配器强制流式（stream: true），
 * 所以测试里的假服务端必须回 SSE。普通 JSON 会被当成"流提前结束"。
 */

export interface SseToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** 一段文本回复。 */
export function sseText(content: string, usage = { prompt: 1, completion: 1 }): string {
  return (
    `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n` +
    `data: ${JSON.stringify({
      id: 'x',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: usage.prompt, completion_tokens: usage.completion },
    })}\n\n` +
    'data: [DONE]\n\n'
  );
}

/** 一组工具调用（参数走增量，和真实提供方一致）。 */
export function sseTools(calls: SseToolCall[], reasoning?: string): string {
  let out = '';
  if (reasoning) {
    out += `data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }] })}\n\n`;
  }
  calls.forEach((call, index) => {
    out += `data: ${JSON.stringify({
      id: 'x',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } },
            ],
          },
          finish_reason: null,
        },
      ],
    })}\n\n`;
    out += `data: ${JSON.stringify({
      id: 'x',
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index, function: { arguments: JSON.stringify(call.args) } }] },
          finish_reason: null,
        },
      ],
    })}\n\n`;
  });
  out += `data: ${JSON.stringify({
    id: 'x',
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  })}\n\n`;
  out += 'data: [DONE]\n\n';
  return out;
}

/** 发送 SSE 响应。 */
export function sendSse(res: { writeHead: (status: number, headers: Record<string, string>) => void; end: (body: string) => void }, body: string): void {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(body);
}
