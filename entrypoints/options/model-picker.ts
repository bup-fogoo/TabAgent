import { listModels, isAITransXConnection, type CatalogConnection, type CatalogModel } from '@/lib/model-catalog';
import { createIcon } from '@/lib/icons';
import type { Provider } from '@/lib/settings';

/** One picker shared by both protocols. Results live only while the dialog is open. */
export function createModelPicker(options: {
  connection(provider: Provider): CatalogConnection;
  currentModel(provider: Provider): string;
  select(provider: Provider, model: string): void;
}) {
  const dialog = document.getElementById('model-picker') as HTMLDialogElement;
  const search = document.getElementById('model-search') as HTMLInputElement;
  const vendor = document.getElementById('model-vendor') as HTMLSelectElement;
  const supplier = document.getElementById('model-supplier') as HTMLSelectElement;
  const supplierField = document.getElementById('model-supplier-field')!;
  const list = document.getElementById('model-list')!;
  const status = document.getElementById('model-status')!;
  const apply = document.getElementById('model-apply') as HTMLButtonElement;
  const refresh = document.getElementById('model-refresh') as HTMLButtonElement;
  const count = document.getElementById('model-count')!;
  let controller: AbortController | undefined;
  let version = 0;
  let provider: Provider = 'openai';
  let connection: CatalogConnection;
  let aitransx = false;
  let models: CatalogModel[] = [];
  let selected: CatalogModel | undefined;
  let chosenId = '';
  let currentId = '';

  function resetRequest() {
    version++;
    controller?.abort();
    controller = undefined;
    models = [];
    selected = undefined;
    chosenId = '';
    list.replaceChildren();
    apply.disabled = true;
    supplier.replaceChildren();
    supplier.disabled = true;
    supplierField.hidden = true;
    count.textContent = '';
  }

  function renderSelection() {
    supplier.replaceChildren();
    supplierField.hidden = !aitransx || !selected;
    if (selected) {
      const automatic = new Option(aitransx ? selected.id.includes('@') ? '当前供应商' : '平台自动选择' : '默认', selected.id);
      supplier.add(automatic);
      for (const route of selected.routes ?? []) supplier.add(new Option(route.name, route.modelId));
      if (![...supplier.options].some((option) => option.value === chosenId)) chosenId = selected.id;
      supplier.value = chosenId;
    }
    supplier.disabled = !selected || supplier.options.length < 2;
    apply.disabled = !selected || selected.tools === false;
    for (const button of list.querySelectorAll<HTMLButtonElement>('[data-model-id]')) {
      const active = button.dataset.modelId === selected?.id;
      button.setAttribute('aria-pressed', String(active));
      button.tabIndex = -1;
    }
    const focusTarget = list.querySelector<HTMLButtonElement>('button[aria-pressed="true"]:not(:disabled)')
      ?? list.querySelector<HTMLButtonElement>('button:not(:disabled)');
    if (focusTarget) focusTarget.tabIndex = 0;
  }

  function renderList() {
    list.replaceChildren();
    const term = search.value.trim().toLocaleLowerCase();
    const filtered = models.filter((model) => (!vendor.value || model.vendor === vendor.value)
      && [model.id, model.name, model.vendor, ...(model.routes ?? []).map((route) => `${route.name} ${route.modelId}`)].join(' ').toLocaleLowerCase().includes(term));
    if (selected && !filtered.includes(selected)) { selected = undefined; chosenId = ''; }
    count.textContent = models.length ? `${filtered.length} / ${models.length} 个模型` : '';
    for (const model of filtered) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'model-option';
      button.dataset.modelId = model.id;
      button.disabled = model.tools === false;
      const copy = document.createElement('span');
      copy.className = 'model-option-copy';
      const name = document.createElement('strong'); name.textContent = model.name;
      const detail = document.createElement('small'); detail.textContent = model.id;
      copy.append(name);
      if (model.name !== model.id) copy.append(detail);
      const tags = [model.vendor, model.tools === false ? '不支持工具调用' : model.tools === true ? '工具调用' : '',
        model.vision === true ? '图片输入' : '', model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K 上下文` : '',
        model.routes?.length ? `${model.routes.length} 个供应商` : ''].filter(Boolean);
      if (tags.length) { const meta = document.createElement('small'); meta.textContent = tags.join(' · '); copy.append(meta); }
      button.append(copy, createIcon('check', 'model-selected-mark'));
      button.addEventListener('click', () => {
        if (selected?.id !== model.id) chosenId = model.id;
        selected = model;
        renderSelection();
      });
      list.append(button);
    }
    if (!filtered.length && models.length) {
      const empty = document.createElement('p'); empty.className = 'model-empty'; empty.textContent = '没有匹配的模型'; list.append(empty);
    }
    renderSelection();
  }

  async function fetchModels() {
    const pendingId = chosenId || currentId;
    resetRequest();
    const ticket = version;
    const abort = new AbortController();
    controller = abort;
    refresh.disabled = true;
    status.dataset.state = 'loading';
    status.textContent = '正在获取模型…';
    list.setAttribute('aria-busy', 'true');
    vendor.replaceChildren(new Option('全部来源', ''));
    try {
      const result = await listModels(connection, abort.signal);
      if (ticket !== version || !dialog.open) return;
      models = result;
      for (const source of [...new Set(models.map((model) => model.vendor).filter((value): value is string => Boolean(value)))].sort()) vendor.add(new Option(source, source));
      selected = models.find((model) => model.id === pendingId || model.routes?.some((route) => route.modelId === pendingId));
      chosenId = selected ? pendingId : '';
      if (selected) models = [selected, ...models.filter((model) => model !== selected)];
      status.dataset.state = 'ready';
      status.textContent = !models.length ? '没有可列出的聊天模型，可关闭后手动填写。'
        : aitransx ? '公开目录；账号权限与工具调用请用“测试连接”确认。' : '工具调用能力以测试连接结果为准。';
      renderList();
    } catch (error) {
      if (ticket !== version || !dialog.open || abort.signal.aborted) return;
      status.dataset.state = 'error';
      status.textContent = error instanceof Error ? error.message : '获取模型失败，请重试或手动填写。';
    } finally {
      if (ticket === version) {
        controller = undefined;
        refresh.disabled = false;
        list.setAttribute('aria-busy', 'false');
      }
    }
  }

  function close() { if (dialog.open) dialog.close(); resetRequest(); }
  document.getElementById('model-close')!.addEventListener('click', close);
  dialog.addEventListener('cancel', () => resetRequest());
  dialog.addEventListener('close', () => { if (!dialog.open) resetRequest(); });
  refresh.addEventListener('click', () => void fetchModels());
  search.addEventListener('input', renderList);
  vendor.addEventListener('change', renderList);
  supplier.addEventListener('change', () => { chosenId = supplier.value; });
  apply.addEventListener('click', () => {
    if (!selected || selected.tools === false || !chosenId) return;
    const model = chosenId;
    close();
    options.select(provider, model);
  });
  // Enter in search navigates results instead of accidentally submitting settings.
  search.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      event.preventDefault(); list.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }
  });
  list.addEventListener('focusin', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLButtonElement) || target.disabled) return;
    for (const button of list.querySelectorAll<HTMLButtonElement>('button')) button.tabIndex = button === target ? 0 : -1;
  });
  list.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (!buttons.length) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
    if (buttons[next]) {
      for (const button of buttons) button.tabIndex = -1;
      buttons[next].tabIndex = 0;
      buttons[next].focus();
    }
  });
  window.addEventListener('pagehide', close);
  return {
    close,
    open(next: Provider) {
      close();
      provider = next;
      connection = options.connection(provider);
      aitransx = isAITransXConnection(connection);
      currentId = options.currentModel(provider);
      search.value = '';
      document.getElementById('model-picker-title')!.textContent = aitransx ? '选择 AITransX 模型' : '选择模型';
      dialog.showModal();
      search.focus();
      void fetchModels();
    },
  };
}
