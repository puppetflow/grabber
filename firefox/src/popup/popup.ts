import browser from 'webextension-polyfill';

const button = document.querySelector<HTMLButtonElement>('#toggle-picker')!;
const error = document.querySelector<HTMLParagraphElement>('#error')!;

type StandaloneResponse = {
  ok: boolean;
  active?: boolean;
  error?: string;
};

const getActiveTab = async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
};

const send = async (type: 'standalone.status' | 'standalone.toggle') => {
  const tab = await getActiveTab();
  if (!tab?.id) return { ok: false, error: 'No active browser tab.' };
  return browser.runtime.sendMessage({
    type,
    tabId: tab.id,
  }) as Promise<StandaloneResponse>;
};

const renderState = (active: boolean) => {
  button.textContent = active ? 'Stop picking' : 'Pick an element';
  button.toggleAttribute('data-active', active);
};

button.addEventListener('click', async () => {
  button.disabled = true;
  error.textContent = '';
  try {
    const response = await send('standalone.toggle');
    if (!response.ok) {
      error.textContent = response.error ?? 'Grabber cannot run on this page.';
      return;
    }
    renderState(Boolean(response.active));
    if (response.active) window.close();
  } catch {
    error.textContent = 'Reload this tab, then try again.';
  } finally {
    button.disabled = false;
  }
});

void send('standalone.status').then(response => {
  if (response.ok) renderState(Boolean(response.active));
  else {
    button.disabled = true;
    error.textContent = response.error ?? 'Grabber cannot run on this page.';
  }
}).catch(() => {
  error.textContent = 'Grabber is not available on this tab.';
});
