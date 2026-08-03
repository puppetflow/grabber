import {
  PORT_NAME,
  PROTOCOL_VERSION,
  isEditorMessage,
  isExtensionMessage,
  type EditorMessage,
  type ExtensionMessage,
} from '../shared/protocol';

const STANDALONE_ONBOARDED_KEY = 'puppetflow_grabber_standalone_onboarded';
const POPUP_PATH = 'src/popup/index.html';
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;

type PendingRequest = {
  editorPort: chrome.runtime.Port;
  editorTabId?: number;
  targetTabId: number;
  timeout: ReturnType<typeof setTimeout>;
  activated: boolean;
  completed: boolean;
};

const pendingRequests = new Map<string, PendingRequest>();
const standaloneRequests = new Map<number, string>();

const syncActionPopup = async () => {
  const result = await chrome.storage.local.get(STANDALONE_ONBOARDED_KEY);
  await chrome.action.setPopup({
    popup: result[STANDALONE_ONBOARDED_KEY] === true ? '' : POPUP_PATH,
  });
};

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

const postSafely = (port: chrome.runtime.Port, message: ExtensionMessage) => {
  try {
    port.postMessage(message);
  } catch {
    // The editor tab can disappear while a terminal message is in flight.
  }
};

const focusTab = async (tabId: number) => {
  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
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
  await chrome.tabs.sendMessage(request.targetTabId, {
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
  const tabs = await chrome.tabs.query({});
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

    const created = await chrome.tabs.create({ url: targetUrl, active: true });
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
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') return;

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('TARGET_LOAD_TIMEOUT'));
    }, 30_000);
    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
};

const startRequest = async (port: chrome.runtime.Port, message: Extract<EditorMessage, { type: 'pick.start' }>) => {
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
    await chrome.tabs.sendMessage(targetTabId, {
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

const attachEditorPort = (port: chrome.runtime.Port) => {
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

chrome.runtime.onConnectExternal.addListener(port => {
  attachEditorPort(port);
});

chrome.runtime.onConnect.addListener(port => {
  attachEditorPort(port);
});

const toggleStandalonePicker = async (tabId: number) => {
  const tab = await chrome.tabs.get(tabId);
  if (!isHttpUrl(tab.url)) {
    return { ok: false, active: false, error: 'Chrome does not allow picking on this page.' };
  }

  const editorRequest = [...pendingRequests.entries()]
    .find(([, request]) => request.targetTabId === tabId);
  if (editorRequest) {
    await cancelRequest(editorRequest[0], 'toolbar');
    return { ok: true, active: false };
  }

  const activeRequestId = standaloneRequests.get(tabId);
  if (activeRequestId) {
    standaloneRequests.delete(tabId);
    await chrome.tabs.sendMessage(tabId, {
      v: PROTOCOL_VERSION,
      type: 'picker.deactivate',
      requestId: activeRequestId,
      reason: 'toolbar',
    }).catch(() => undefined);
    await chrome.action.setBadgeText({ tabId, text: '' });
    return { ok: true, active: false };
  }

  const requestId = `standalone:${crypto.randomUUID()}`;
  try {
    await chrome.tabs.sendMessage(tabId, {
      v: PROTOCOL_VERSION,
      type: 'picker.activate',
      requestId,
      standalone: true,
    });
    standaloneRequests.set(tabId, requestId);
    await chrome.storage.local.set({ [STANDALONE_ONBOARDED_KEY]: true });
    await chrome.action.setPopup({ popup: '' });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: '#48c591' });
    await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    await chrome.action.setBadgeText({ tabId, text: 'ON' });
    return { ok: true, active: true };
  } catch {
    return { ok: false, active: false, error: 'Reload this tab before starting Grabber.' };
  }
};

chrome.action.onClicked.addListener(tab => {
  if (!tab.id) return;
  void toggleStandalonePicker(tab.id).then(response => {
    if (response.ok) return;
    void chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#d84a4a' });
    void chrome.action.setBadgeText({ tabId: tab.id, text: '!' });
    setTimeout(() => {
      if (tab.id) void chrome.action.setBadgeText({ tabId: tab.id, text: '' });
    }, 1800);
  });
});

chrome.runtime.onMessage.addListener((value: unknown, sender, sendResponse) => {
  if (
    value
    && typeof value === 'object'
    && sender.id === chrome.runtime.id
    && ['standalone.status', 'standalone.toggle'].includes((value as { type?: string }).type ?? '')
  ) {
    const command = value as { type: 'standalone.status' | 'standalone.toggle'; tabId?: number };
    if (!command.tabId) {
      sendResponse({ ok: false, active: false, error: 'No active browser tab.' });
      return false;
    }
    if (command.type === 'standalone.status') {
      sendResponse({
        ok: true,
        active: standaloneRequests.has(command.tabId)
          || [...pendingRequests.values()].some(request => request.targetTabId === command.tabId),
      });
      return false;
    }
    void toggleStandalonePicker(command.tabId).then(sendResponse);
    return true;
  }

  if (!isExtensionMessage(value)) return;
  const request = pendingRequests.get(value.requestId);
  if (request && request.targetTabId === sender.tab?.id) {
    void finishRequest(value.requestId, value, value.type === 'pick.result');
    return;
  }

  const tabId = sender.tab?.id;
  if (!tabId || standaloneRequests.get(tabId) !== value.requestId) return;
  standaloneRequests.delete(tabId);
  const succeeded = value.type === 'pick.result';
  void chrome.action.setBadgeBackgroundColor({
    tabId,
    color: succeeded ? '#48c591' : '#d84a4a',
  });
  void chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
  void chrome.action.setBadgeText({ tabId, text: succeeded ? '✓' : '!' });
  setTimeout(() => {
    void chrome.action.setBadgeText({ tabId, text: '' });
  }, 1800);
});

chrome.tabs.onRemoved.addListener(tabId => {
  standaloneRequests.delete(tabId);
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
      await chrome.tabs.sendMessage(tabId, {
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

  const standaloneRequestId = standaloneRequests.get(tabId);
  if (!standaloneRequestId) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      v: PROTOCOL_VERSION,
      type: 'picker.activate',
      requestId: standaloneRequestId,
      standalone: true,
    });
  } catch {
    // Unsupported pages remain armed until the tab reaches an HTTP(S) page.
  }
};

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    for (const request of pendingRequests.values()) {
      if (request.targetTabId === tabId) request.activated = false;
    }
    return;
  }
  if (changeInfo.status === 'complete') void reactivatePickerAfterNavigation(tabId);
});

