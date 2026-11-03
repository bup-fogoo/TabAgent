import { browser } from 'wxt/browser';
import { CONTENT_MESSAGE_TAG, type ContentRequest, type ContentResponse } from '@/lib/protocol';

export interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const tabId = { type: 'integer', description: '目标标签页 id；省略则使用当前工作标签页' };
const elementId = { type: 'integer', description: 'read_page 返回的元素编号，如 [12] 中的 12' };

export const TOOLS: ToolDef[] = [
  {
    name: 'list_tabs',
    description: '列出当前浏览器所有标签页（id、标题、网址、是否为当前工作标签页）。需要跨标签页工作时先调用它。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'read_page',
    description:
      '读取标签页内容：返回网址、标题、带编号的可交互元素列表（[编号] <类型> "文字"），以及页面正文。操作元素前必须先调用它获取编号；页面变化后需重新读取。只需要文字时把 text_only 设为 true 以节省篇幅。',
    input_schema: {
      type: 'object',
      properties: {
        tab_id: tabId,
        text_only: { type: 'boolean', description: '只返回正文，不列元素' },
        max_text_chars: { type: 'integer', description: '正文最多返回多少字，默认 6000' },
      },
    },
  },
  {
    name: 'click',
    description: '点击一个元素（按钮、链接、复选框、标签等）。',
    input_schema: { type: 'object', properties: { element_id: elementId, tab_id: tabId }, required: ['element_id'] },
  },
  {
    name: 'type_text',
    description: '在输入框、文本域或可编辑区域输入文字。默认先清空原内容。submit=true 时输入后按回车提交。',
    input_schema: {
      type: 'object',
      properties: {
        element_id: elementId,
        text: { type: 'string' },
        clear: { type: 'boolean', description: '是否先清空，默认 true' },
        submit: { type: 'boolean', description: '输入后是否按回车提交，默认 false' },
        tab_id: tabId,
      },
      required: ['element_id', 'text'],
    },
  },
  {
    name: 'select_option',
    description: '在原生 <select> 下拉框中选择一个选项（按显示文字或 value）。',
    input_schema: {
      type: 'object',
      properties: { element_id: elementId, option: { type: 'string' }, tab_id: tabId },
      required: ['element_id', 'option'],
    },
  },
  {
    name: 'hover',
    description: '把鼠标悬停在元素上（用于展开悬停菜单）。',
    input_schema: { type: 'object', properties: { element_id: elementId, tab_id: tabId }, required: ['element_id'] },
  },
  {
    name: 'press_key',
    description: '按下一个键，如 Enter、Escape、Tab、ArrowDown。可指定元素，否则作用于当前焦点。',
    input_schema: {
      type: 'object',
      properties: { key: { type: 'string' }, element_id: elementId, tab_id: tabId },
      required: ['key'],
    },
  },
  {
    name: 'scroll',
    description: '滚动页面（上/下一屏、到顶部/底部），或滚动到某个元素。用于加载更多内容或查看屏幕外元素。',
    input_schema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'top', 'bottom'] },
        element_id: elementId,
        tab_id: tabId,
      },
      required: ['direction'],
    },
  },
  {
    name: 'extract',
    description:
      '用 CSS 选择器精确提取页面数据，返回每个匹配元素的文字（表格会转为制表符分隔的行），或指定属性（如 href、src）。适合批量抓取列表、表格。',
    input_schema: {
      type: 'object',
      properties: {
        selector: { type: 'string' },
        attribute: { type: 'string', description: '提取的属性名；省略则提取文字' },
        limit: { type: 'integer', description: '最多返回多少个，默认 50' },
        tab_id: tabId,
      },
      required: ['selector'],
    },
  },
  {
    name: 'navigate',
    description: '在标签页中打开网址并等待加载完成。',
    input_schema: { type: 'object', properties: { url: { type: 'string' }, tab_id: tabId }, required: ['url'] },
  },
  {
    name: 'go_back',
    description: '后退到上一页。',
    input_schema: { type: 'object', properties: { tab_id: tabId } },
  },
  {
    name: 'open_tab',
    description: '新建标签页打开网址，并把它设为当前工作标签页。',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string' }, background: { type: 'boolean', description: '是否在后台打开，默认 false' } },
      required: ['url'],
    },
  },
  {
    name: 'switch_tab',
    description: '切换到指定标签页，并把它设为当前工作标签页。',
    input_schema: { type: 'object', properties: { tab_id: { type: 'integer' } }, required: ['tab_id'] },
  },
  {
    name: 'close_tab',
    description: '关闭指定标签页。只关闭你自己打开的标签页，除非用户要求。',
    input_schema: { type: 'object', properties: { tab_id: { type: 'integer' } }, required: ['tab_id'] },
  },
  {
    name: 'wait',
    description: '等待若干秒（最多 10 秒），用于等待页面异步加载。',
    input_schema: { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] },
  },
];

