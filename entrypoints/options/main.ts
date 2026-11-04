import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '@/lib/settings';
import { asModelError, testModelConnection } from '@/lib/llm/diagnostics';
import { createIcon, mountIcons } from '@/lib/icons';

mountIcons();

const form = document.getElementById('form') as HTMLFormElement;
const saved = document.getElementById('saved')!;
const status = document.getElementById('form-status')!;
const error = document.getElementById('form-error')!;
const saveButton = document.getElementById('save-button') as HTMLButtonElement;
const discardButton = document.getElementById('discard-changes') as HTMLButtonElement;
const retryLoad = document.getElementById('retry-load') as HTMLButtonElement;
const testButton = document.getElementById('test-connection') as HTMLButtonElement;
const cancelTestButton = document.getElementById('cancel-test') as HTMLButtonElement;
const connectionResult = document.getElementById('connection-result')!;
const testElapsed = document.getElementById('test-elapsed')!;
let baseline = '';
let loaded = false;
let saving = false;
let testAbort: AbortController | null = null;
let testVersion = 0;
let testTimer: ReturnType<typeof setInterval> | undefined;

function syncTestControls() {
  testButton.disabled = !loaded || saving || testAbort !== null;
  testButton.querySelector('#test-label')!.textContent = testAbort ? '正在测试…' : '测试连接';
  testButton.querySelector('svg')!.replaceWith(createIcon(testAbort ? 'loader' : 'arrow-right', testAbort ? 'is-spinning' : ''));
  cancelTestButton.hidden = !testAbort;
  saveButton.disabled = saving || testAbort !== null || !isDirty();
  discardButton.disabled = !loaded || saving || !isDirty();
  document.querySelector('.save-bar')!.classList.toggle('has-changes', isDirty());
}

function reportTest(state: string, message: string) {
  connectionResult.dataset.state = state;
  connectionResult.replaceChildren();
  if (state === 'success' || state === 'testing') {
    connectionResult.append(createIcon(state === 'success' ? 'check' : 'loader', state === 'testing' ? 'is-spinning' : ''));
  }
  const text = document.createElement('span');
  text.textContent = message;
  connectionResult.append(text);
  connectionResult.hidden = false;
}

function invalidateTest() {
  if (connectionResult.hidden) return;
  testVersion++;
  testAbort?.abort();
  testAbort = null;
  clearInterval(testTimer);
  testElapsed.textContent = '';
  reportTest('stale', '配置已修改，请重新测试');
  syncTestControls();
}

function field(name: keyof Settings) {
  return form.elements.namedItem(name) as HTMLInputElement | HTMLSelectElement | RadioNodeList;
}

// Preserve disabled providers' values when switching between saved connections.
function readSettings(): Settings {
  const settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const input = field(key);
    const value = input instanceof HTMLInputElement && input.type === 'checkbox' ? input.checked : input.value.trim();
    (settings as unknown as Record<string, unknown>)[key] = key === 'maxSteps' ? Number(value) : value;
  }
  return settings;
}

function fillSettings(settings: Settings) {
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    const input = field(key);
    if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = settings[key] === true;
    else input.value = String(settings[key]);
  }
}

function resetVisionForConnection(target: EventTarget | null) {
  if (!(target instanceof HTMLInputElement)) return;
  if (target.name === 'anthropicModel' || target.name === 'anthropicBaseUrl') {
    (field('anthropicVision') as HTMLInputElement).checked = false;
  } else if (target.name === 'openaiModel' || target.name === 'openaiBaseUrl') {
    (field('openaiVision') as HTMLInputElement).checked = false;
  }
}

function isDirty() {
  return loaded && JSON.stringify(readSettings()) !== baseline;
}

function showProvider() {
  const provider = field('provider').value;
  form.querySelectorAll<HTMLFieldSetElement>('fieldset[data-provider]').forEach((section) => {
    section.hidden = section.dataset.provider !== provider;
    section.disabled = section.hidden || !loaded || saving;
    if (section.hidden) {
      section.querySelectorAll<HTMLInputElement>('input[data-revealed]').forEach(hideKey);
      section.querySelectorAll<HTMLInputElement>('input').forEach((input) => showFieldError(input, ''));
    }
  });
}

