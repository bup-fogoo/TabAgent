import { DEFAULT_SETTINGS, loadSettings, saveSettings, type Settings } from '@/lib/settings';

const form = document.getElementById('form') as HTMLFormElement;
const saved = document.getElementById('saved')!;

function showProvider() {
  const provider = (form.elements.namedItem('provider') as RadioNodeList).value;
  form.querySelectorAll<HTMLFieldSetElement>('fieldset[data-provider]').forEach((f) => {
    f.hidden = f.dataset.provider !== provider;
  });
}

async function init() {
  const settings = await loadSettings();
  for (const [key, value] of Object.entries(settings)) {
    const field = form.elements.namedItem(key);
    if (field instanceof RadioNodeList) field.value = String(value);
    else if (field) (field as HTMLInputElement).value = String(value);
  }
  showProvider();
}

form.addEventListener('change', showProvider);
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = new FormData(form);
  const settings = { ...DEFAULT_SETTINGS } as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const value = String(data.get(key) ?? '').trim();
    settings[key] = typeof DEFAULT_SETTINGS[key as keyof Settings] === 'number' ? Number(value) || DEFAULT_SETTINGS.maxSteps : value;
  }
  if (!settings.anthropicModel) settings.anthropicModel = DEFAULT_SETTINGS.anthropicModel;
  await saveSettings(settings as unknown as Settings);
  saved.hidden = false;
  setTimeout(() => (saved.hidden = true), 2000);
});

init();