// ---------- 执行 ----------

/** 智能体当前操作的标签页，随 open_tab / switch_tab 改变 */
export class BrowserContext {
  constructor(public currentTabId: number) {}

  static async fromActiveTab(): Promise<BrowserContext> {
    // 侧边栏可能是独立窗口（如 Safari 回退方案），所以取最近聚焦的普通窗口的活动标签页
    let tabs = await browser.tabs.query({ active: true, lastFocusedWindow: true, windowType: 'normal' });
    if (!tabs.length) tabs = await browser.tabs.query({ active: true, windowType: 'normal' });
    const id = tabs[0]?.id;
    if (id === undefined) throw new Error('找不到可操作的标签页');
    return new BrowserContext(id);
  }

  async execute(name: string, input: Record<string, any>, signal: AbortSignal): Promise<string> {
    const tab = (input.tab_id as number | undefined) ?? this.currentTabId;
    switch (name) {
      case 'list_tabs': {
        const tabs = await browser.tabs.query({});
        return tabs
          .map((t) => `${t.id === this.currentTabId ? '* ' : '  '}[tab ${t.id}] ${t.title ?? ''} — ${t.url ?? ''}`)
          .join('\n') + '\n（* 为当前工作标签页）';
      }
      case 'read_page': {
        const snap = (await this.content(tab, {
          action: 'snapshot',
          textOnly: input.text_only,
          maxTextChars: input.max_text_chars,
        })) as { url: string; title: string; scroll: string; elements?: string; text: string };
        return [
          `标签页 ${tab}：${snap.title}`,
          `网址：${snap.url}`,
          `滚动位置：${snap.scroll}`,
          snap.elements !== undefined ? `\n## 可交互元素\n${snap.elements || '（无）'}` : '',
          `\n## 页面正文\n${snap.text || '（空）'}`,
        ].join('\n');
      }
      case 'click': {
        const before = await this.urlOf(tab);
        const result = await this.content(tab, { action: 'click', id: input.element_id });
        return result + (await this.settle(tab, before, signal));
      }
      case 'type_text': {
        const before = await this.urlOf(tab);
        const result = await this.content(tab, {
          action: 'type',
          id: input.element_id,
          text: input.text,
          clear: input.clear,
          submit: input.submit,
        });
        return result + (input.submit ? await this.settle(tab, before, signal) : '');
      }
      case 'select_option':
        return String(await this.content(tab, { action: 'select', id: input.element_id, option: input.option }));
      case 'hover':
        return String(await this.content(tab, { action: 'hover', id: input.element_id }));
      case 'press_key': {
        const before = await this.urlOf(tab);
        const result = await this.content(tab, { action: 'press_key', key: input.key, id: input.element_id });
        return result + (await this.settle(tab, before, signal));
      }
      case 'scroll':
        return String(await this.content(tab, { action: 'scroll', direction: input.direction, id: input.element_id }));
      case 'extract': {
        const items = (await this.content(tab, {
          action: 'extract',
          selector: input.selector,
          attribute: input.attribute,
          limit: input.limit,
        })) as string[];
        return items.map((s, i) => `${i + 1}. ${s}`).join('\n');
      }
      case 'navigate':
        await browser.tabs.update(tab, { url: normalizeUrl(input.url) });
        await waitForLoad(tab, signal);
        return `已打开 ${await this.urlOf(tab)}`;
      case 'go_back':
        await browser.tabs.goBack(tab);
        await waitForLoad(tab, signal);
        return `已后退到 ${await this.urlOf(tab)}`;
      case 'open_tab': {
        const created = await browser.tabs.create({ url: normalizeUrl(input.url), active: !input.background });
        if (created.id === undefined) throw new Error('新建标签页失败');
        this.currentTabId = created.id;
        await waitForLoad(created.id, signal);
        return `已新建标签页 ${created.id}：${await this.urlOf(created.id)}（已设为当前工作标签页）`;
      }
      case 'switch_tab': {
        const t = await browser.tabs.update(input.tab_id, { active: true });
        if (t?.windowId !== undefined) await browser.windows.update(t.windowId, { focused: true });
        this.currentTabId = input.tab_id;
        return `已切换到标签页 ${input.tab_id}：${t?.title ?? ''}`;
      }
      case 'close_tab':
        await browser.tabs.remove(input.tab_id);
        if (input.tab_id === this.currentTabId) {
          this.currentTabId = (await BrowserContext.fromActiveTab()).currentTabId;
        }
        return `已关闭标签页 ${input.tab_id}，当前工作标签页为 ${this.currentTabId}`;
      case 'wait': {
        const ms = Math.min(Math.max(Number(input.seconds) || 1, 0), 10) * 1000;
        await sleep(ms, signal);
        return `已等待 ${ms / 1000} 秒`;
      }
      default:
        throw new Error(`未知工具 ${name}`);
    }
  }