function showFieldError(input: HTMLInputElement, message: string) {
  const output = document.getElementById(`${input.id}-error`);
  input.setAttribute('aria-invalid', String(Boolean(message)));
  if (output) {
    output.textContent = message;
    output.hidden = !message;
  }
}

function focusInvalid(input: HTMLInputElement) {
  input.focus({ preventScroll: true });
  input.closest('.field')?.scrollIntoView({ block: 'center', behavior: 'auto' });
}

function validateInput(input: HTMLInputElement): string {
  if (input.matches(':disabled') || input.type === 'checkbox') return '';
  const value = input.value.trim();
  if (input.required && !value) {
    if (input.name === 'anthropicApiKey') return '请填写 Claude API Key。';
    if (input.name === 'maxSteps') return '请填写任务步数。';
    if (input.type === 'url') return '请填写模型服务的接口地址。';
    return '请填写模型名称。';
  }
  if (input.type === 'url' && value) {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) return '接口地址须以 https:// 或 http:// 开头。';
    } catch {
      return '请输入完整地址，例如 https://api.openai.com/v1。';
    }
  }
  if (input.name === 'maxSteps') {
    const steps = Number(value);
    if (!Number.isInteger(steps) || steps < 5 || steps > 200) return '请输入 5 到 200 之间的整数。';
  }
  return '';
}

function updateFeedback() {
  if (!loaded || saving) return;
  saved.hidden = true;
  error.hidden = true;
  status.hidden = false;
  status.textContent = isDirty() ? '未保存' : '已保存';
  syncTestControls();
}

function hideKey(input: HTMLInputElement) {
  input.type = 'password';
  delete input.dataset.revealed;
  const button = form.querySelector<HTMLButtonElement>(`[aria-controls="${input.id}"]`)!;
  button.replaceChildren(createIcon('eye'));
  button.title = '显示密钥';
  button.setAttribute('aria-pressed', 'false');
  button.setAttribute('aria-label', input.name === 'anthropicApiKey' ? '显示 Claude API Key' : '显示 OpenAI 兼容接口 API Key');
}

function setBusy(busy: boolean) {
  saving = busy;
  form.setAttribute('aria-busy', String(busy));
  form.querySelectorAll<HTMLFieldSetElement>('fieldset:not([data-provider])').forEach((section) => (section.disabled = busy));
  showProvider();
  saveButton.disabled = busy || !isDirty();
  saveButton.querySelector('#save-label')!.textContent = busy ? '保存中…' : '保存';
  saveButton.querySelector('svg')!.replaceWith(createIcon(busy ? 'loader' : 'save', busy ? 'is-spinning' : ''));
  syncTestControls();
}

async function init() {
  status.hidden = false;
  status.textContent = '读取中…';
  error.hidden = true;
  retryLoad.hidden = true;
  try {
    const settings = await loadSettings();
    fillSettings(settings);
    loaded = true;
    baseline = JSON.stringify(readSettings());
    setBusy(false);
    updateFeedback();
  } catch {
    form.setAttribute('aria-busy', 'false');
    status.hidden = true;
    error.textContent = '设置读取失败，请重试。';
    error.hidden = false;
    retryLoad.hidden = false;
  }
}

form.addEventListener('input', (event) => {
  const target = event.target;
  resetVisionForConnection(target);
  if (target instanceof HTMLInputElement && target.getAttribute('aria-invalid') === 'true') {
    showFieldError(target, validateInput(target));
  }
  updateFeedback();
  if (!(target instanceof HTMLInputElement) || target.name !== 'maxSteps') invalidateTest();
});

form.addEventListener('change', (event) => {
  resetVisionForConnection(event.target);
  showProvider();
  updateFeedback();
});

