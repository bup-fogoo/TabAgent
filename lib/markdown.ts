// 极简 Markdown 渲染：先整体转义 HTML，再处理段落、列表、表格、代码、粗体和链接，避免把网页内容当 HTML 执行。

function escape(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function inline(s: string) {
  return escape(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

export function renderMarkdown(src: string): string {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const L = (k: number) => lines[k] ?? '';
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = L(i);
    if (line.startsWith('```')) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !L(i).startsWith('```')) code.push(L(i++));
      i++;
      out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
    } else if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(L(i + 1))) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(L(i))) rows.push(cells(L(i++)));
      out.push(
        `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
    } else if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(L(i))) {
        items.push(`<li>${inline(L(i++).replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`);
      }
      out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
    } else if (/^#{1,6}\s/.test(line)) {
      out.push(`<p><strong>${inline(line.replace(/^#+\s*/, ''))}</strong></p>`);
      i++;
    } else if (!line.trim()) {
      i++;
    } else {
      const para: string[] = [];
      while (i < lines.length && L(i).trim() && !/^(```|\s*\||\s*([-*]|\d+\.)\s+|#{1,6}\s)/.test(L(i))) {
        para.push(inline(L(i++)));
      }
      if (!para.length) para.push(inline(L(i++)));
      out.push(`<p>${para.join('<br>')}</p>`);
    }
  }
  return out.join('');
}