  private async urlOf(tab: number) {
    return (await browser.tabs.get(tab)).url ?? '';
  }

  /** 操作后稍等片刻；若触发了跳转则等待新页面加载完 */
  private async settle(tab: number, beforeUrl: string, signal: AbortSignal): Promise<string> {
    await sleep(400, signal);
    const t = await browser.tabs.get(tab);
    if (t.status === 'loading' || t.url !== beforeUrl) {
      await waitForLoad(tab, signal);
      return `\n页面已跳转到 ${await this.urlOf(tab)}`;
    }
    return '';
  }

  private async content(tab: number, request: ContentRequest): Promise<unknown> {
    await ensureContentScript(tab);
    const res = (await browser.tabs.sendMessage(tab, { tag: CONTENT_MESSAGE_TAG, request })) as
      | ContentResponse
      | undefined;
    if (!res) throw new Error('页面没有响应');
    if (!res.ok) throw new Error(res.error);
    return res.result;
  }
}

async function ensureContentScript(tab: number) {
  try {
    const res = await browser.tabs.sendMessage(tab, { tag: CONTENT_MESSAGE_TAG, request: { action: 'ping' } });
    if (res) return;
  } catch {
    // 安装插件前就打开的页面没有内容脚本，下面补注入
  }
  try {
    await browser.scripting.executeScript({ target: { tabId: tab }, files: ['/content-scripts/content.js'] });
  } catch (err) {
    const url = (await browser.tabs.get(tab)).url ?? '';
    throw new Error(
      `无法在此页面上操作（${url || '未知页面'}）。浏览器禁止插件操作内部页面（如 chrome://、扩展商店、新标签页）。${
        err instanceof Error ? err.message : ''
      }`,
    );
  }
}

export function waitForLoad(tab: number, signal: AbortSignal, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      // 给前端框架一点渲染时间
      setTimeout(resolve, 300);
    };
    const listener = (id: number, info: { status?: string }) => {
      if (id === tab && info.status === 'complete') finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    signal.addEventListener('abort', finish, { once: true });
    browser.tabs.onUpdated.addListener(listener);
    // 稍等再检查，避免刚发起跳转时读到上一页的“已完成”状态
    setTimeout(() => {
      browser.tabs.get(tab).then(
        (t) => t.status === 'complete' && finish(),
        () => finish(),
      );
    }, 250);
  });
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}

function normalizeUrl(url: string) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;
}
