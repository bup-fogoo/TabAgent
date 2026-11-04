import type { AgentEvent, ConversationState } from './protocol';
import { validReference } from './references';

export const isExportEvent = (event: AgentEvent) => ['user', 'assistant', 'tool', 'tool_result', 'error', 'notice', 'sources'].includes(event.type);
export function serializeConversation(id: string, title: string, state: ConversationState, events: AgentEvent[], format: 'markdown' | 'json') {
  const saved = events.filter(isExportEvent);
  if (format === 'json') return JSON.stringify({ version: 1, id, title, state, exportedAt: new Date().toISOString(), events: saved }, null, 2);
  const lines = [`# ${title.replace(/[\r\n]/g, ' ')}`, '', '由 TabAgent 导出。网页信息与操作记录仅代表当时状态。', ''];
  for (const event of saved) {
    if (event.type === 'user' || event.type === 'assistant') {
      lines.push(`## ${event.type === 'user' ? '你' : 'TabAgent'}${event.type === 'assistant' && event.interrupted ? '（回复未完成）' : ''}`, '', event.text, '');
    } else if (event.type === 'sources') {
      lines.push('### 参考页面', '');
      for (const page of event.pages.filter(validReference)) {
        const title = page.title.replace(/[\r\n]/g, ' ').replace(/[\\[\]]/g, '\\$&');
        const url = page.url.replace(/[<>\r\n]/g, (value) => encodeURIComponent(value));
        lines.push(`- [${title}](<${url}>)${page.kind === 'search' ? '（搜索页）' : ''}`);
      }
      lines.push('');
    } else if (event.type === 'tool') lines.push(`### 操作：${event.name}`, '', '```json', JSON.stringify(event.input, null, 2), '```', '');
    else if (event.type === 'tool_result') lines.push(`**${event.ok ? '完成' : '未完成'}**：${event.summary}`, '');
    else if (event.type === 'error' || event.type === 'notice') lines.push(`> ${event.message.replace(/\n/g, '\n> ')}`, '');
  }
  return lines.join('\n');
}
