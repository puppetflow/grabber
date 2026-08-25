import browser from 'webextension-polyfill';
import {
  PORT_NAME,
  PROTOCOL_VERSION,
  isEditorMessage,
  isExtensionMessage,
  type EditorMessage,
  type ExtensionMessage,
} from '../shared/protocol';

const STANDALONE_ONBOARDED_KEY = 'puppetflow_grabber_standalone_onboarded';
const STANDALONE_REQUESTS_KEY = 'puppetflow_grabber_standalone_requests';
const POPUP_PATH = 'src/popup/index.html';
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

type PendingRequest = {
  editorPort: browser.Runtime.Port;
  editorTabId?: number;
  targetTabId: number;
  timeout: ReturnType<typeof setTimeout>;
  activated: boolean;
  completed: boolean;
};

const pendingRequests = new Map<string, PendingRequest>();
const standaloneRequests = new Map<number, string>();

const hydrateStandaloneRequests = async () => {
  const result = await browser.storage.session.get(STANDALONE_REQUESTS_KEY);
  const stored = result[STANDALONE_REQUESTS_KEY];
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return;
  for (const [rawTabId, requestId] of Object.entries(stored)) {
    const tabId = Number(rawTabId);
    if (Number.isInteger(tabId) && typeof requestId === 'string') {
      standaloneRequests.set(tabId, requestId);
    }
  }
};

const standaloneRequestsReady = hydrateStandaloneRequests().catch(() => undefined);

const persistStandaloneRequests = async () => {
  const value = Object.fromEntries(
    [...standaloneRequests].map(([tabId, requestId]) => [String(tabId), requestId]),
  );
  await browser.storage.session.set({ [STANDALONE_REQUESTS_KEY]: value }).catch(() => undefined);
};

const setStandaloneRequest = async (tabId: number, requestId: string) => {
  standaloneRequests.set(tabId, requestId);
  await persistStandaloneRequests();
};

const deleteStandaloneRequest = async (tabId: number) => {
  if (!standaloneRequests.delete(tabId)) return;
  await persistStandaloneRequests();
};

const syncActionPopup = async () => {
  const result = await browser.storage.local.get(STANDALONE_ONBOARDED_KEY);
  await browser.action.setPopup({
    popup: result[STANDALONE_ONBOARDED_KEY] === true ? '' : POPUP_PATH,
  });
};

browser.runtime.onStartup.addListener(() => {
  void syncActionPopup();
});
browser.runtime.onInstalled.addListener(() => {
  void syncActionPopup();
});
void syncActionPopup();

const isHttpUrl = (value?: string) => {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const postSafely = (port: browser.Runtime.Port, message: ExtensionMessage) => {
  try {
    port.postMessage(message);
  } catch {
    // The editor tab can disappear while a terminal message is in flight.
  }
};

const focusTab = async (tabId: number) => {
  const tab = await browser.tabs.get(tabId);
  if (tab.windowId === undefined) throw new Error('TARGET_WINDOW_UNAVAILABLE');
  await browser.windows.update(tab.windowId, { focused: true });
  await browser.tabs.update(tabId, { active: true });
};

const finishRequest = async (requestId: string, message: ExtensionMessage, focusEditor = false) => {
  const request = pendingRequests.get(requestId);
  if (!request || request.completed) return;
  request.completed = true;
  clearTimeout(request.timeout);
  pendingRequests.delete(requestId);

  postSafely(request.editorPort, message);
  if (focusEditor && request.editorTabId) {
    await focusTab(request.editorTabId).catch(() => undefined);
  }
};

const cancelRequest = async (requestId: string, reason: string) => {
  const request = pendingRequests.get(requestId);
  if (!request || request.completed) return;
  await browser.tabs.sendMessage(request.targetTabId, {
    v: PROTOCOL_VERSION,
    type: 'picker.deactivate',
    requestId,
    reason,
  }).catch(() => undefined);
  await finishRequest(requestId, {
    v: PROTOCOL_VERSION,
    type: 'pick.cancelled',
    requestId,
    reason,
  });
};

const normalizeComparableUrl = (value: string) => {
  const url = new URL(value);
  url.hash = '';
  return url.href.replace(/\/$/, '');
};

const findOrOpenTargetTab = async (targetUrl: string | null, editorTabId?: number) => {
  const tabs = await browser.tabs.query({});
  if (targetUrl) {
    const normalizedTarget = normalizeComparableUrl(targetUrl);
    const existing = tabs.find(tab => {
      if (!tab.id || !tab.url) return false;
      try {
        return normalizeComparableUrl(tab.url) === normalizedTarget;
      } catch {
        return false;
      }
    });
    if (existing?.id) {
      await focusTab(existing.id);
      return existing.id;
    }

    const created = await browser.tabs.create({ url: targetUrl, active: true });
    if (!created.id) throw new Error('TARGET_TAB_UNAVAILABLE');
    await focusTab(created.id);
    return created.id;
  }

  const active = tabs.find(tab => tab.active && tab.id !== editorTabId && tab.id && /^https?:/i.test(tab.url ?? ''));
  if (active?.id) {
    await focusTab(active.id);
    return active.id;
  }

  const recent = tabs
    .filter(tab => tab.id !== editorTabId && tab.id && /^https?:/i.test(tab.url ?? ''))
    .sort((left, right) => (right.lastAccessed ?? 0) - (left.lastAccessed ?? 0))[0];
  if (!recent?.id) throw new Error('NO_TARGET_TAB');
  await focusTab(recent.id);
  return recent.id;
};

const waitForTabReady = async (tabId: number): Promise<void> => {
  const tab = await browser.tabs.get(tabId);
  if (tab.status === 'complete') return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      browser.tabs.onUpdated.removeListener(listener);
      reject(new Error('TARGET_LOAD_TIMEOUT'));
    }, 30_000);
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      clearTimeout(timeout);
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    browser.tabs.onUpdated.addListener(listener);
  });
};

