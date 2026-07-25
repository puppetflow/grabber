import { PROTOCOL_VERSION, type ExtensionMessage, type PickerRuntimeMessage } from '../shared/protocol';
import { createElementSelector } from './selector';

type PickerSession = {
  requestId: string;
  standalone: boolean;
  selecting: boolean;
  hovered: Element | null;
  documents: Set<Document>;
  cleanups: (() => void)[];
  host: HTMLDivElement;
  outline: HTMLDivElement;
  label: HTMLDivElement;
};

let session: PickerSession | null = null;

const isElementNode = (value: unknown): value is Element => (
  Boolean(value)
  && typeof value === 'object'
  && (value as Node).nodeType === Node.ELEMENT_NODE
);

const topBounds = (element: Element) => {
  const rect = element.getBoundingClientRect();
  let left = rect.left;
  let top = rect.top;
  let win = element.ownerDocument.defaultView;

  while (win && win !== window.top) {
    const frame = win.frameElement;
    if (!isElementNode(frame)) break;
    const frameRect = frame.getBoundingClientRect();
    left += frameRect.left + (frame as HTMLElement).clientLeft;
    top += frameRect.top + (frame as HTMLElement).clientTop;
    win = frame.ownerDocument.defaultView;
  }

  return { left, top, width: rect.width, height: rect.height };
};

const isVisible = (element: Element) => {
  const bounds = element.getBoundingClientRect();
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return bounds.width > 0
    && bounds.height > 0
    && style?.visibility !== 'hidden'
    && style?.display !== 'none'
    && Number(style?.opacity ?? 1) > 0.01;
};

const isGrabbable = (element: Element) => {
  if (
    element === element.ownerDocument.documentElement
    || element === element.ownerDocument.body
  ) return false;
  if (element.closest('[data-puppetflow-grabber-root]')) return false;
  return isVisible(element);
};

const deepestElement = (event: Event): Element | null => {
  return event.composedPath().find(
    candidate => isElementNode(candidate) && isGrabbable(candidate),
  ) as Element | null ?? null;
};

const isOverlayEvent = (event: Event) => (
  Boolean(session?.host)
  && event.composedPath().some(candidate => candidate === session?.host)
);

const renderHovered = (next: Element | null) => {
  if (!session) return;
  session.hovered = next;
  if (!next) {
    session.outline.style.opacity = '0';
    session.label.style.opacity = '0';
    return;
  }

  const bounds = topBounds(next);
  session.outline.style.transform = `translate3d(${bounds.left}px, ${bounds.top}px, 0)`;
  session.outline.style.width = `${bounds.width}px`;
  session.outline.style.height = `${bounds.height}px`;
  session.outline.style.opacity = '1';

  const id = next.id ? `#${next.id}` : '';
  const className = [...next.classList].slice(0, 2).map(value => `.${value}`).join('');
  session.label.textContent = `${next.localName}${id}${className}`;
  const labelTop = bounds.top > 34 ? bounds.top - 28 : bounds.top + bounds.height + 6;
  session.label.style.transform = `translate3d(${Math.max(8, bounds.left)}px, ${labelTop}px, 0)`;
  session.label.style.opacity = '1';
};

const sendTerminal = (message: ExtensionMessage) => {
  try {
    void chrome.runtime.sendMessage(message).catch(() => {
      deactivatePicker('extension-context-invalidated');
    });
  } catch {
    deactivatePicker('extension-context-invalidated');
  }
};

