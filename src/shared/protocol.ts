export const PROTOCOL_VERSION = 1 as const;
export const EDITOR_CHANNEL = '__PUPPETFLOW_GRABBER__';
export const PORT_NAME = 'puppetflow-grabber';

export type PickStartMessage = {
  v: typeof PROTOCOL_VERSION;
  type: 'pick.start';
  requestId: string;
  targetUrl?: string | null;
};

export type PickCancelMessage = {
  v: typeof PROTOCOL_VERSION;
  type: 'pick.cancel';
  requestId: string;
};

export type EditorMessage = PickStartMessage | PickCancelMessage;

export type PickAcceptedMessage = {
  v: typeof PROTOCOL_VERSION;
  type: 'pick.accepted';
  requestId: string;
  tabId: number;
};

export type PickResultMessage = {
  v: typeof PROTOCOL_VERSION;
  type: 'pick.result';
  requestId: string;
  selector: string;
  pageUrl: string;
  tagName: string;
  matchCount: number;
};

export type PickCancelledMessage = {
  v: typeof PROTOCOL_VERSION;
  type: 'pick.cancelled';
  requestId: string;
  reason: string;
};

export type PickErrorMessage = {
  v: typeof PROTOCOL_VERSION;
  type: 'pick.error';
  requestId: string;
  code: string;
  message: string;
};

export type ExtensionMessage =
  | PickAcceptedMessage
  | PickResultMessage
  | PickCancelledMessage
  | PickErrorMessage;

export type ActivatePickerMessage = {
  v: typeof PROTOCOL_VERSION;
  type: 'picker.activate';
  requestId: string;
  standalone?: boolean;
};

export type DeactivatePickerMessage = {
  v: typeof PROTOCOL_VERSION;
  type: 'picker.deactivate';
  requestId: string;
  reason: string;
};

export type PickerRuntimeMessage = ActivatePickerMessage | DeactivatePickerMessage;

export const isEditorMessage = (value: unknown): value is EditorMessage => {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<EditorMessage>;
  return message.v === PROTOCOL_VERSION
    && typeof message.requestId === 'string'
    && (message.type === 'pick.start' || message.type === 'pick.cancel');
};

export const isExtensionMessage = (value: unknown): value is ExtensionMessage => {
  if (!value || typeof value !== 'object') return false;
  const message = value as Partial<ExtensionMessage>;
  return message.v === PROTOCOL_VERSION
    && typeof message.requestId === 'string'
    && ['pick.accepted', 'pick.result', 'pick.cancelled', 'pick.error'].includes(message.type ?? '');
};
