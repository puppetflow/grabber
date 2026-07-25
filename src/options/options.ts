const STORAGE_KEY = 'puppetflow_grabber_trusted_origins';
const STANDALONE_ONBOARDED_KEY = 'puppetflow_grabber_standalone_onboarded';
const POPUP_PATH = 'src/popup/index.html';

const form = document.querySelector<HTMLFormElement>('#origin-form')!;
const input = document.querySelector<HTMLInputElement>('#origin-input')!;
const list = document.querySelector<HTMLUListElement>('#origin-list')!;
const resetOnboarding = document.querySelector<HTMLButtonElement>('#reset-onboarding')!;

const readOrigins = async (): Promise<string[]> => {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return Array.isArray(result[STORAGE_KEY])
    ? result[STORAGE_KEY].filter((value): value is string => typeof value === 'string')
    : [];
};

const writeOrigins = async (origins: string[]) => {
  await chrome.storage.local.set({ [STORAGE_KEY]: [...new Set(origins)].sort() });
};

const render = async () => {
  const origins = await readOrigins();
  list.replaceChildren();
  if (origins.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No self-hosted editor trusted yet.';
    list.appendChild(empty);
    return;
  }

  origins.forEach(origin => {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = origin;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', async () => {
      await writeOrigins(origins.filter(candidate => candidate !== origin));
      await render();
    });
    item.append(label, remove);
    list.appendChild(item);
  });
};

form.addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const url = new URL(input.value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
    await writeOrigins([...(await readOrigins()), url.origin]);
    input.value = '';
    await render();
  } catch {
    input.setCustomValidity('Enter a valid HTTP or HTTPS origin.');
    input.reportValidity();
  }
});

input.addEventListener('input', () => input.setCustomValidity(''));

resetOnboarding.addEventListener('click', async () => {
  resetOnboarding.disabled = true;
  await chrome.storage.local.remove(STANDALONE_ONBOARDED_KEY);
  await chrome.action.setPopup({ popup: POPUP_PATH });
  resetOnboarding.textContent = 'Onboarding restored';
});

void render();