const copySelector = async (selector: string) => {
  try {
    await navigator.clipboard.writeText(selector);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = selector;
    textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
    document.documentElement.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
};

const showCopiedToast = () => {
  document.querySelector('[data-puppetflow-grabber-toast]')?.remove();
  const host = document.createElement('div');
  host.dataset.puppetflowGrabberToast = '';
  host.dataset.puppetflowGrabberRoot = '';
  host.style.cssText = 'position:fixed;right:18px;bottom:18px;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      .toast {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 190px;
        padding: 11px 13px;
        border: 1px solid rgba(72, 197, 145, .42);
        border-radius: 11px;
        color: #f2f5f3;
        background: rgba(19, 22, 19, .96);
        box-shadow: 0 14px 38px rgba(0, 0, 0, .3);
        opacity: 0;
        transform: translate3d(0, 8px, 0) scale(.98);
        transition:
          opacity 180ms ease,
          transform 220ms cubic-bezier(.2, .8, .2, 1);
        font: 600 12px/1.3 "Avenir Next", Avenir, "Segoe UI", sans-serif;
      }
      .toast.visible {
        opacity: 1;
        transform: translate3d(0, 0, 0) scale(1);
      }
      .check {
        display: grid;
        width: 24px;
        height: 24px;
        flex: 0 0 auto;
        place-items: center;
        border-radius: 8px;
        color: #fff;
        background: #48c591;
      }
    </style>
    <div class="toast" role="status" aria-live="polite">
      <span class="check">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m5 12 4 4L19 6"/>
        </svg>
      </span>
      Selector copied to clipboard
    </div>
  `;
  document.documentElement.appendChild(host);
  const toast = root.querySelector<HTMLDivElement>('.toast')!;
  requestAnimationFrame(() => toast.classList.add('visible'));
  setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => host.remove(), 220);
  }, 2200);
};

const isCrossOriginFrame = (element: Element) => {
  if (element.localName !== 'iframe') return false;
  try {
    return !(element as HTMLIFrameElement).contentDocument;
  } catch {
    return true;
  }
};

const handlePick = async (event: Event) => {
  if (!session) return;
  if (isOverlayEvent(event)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (session.selecting) return;
  session.selecting = true;
  const element = deepestElement(event) ?? session.hovered;
  if (!element) {
    session.selecting = false;
    return;
  }
  if (isCrossOriginFrame(element)) {
    sendTerminal({
      v: PROTOCOL_VERSION,
      type: 'pick.error',
      requestId: session.requestId,
      code: 'CROSS_ORIGIN_IFRAME',
      message: 'Chrome does not allow inspecting this cross-origin iframe.',
    });
    deactivatePicker('cross-origin-iframe');
    return;
  }

  const { target, selector, matchCount } = createElementSelector(element);
  const requestId = session.requestId;
  const standalone = session.standalone;
  if (standalone && !await copySelector(selector)) {
    deactivatePicker('clipboard-failed');
    sendTerminal({
      v: PROTOCOL_VERSION,
      type: 'pick.error',
      requestId,
      code: 'CLIPBOARD_FAILED',
      message: 'The selector was generated but could not be copied.',
    });
    return;
  }
  if (standalone) showCopiedToast();
  deactivatePicker('selected');
  sendTerminal({
    v: PROTOCOL_VERSION,
    type: 'pick.result',
    requestId,
    selector,
    pageUrl: target.ownerDocument.location.href,
    tagName: target.localName,
    matchCount,
  });
};

const addDocumentListeners = (documentValue: Document) => {
  if (!session || session.documents.has(documentValue)) return;
  session.documents.add(documentValue);

  const pointerMove = (event: PointerEvent) => {
    if (!isOverlayEvent(event)) renderHovered(deepestElement(event));
  };
  const pointerDown = (event: PointerEvent) => {
    if (isOverlayEvent(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const click = (event: MouseEvent) => {
    void handlePick(event);
  };
  const keyDown = (event: KeyboardEvent) => {
    if (!session) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      const requestId = session.requestId;
      deactivatePicker('escape');
      sendTerminal({
        v: PROTOCOL_VERSION,
        type: 'pick.cancelled',
        requestId,
        reason: 'escape',
      });
      return;
    }
    const current = session.hovered;
    if (!current || !['ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const next = event.key === 'ArrowUp'
      ? current.parentElement
      : event.key === 'ArrowLeft'
        ? current.previousElementSibling
        : current.nextElementSibling;
    if (next && isGrabbable(next)) {
      event.preventDefault();
      renderHovered(next);
    }
  };

  documentValue.addEventListener('pointermove', pointerMove, true);
  documentValue.addEventListener('pointerdown', pointerDown, true);
  documentValue.addEventListener('click', click, true);
  documentValue.addEventListener('keydown', keyDown, true);
  session.cleanups.push(() => {
    documentValue.removeEventListener('pointermove', pointerMove, true);
    documentValue.removeEventListener('pointerdown', pointerDown, true);
    documentValue.removeEventListener('click', click, true);
    documentValue.removeEventListener('keydown', keyDown, true);
  });

  for (const frame of documentValue.querySelectorAll('iframe')) {
    try {
      if (frame.contentDocument) addDocumentListeners(frame.contentDocument);
    } catch {
      // Cross-origin frames are represented by their iframe element.
    }
  }
};

const createOverlay = (standalone: boolean) => {
  const host = document.createElement('div');
  host.dataset.puppetflowGrabberRoot = '';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host {
        all: initial;
        --pf-brand: #48c591;
        --pf-brand-soft: rgba(72, 197, 145, .13);
        --pf-brand-ring: rgba(72, 197, 145, .28);
      }
      .glow {
        position: fixed;
        inset: 0;
        border: 2px solid var(--pf-brand);
        box-shadow: inset 0 0 16px rgba(72, 197, 145, .18);
      }
      .status {
        position: fixed;
        top: 14px;
        left: 50%;
        transform: translateX(-50%);
        padding: 8px 12px;
        border: 1px solid rgba(72, 197, 145, .52);
        border-radius: 999px;
        color: #eafff4;
        background: rgba(7, 18, 14, .9);
        box-shadow: 0 8px 30px rgba(0, 0, 0, .3);
        font: 600 12px/1.2 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .outline {
        position: fixed;
        left: 0;
        top: 0;
        box-sizing: border-box;
        border: 2px solid var(--pf-brand);
        border-radius: 7px;
        background: var(--pf-brand-soft);
        box-shadow:
          0 0 0 3px var(--pf-brand-ring),
          0 8px 26px rgba(7, 18, 14, .2);
        opacity: 0;
        transition:
          transform 150ms cubic-bezier(.2, .8, .2, 1),
          width 150ms cubic-bezier(.2, .8, .2, 1),
          height 150ms cubic-bezier(.2, .8, .2, 1),
          opacity 110ms ease-out;
        will-change: transform, width, height, opacity;
      }
      .label {
        position: fixed;
        left: 0;
        top: 0;
        max-width: min(460px, calc(100vw - 16px));
        overflow: hidden;
        padding: 5px 8px;
        border-radius: 5px;
        color: #fff;
        background: var(--pf-brand);
        box-shadow: 0 5px 16px rgba(7, 18, 14, .18);
        text-overflow: ellipsis;
        white-space: nowrap;
        opacity: 0;
        font: 700 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
        transition:
          transform 150ms cubic-bezier(.2, .8, .2, 1),
          opacity 110ms ease-out;
        will-change: transform, opacity;
      }
    </style>
    <div class="glow"></div>
    <div class="status">Puppetflow Grabber · ${standalone ? 'Click an element to copy its selector' : 'Click an element'} · Esc to cancel</div>
    <div class="outline"></div>
    <div class="label"></div>
  `;
  document.documentElement.appendChild(host);
  return {
    host,
    outline: root.querySelector<HTMLDivElement>('.outline')!,
    label: root.querySelector<HTMLDivElement>('.label')!,
  };
};

export const activatePicker = (requestId: string, standalone = false) => {
  if (session) deactivatePicker('replaced');
  const overlay = createOverlay(standalone);
  session = {
    requestId,
    standalone,
    selecting: false,
    hovered: null,
    documents: new Set(),
    cleanups: [],
    ...overlay,
  };
  addDocumentListeners(document);

  const observer = new MutationObserver(() => {
    if (!session) return;
    for (const frame of document.querySelectorAll('iframe')) {
      try {
        if (frame.contentDocument) addDocumentListeners(frame.contentDocument);
      } catch {
        // Cross-origin frames stay selectable as iframe elements.
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  session.cleanups.push(() => observer.disconnect());
};

export const deactivatePicker = (reason: string) => {
  if (!session) return;
  const current = session;
  session = null;
  current.cleanups.forEach(cleanup => cleanup());
  current.host.remove();
  void reason;
};

export const handlePickerRuntimeMessage = (message: PickerRuntimeMessage) => {
  if (message.type === 'picker.activate') activatePicker(message.requestId, message.standalone);
  else if (session?.requestId === message.requestId) deactivatePicker(message.reason);
};
