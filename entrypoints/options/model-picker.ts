import { listModels, isAITransXConnection, type CatalogConnection, type CatalogModel } from '@/lib/model-catalog';
import { createIcon } from '@/lib/icons';
import type { Provider } from '@/lib/settings';
import { loadModelLibrary, setModelFavorite } from '@/lib/model-library';

/** One picker shared by both protocols. Results live only while the dialog is open. */
export function createModelPicker(options: {
  connection(provider: Provider): CatalogConnection;
  currentModel(provider: Provider): string;
  scope(provider: Provider): string;
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
  const favorite = document.getElementById('model-favorite') as HTMLButtonElement;
  let controller: AbortController | undefined;
  let version = 0;
  let provider: Provider = 'openai';
  let connection: CatalogConnection;
  let aitransx = false;
  let models: CatalogModel[] = [];
  let selected: CatalogModel | undefined;
  let chosenId = '';
  let currentId = '';
  let scope = '';
  let library = { favorites: [] as string[], recent: [] as string[] };
  let filter: 'all' | 'favorites' | 'recent' = 'all';
  let favoriteBusy = false;
  let favoriteOperation = 0;

  function resetRequest() {
    version++;
    favoriteOperation++;
    favoriteBusy = false;
    controller?.abort();
    controller = undefined;
    models = [];
    selected = undefined;
    chosenId = '';
    list.replaceChildren();
    apply.disabled = true;
    favorite.disabled = true;
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
    favorite.disabled = !selected || favoriteBusy;
    const pinned = library.favorites.includes(chosenId);
    favorite.setAttribute('aria-pressed', String(pinned));
    favorite.setAttribute('aria-label', pinned ? '取消收藏当前模型' : '收藏当前模型');
    favorite.title = pinned ? '取消收藏当前模型' : '收藏当前模型';
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
    const entries = filter === 'all' ? models : library[filter].map((id): CatalogModel => {
      const known = models.find((model) => model.id === id || model.routes?.some((route) => route.modelId === id));
      return { ...known, id, name: known?.id === id ? known.name : id, routes: undefined };
    });
    const filtered = entries.filter((model) => (!vendor.value || model.vendor === vendor.value)
      && [model.id, model.name, model.vendor, ...(model.routes ?? []).map((route) => `${route.name} ${route.modelId}`)].join(' ').toLocaleLowerCase().includes(term));
    if (selected) {
      selected = filtered.find((model) => model.id === chosenId || model.routes?.some((route) => route.modelId === chosenId));
      if (!selected) chosenId = '';
    }
    count.textContent = entries.length ? `${filtered.length} / ${entries.length} 个模型` : '';
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
    if (!filtered.length && (entries.length || filter !== 'all')) {
      const empty = document.createElement('p'); empty.className = 'model-empty';
      empty.textContent = entries.length ? '没有匹配的模型' : filter === 'favorites' ? '还没有收藏模型，选中模型后点击星标' : '保存或切换模型后会显示在这里'; list.append(empty);
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
    void loadModelLibrary(scope).then((stored) => {
      if (ticket !== version || !dialog.open) return;
      library = stored;
      if (filter !== 'all') renderList(); else renderSelection();
    }).catch(() => { if (ticket === version) status.textContent = '模型记录读取失败，仍可选择在线模型'; });
    try {
      const result = await listModels(connection, abort.signal);
      if (ticket !== version || !dialog.open) return;
      models = result;
      for (const source of [...new Set(models.map((model) => model.vendor).filter((value): value is string => Boolean(value)))].sort()) vendor.add(new Option(source, source));
      const preferred = chosenId || pendingId;
      selected = models.find((model) => model.id === preferred || model.routes?.some((route) => route.modelId === preferred))
        ?? (filter !== 'all' && library[filter].includes(preferred) ? { id: preferred, name: preferred } : undefined);
      chosenId = selected ? preferred : '';
      if (selected && models.includes(selected)) models = [selected, ...models.filter((model) => model !== selected)];
      status.dataset.state = 'ready';
      status.textContent = !models.length ? '没有可列出的聊天模型，可关闭后手动填写。'
        : aitransx ? '公开目录；账号权限与工具调用请用“测试连接”确认。' : '工具调用能力以测试连接结果为准。';
      renderList();
    } catch (error) {
      if (ticket !== version || !dialog.open || abort.signal.aborted) return;
      status.dataset.state = 'error';
      status.textContent = error instanceof Error ? error.message : '获取模型失败，请重试或手动填写。';
      if (filter !== 'all') renderList();
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
  supplier.addEventListener('change', () => { chosenId = supplier.value; renderSelection(); });
  for (const button of dialog.querySelectorAll<HTMLButtonElement>('[data-model-filter]')) {
    button.addEventListener('click', () => {
      filter = button.dataset.modelFilter as typeof filter;
      for (const tab of dialog.querySelectorAll('[data-model-filter]')) tab.setAttribute('aria-pressed', String(tab === button));
      vendor.value = ''; search.value = '';
      renderList();
    });
  }
  favorite.addEventListener('click', async () => {
    if (!chosenId || favoriteBusy) return;
    const ticket = version;
    const model = chosenId;
    const activeScope = scope;
    const operation = ++favoriteOperation;
    favoriteBusy = true; renderSelection();
    try {
      await setModelFavorite(activeScope, model, !library.favorites.includes(model));
      const stored = await loadModelLibrary(activeScope);
      if (ticket !== version || !dialog.open) return;
      library = stored;
      renderList();
    } catch (error) {
      if (ticket === version) { status.dataset.state = 'error'; status.textContent = error instanceof Error ? error.message : '收藏保存失败，请重试'; }
    } finally {
      if (operation === favoriteOperation) {
        favoriteBusy = false;
        if (ticket === version) renderSelection();
      }
    }
  });
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
      scope = options.scope(provider);
      library = { favorites: [], recent: [] };
      filter = 'all';
      for (const tab of dialog.querySelectorAll<HTMLElement>('[data-model-filter]')) tab.setAttribute('aria-pressed', String(tab.dataset.modelFilter === filter));
      search.value = '';
      document.getElementById('model-picker-title')!.textContent = aitransx ? '选择 AITransX 模型' : '选择模型';
      dialog.showModal();
      search.focus();
      void fetchModels();
    },
  };
}