const startRequest = async (port: browser.Runtime.Port, message: Extract<EditorMessage, { type: 'pick.start' }>) => {
  if (pendingRequests.has(message.requestId)) {
    postSafely(port, {
      v: PROTOCOL_VERSION,
      type: 'pick.error',
      requestId: message.requestId,
      code: 'DUPLICATE_REQUEST',
      message: 'This grab request is already active.',
    });
    return;
  }

  let targetUrl: string | null = null;
  if (message.targetUrl) {
    try {
      const parsed = new URL(message.targetUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
      targetUrl = parsed.href;
    } catch {
      postSafely(port, {
        v: PROTOCOL_VERSION,
        type: 'pick.error',
        requestId: message.requestId,
        code: 'INVALID_TARGET_URL',
        message: 'The target page must use HTTP or HTTPS.',
      });
      return;
    }
  }

  try {
    const editorTabId = port.sender?.tab?.id;
    const targetTabId = await findOrOpenTargetTab(targetUrl, editorTabId);
    const timeout = setTimeout(() => {
      void cancelRequest(message.requestId, 'timeout');
    }, REQUEST_TIMEOUT_MS);
    pendingRequests.set(message.requestId, {
      editorPort: port,
      editorTabId,
      targetTabId,
      timeout,
      activated: false,
      completed: false,
    });

    await waitForTabReady(targetTabId);
    await browser.tabs.sendMessage(targetTabId, {
      v: PROTOCOL_VERSION,
      type: 'picker.activate',
      requestId: message.requestId,
    });
    const activeRequest = pendingRequests.get(message.requestId);
    if (activeRequest) activeRequest.activated = true;
    postSafely(port, {
      v: PROTOCOL_VERSION,
      type: 'pick.accepted',
      requestId: message.requestId,
      tabId: targetTabId,
    });
  } catch (error) {
    const request = pendingRequests.get(message.requestId);
    if (request) {
      clearTimeout(request.timeout);
      pendingRequests.delete(message.requestId);
    }
    postSafely(port, {
      v: PROTOCOL_VERSION,
      type: 'pick.error',
      requestId: message.requestId,
      code: error instanceof Error ? error.message : 'PICKER_START_FAILED',
      message: 'Puppetflow Grabber could not activate on the target tab.',
    });
  }
};

const attachEditorPort = (port: browser.Runtime.Port) => {
  if (port.name !== PORT_NAME) {
    port.disconnect();
    return;
  }

  port.onMessage.addListener((value: unknown) => {
    if (!isEditorMessage(value)) return;
    if (value.type === 'pick.start') {
      void startRequest(port, value);
    } else {
      void cancelRequest(value.requestId, 'editor');
    }
  });
  port.onDisconnect.addListener(() => {
    for (const [requestId, request] of pendingRequests) {
      if (request.editorPort === port) void cancelRequest(requestId, 'editor-disconnected');
    }
  });
};

browser.runtime.onConnect.addListener(port => {
  attachEditorPort(port);
});

const toggleStandalonePicker = async (tabId: number) => {
  await standaloneRequestsReady;
  const tab = await browser.tabs.get(tabId);
  if (!isHttpUrl(tab.url)) {
    return { ok: false, active: false, error: 'Firefox does not allow picking on this page.' };
  }

  const editorRequest = [...pendingRequests.entries()]
    .find(([, request]) => request.targetTabId === tabId);
  if (editorRequest) {
    await cancelRequest(editorRequest[0], 'toolbar');
    return { ok: true, active: false };
  }

  const activeRequestId = standaloneRequests.get(tabId);
  if (activeRequestId) {
    await deleteStandaloneRequest(tabId);
    await browser.tabs.sendMessage(tabId, {
      v: PROTOCOL_VERSION,
      type: 'picker.deactivate',
      requestId: activeRequestId,
      reason: 'toolbar',
    }).catch(() => undefined);
    await browser.action.setBadgeText({ tabId, text: '' });
    return { ok: true, active: false };
  }

  const requestId = `standalone:${crypto.randomUUID()}`;
  try {
    await browser.tabs.sendMessage(tabId, {
      v: PROTOCOL_VERSION,
      type: 'picker.activate',
      requestId,
      standalone: true,
    });
    await setStandaloneRequest(tabId, requestId);
    await browser.storage.local.set({ [STANDALONE_ONBOARDED_KEY]: true });
    await browser.action.setPopup({ popup: '' });
    await browser.action.setBadgeBackgroundColor({ tabId, color: '#48c591' });
    await browser.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    await browser.action.setBadgeText({ tabId, text: 'ON' });
    return { ok: true, active: true };
  } catch {
    return { ok: false, active: false, error: 'Reload this tab before starting Grabber.' };
  }
};

browser.action.onClicked.addListener(tab => {
  if (!tab.id) return;
  void toggleStandalonePicker(tab.id).then(response => {
    if (response.ok) return;
    void browser.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#d84a4a' });
    void browser.action.setBadgeText({ tabId: tab.id, text: '!' });
    setTimeout(() => {
      if (tab.id) void browser.action.setBadgeText({ tabId: tab.id, text: '' });
    }, 1800);
  });
});

type StandaloneCommand = {
  type: 'standalone.status' | 'standalone.toggle';
  tabId?: number;
};

const handleStandaloneCommand = async (command: StandaloneCommand) => {
  await standaloneRequestsReady;
  if (!command.tabId) {
    return { ok: false, active: false, error: 'No active browser tab.' };
  }
  if (command.type === 'standalone.status') {
    return {
      ok: true,
      active: standaloneRequests.has(command.tabId)
        || [...pendingRequests.values()].some(request => request.targetTabId === command.tabId),
    };
  }
  return toggleStandalonePicker(command.tabId);
};

const handleTerminalMessage = async (
  value: ExtensionMessage,
  senderTabId?: number,
) => {
  const request = pendingRequests.get(value.requestId);
  if (request && request.targetTabId === senderTabId) {
    await finishRequest(value.requestId, value, value.type === 'pick.result');
    return;
  }

  await standaloneRequestsReady;
  if (!senderTabId || standaloneRequests.get(senderTabId) !== value.requestId) return;
  await deleteStandaloneRequest(senderTabId);
  const succeeded = value.type === 'pick.result';
  await browser.action.setBadgeBackgroundColor({
    tabId: senderTabId,
    color: succeeded ? '#48c591' : '#d84a4a',
  });
  await browser.action.setBadgeTextColor({ tabId: senderTabId, color: '#ffffff' });
  await browser.action.setBadgeText({ tabId: senderTabId, text: succeeded ? '✓' : '!' });
  setTimeout(() => {
    void browser.action.setBadgeText({ tabId: senderTabId, text: '' });
  }, 1800);
};

browser.runtime.onMessage.addListener(async (value: unknown, sender: browser.Runtime.MessageSender) => {
  if (
    value
    && typeof value === 'object'
    && sender.id === browser.runtime.id
    && ['standalone.status', 'standalone.toggle'].includes((value as { type?: string }).type ?? '')
  ) {
    return handleStandaloneCommand(value as StandaloneCommand);
  }

  if (!isExtensionMessage(value)) return;
  await handleTerminalMessage(value, sender.tab?.id);
  return { ok: true };
});

browser.tabs.onRemoved.addListener(tabId => {
  void standaloneRequestsReady.then(() => deleteStandaloneRequest(tabId));
  for (const [requestId, request] of pendingRequests) {
    if (request.targetTabId === tabId) void cancelRequest(requestId, 'target-closed');
    if (request.editorTabId === tabId) void cancelRequest(requestId, 'editor-closed');
  }
});

const reactivatePickerAfterNavigation = async (tabId: number) => {
  const editorRequest = [...pendingRequests.entries()]
    .find(([, request]) => request.targetTabId === tabId && !request.completed);
  if (editorRequest) {
    try {
      await browser.tabs.sendMessage(tabId, {
        v: PROTOCOL_VERSION,
        type: 'picker.activate',
        requestId: editorRequest[0],
      });
      editorRequest[1].activated = true;
    } catch {
      // Unsupported pages remain armed until the tab reaches an HTTP(S) page.
    }
    return;
  }

  await standaloneRequestsReady;
  const standaloneRequestId = standaloneRequests.get(tabId);
  if (!standaloneRequestId) return;
  try {
    await browser.tabs.sendMessage(tabId, {
      v: PROTOCOL_VERSION,
      type: 'picker.activate',
      requestId: standaloneRequestId,
      standalone: true,
    });
  } catch {
    // Unsupported pages remain armed until the tab reaches an HTTP(S) page.
  }
};

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    for (const request of pendingRequests.values()) {
      if (request.targetTabId === tabId) request.activated = false;
    }
    return;
  }
  if (changeInfo.status === 'complete') void reactivatePickerAfterNavigation(tabId);
});