testButton.addEventListener('click', async () => {
  if (!loaded || saving || testAbort) return;
  let firstInvalid: HTMLInputElement | undefined;
  form.querySelectorAll<HTMLInputElement>('fieldset[data-provider]:not([hidden]) input').forEach((input) => {
    const message = validateInput(input);
    showFieldError(input, message);
    if (message && !firstInvalid) firstInvalid = input;
  });
  if (firstInvalid) {
    reportTest('error', '请检查标出的字段');
    focusInvalid(firstInvalid);
    return;
  }
  const controller = new AbortController();
  testAbort = controller;
  const version = ++testVersion;
  const settings = readSettings();
  const started = performance.now();
  reportTest('testing', '验证连接与工具调用…');
  syncTestControls();
  testTimer = setInterval(() => { testElapsed.textContent = `${Math.floor((performance.now() - started) / 1000)} 秒`; }, 1000);
  try {
    const result = await testModelConnection(settings, controller.signal);
    if (version !== testVersion) return;
    reportTest('success', `连接正常，支持工具调用 · ${(result.elapsedMs / 1000).toFixed(1)} 秒`);
  } catch (error) {
    if (version !== testVersion) return;
    const diagnostic = asModelError(error, controller.signal);
    reportTest(diagnostic.code === 'cancelled' ? 'cancelled' : 'error', diagnostic.message);
  } finally {
    if (version === testVersion) {
      testAbort = null;
      clearInterval(testTimer);
      testElapsed.textContent = '';
      syncTestControls();
    }
  }
});

cancelTestButton.addEventListener('click', () => testAbort?.abort());
window.addEventListener('pagehide', () => {
  testAbort?.abort();
  clearInterval(testTimer);
});

form.addEventListener('focusout', (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.type !== 'radio' && target.value.trim()) {
    showFieldError(target, validateInput(target));
  }
});

form.querySelectorAll<HTMLButtonElement>('.reveal-key').forEach((button) => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.getAttribute('aria-controls')!) as HTMLInputElement;
    if (input.type === 'text') {
      hideKey(input);
    } else {
      input.type = 'text';
      input.dataset.revealed = 'true';
      button.replaceChildren(createIcon('eye-off'));
      button.title = '隐藏密钥';
      button.setAttribute('aria-pressed', 'true');
      button.setAttribute('aria-label', input.name === 'anthropicApiKey' ? '隐藏 Claude API Key' : '隐藏 OpenAI 兼容接口 API Key');
    }
  });
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!loaded || saving || testAbort || !isDirty()) return;
  let firstInvalid: HTMLInputElement | undefined;
  form.querySelectorAll<HTMLInputElement>('input:not([type="radio"])').forEach((input) => {
    const message = validateInput(input);
    showFieldError(input, message);
    if (message && !firstInvalid) firstInvalid = input;
  });
  if (firstInvalid) {
    saved.hidden = true;
    status.hidden = true;
    error.textContent = '请检查标出的字段';
    error.hidden = false;
    focusInvalid(firstInvalid);
    return;
  }

  const settings = readSettings();
  error.hidden = true;
  saved.hidden = true;
  status.hidden = false;
  status.textContent = '保存中…';
  setBusy(true);
  try {
    await saveSettings(settings);
    baseline = JSON.stringify(settings);
    form.querySelectorAll<HTMLInputElement>('input[data-revealed]').forEach(hideKey);
    status.hidden = true;
    saved.hidden = false;
  } catch {
    status.hidden = true;
    error.textContent = '保存失败，请重试';
    error.hidden = false;
  } finally {
    setBusy(false);
  }
});

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    if (!saveButton.disabled) form.requestSubmit();
  }
});

window.addEventListener('beforeunload', (event) => {
  if (isDirty()) {
    event.preventDefault();
    event.returnValue = '';
  }
});

retryLoad.addEventListener('click', init);
discardButton.addEventListener('click', () => {
  if (!loaded || saving || !isDirty()) return;
  invalidateTest();
  const previous = JSON.parse(baseline) as Settings;
  fillSettings(previous);
  form.querySelectorAll<HTMLInputElement>('input[data-revealed]').forEach(hideKey);
  form.querySelectorAll<HTMLInputElement>('input').forEach((input) => showFieldError(input, ''));
  showProvider();
  updateFeedback();
  status.textContent = '已撤销更改';
  if (!connectionResult.hidden) reportTest('stale', '已恢复配置，可重新测试');
});
void init();
