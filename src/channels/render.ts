/**
 * 聊天文本渲染。
 *
 * 模型输出的是 Markdown；直接把原文丢给平台，用户看到的就是一堆 `**` 和反引号。
 * 这里做两件事：Telegram 转成受控 HTML（只转白名单标签，其余一律转义），
 * 微信只保留纯文本（iLink 没有富文本消息）。
 *
 * 只做"能安全渲染"的转换：宁可少渲染，也不产生平台解析不了的实体。
 */

/** HTML 转义：先转义，再插标签，避免用户内容注入标签。 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Markdown → Telegram HTML。
 *
 * 支持：围栏代码块、行内代码、加粗、链接、标题。
 * 不支持斜体：单个 `*` 在自然语言里太常见，误判的代价比少一种样式大。
 */
export function toTelegramHtml(markdown: string): string {
  const escaped = escapeHtml(markdown);
  const blocks: string[] = [];
  // 先把围栏代码块摘出来，避免里面的内容被后续规则改写。
  const withoutFences = escaped.replace(/```([\w+-]*)\n?([\s\S]*?)```/g, (_match, _lang: string, code: string) => {
    const index = blocks.length;
    blocks.push(`<pre>${code.replace(/\n$/, '')}</pre>`);
    return `\u0000BLOCK${index}\u0000`;
  });

  const inlined = withoutFences
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');

  return inlined.replace(/\u0000BLOCK(\d+)\u0000/g, (_m, index: string) => blocks[Number(index)] ?? '');
}

/** Markdown → 纯文本：去掉标记符号，保留内容与换行。 */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/```[\w+-]*\n?([\s\S]*?)```/g, (_match, code: string) => code.trim())
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1（$2）')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
