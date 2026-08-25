import browser from 'webextension-polyfill';
import {
  EDITOR_CHANNEL,
  PORT_NAME,
  PROTOCOL_VERSION,
  isEditorMessage,
  isExtensionMessage,
  type PickerRuntimeMessage,
} from '../shared/protocol';
import { handlePickerRuntimeMessage } from './picker';

let editorPort: browser.Runtime.Port | null = null;
const activeEditorRequests = new Set<string>();
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

const syncKeepAlive = () => {
  if (activeEditorRequests.size === 0 || !editorPort) {
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    keepAliveTimer = null;
    return;
  }
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    try {
      editorPort?.postMessage({
        v: PROTOCOL_VERSION,
        type: 'bridge.keepalive',
      });
    } catch {
      activeEditorRequests.clear();
      syncKeepAlive();
    }
  }, 20_000);
};

const postToEditor = (message: unknown) => {
  window.postMessage({
    channel: EDITOR_CHANNEL,
    source: 'extension',
    message,
  }, window.location.origin);
};

const connectEditorBridge = () => {
  if (editorPort) return editorPort;
  try {
    const port = browser.runtime.connect({ name: PORT_NAME });
    editorPort = port;
    port.onMessage.addListener((message: unknown) => {
      if (!isExtensionMessage(message)) return;
      postToEditor(message);
      if (message.type !== 'pick.accepted') {
        activeEditorRequests.delete(message.requestId);
        syncKeepAlive();
      }
    });
    port.onDisconnect.addListener(() => {
      editorPort = null;
      activeEditorRequests.clear();
      syncKeepAlive();
      postToEditor({
        v: PROTOCOL_VERSION,
        type: 'bridge.disconnected',
      });
    });
    return port;
  } catch {
    postToEditor({
      v: PROTOCOL_VERSION,
      type: 'bridge.disconnected',
    });
    return null;
  }
};

window.addEventListener('message', event => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (event.data?.channel !== EDITOR_CHANNEL || event.data?.source !== 'editor') return;
  const message = event.data.message;
  if (!isEditorMessage(message)) return;
  const port = connectEditorBridge();
  if (!port) return;
  if (message.type === 'pick.start') {
    activeEditorRequests.add(message.requestId);
    syncKeepAlive();
  }
  try {
    port.postMessage(message);
  } catch {
    activeEditorRequests.delete(message.requestId);
    syncKeepAlive();
    editorPort = null;
  }
});

browser.runtime.onMessage.addListener(async (message: unknown) => {
  if (!message || typeof message !== 'object') return undefined;
  const candidate = message as Partial<PickerRuntimeMessage>;
  if (
    candidate.v !== PROTOCOL_VERSION
    || typeof candidate.requestId !== 'string'
    || (candidate.type !== 'picker.activate' && candidate.type !== 'picker.deactivate')
  ) return undefined;

  handlePickerRuntimeMessage(candidate as PickerRuntimeMessage);
  return { ok: true };
});

postToEditor({
  v: PROTOCOL_VERSION,
  type: 'bridge.present',
});
