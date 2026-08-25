import browser from 'webextension-polyfill';
import { PROTOCOL_VERSION, type ExtensionMessage, type PickerRuntimeMessage } from '../shared/protocol';
import {
  createExtractionOptions,
  type ExtractionMode,
  type ExtractionOption,
} from './selector';

type PickerSession = {
  requestId: string;
  standalone: boolean;
  selecting: boolean;
  hovered: Element | null;
  selected: Element | null;
  options: ExtractionOption[];
  documents: Set<Document>;
  frames: WeakSet<HTMLIFrameElement>;
  cleanups: (() => void)[];
  host: HTMLDivElement;
  outline: HTMLDivElement;
  label: HTMLDivElement;
  status: HTMLDivElement;
  menu: HTMLDivElement;
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
    void browser.runtime.sendMessage(message).catch(() => {
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

const showCopiedToast = (label: string) => {
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
      <span class="toast-message"></span>
    </div>
  `;
  root.querySelector<HTMLSpanElement>('.toast-message')!.textContent = `${label} copied to clipboard`;
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

const closeExtractionMenu = () => {
  if (!session) return;
  session.selecting = false;
  session.selected = null;
  session.options = [];
  session.menu.style.opacity = '0';
  session.menu.style.pointerEvents = 'none';
  session.menu.style.transform = 'translate3d(0, 4px, 0) scale(.98)';
  session.status.textContent = 'Puppetflow Grabber · Click an element · Esc to cancel';
};

const showExtractionMenu = (element: Element) => {
  if (!session) return;
  const bounds = topBounds(element);
  const menuWidth = 238;
  const menuHeight = 212;
  const left = Math.min(
    Math.max(8, bounds.left),
    Math.max(8, window.innerWidth - menuWidth - 8),
  );
  const preferredTop = bounds.top + bounds.height + 8;
  const top = preferredTop + menuHeight <= window.innerHeight
    ? preferredTop
    : Math.max(8, bounds.top - menuHeight - 8);

  session.menu.style.left = `${left}px`;
  session.menu.style.top = `${top}px`;
  session.menu.style.pointerEvents = 'auto';
  session.menu.style.opacity = '1';
  session.menu.style.transform = 'translate3d(0, 0, 0) scale(1)';
  session.status.textContent = 'Choose an extraction format · Esc to go back';
  session.menu.querySelector<HTMLButtonElement>('[data-extraction-mode]')?.focus();
};

const completePick = async (option: ExtractionOption) => {
  if (!session?.selected) return;
  const target = session.selected;
  const current = session;
  const requestId = current.requestId;
  if (current.standalone && !await copySelector(option.value)) {
    deactivatePicker('clipboard-failed');
    sendTerminal({
      v: PROTOCOL_VERSION,
      type: 'pick.error',
      requestId,
      code: 'CLIPBOARD_FAILED',
      message: 'The element path was generated but could not be copied.',
    });
    return;
  }
  if (current.standalone) showCopiedToast(option.label);
  deactivatePicker('selected');
  sendTerminal({
    v: PROTOCOL_VERSION,
    type: 'pick.result',
    requestId,
    selector: option.value,
    extractionMode: option.mode,
    extractionLabel: option.label,
    pageUrl: target.ownerDocument.location.href,
    tagName: target.localName,
    matchCount: option.matchCount,
  });
};

const handleExtractionChoice = (event: Event) => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-extraction-mode]');
  if (!session || !button) return;
  event.preventDefault();
  event.stopPropagation();
  const mode = button.dataset.extractionMode as ExtractionMode | undefined;
  const option = session.options.find(candidate => candidate.mode === mode);
  if (option) void completePick(option);
};

const handlePick = async (event: Event) => {
  if (!session) return;
  if (isOverlayEvent(event)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
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
      message: 'Firefox does not allow inspecting this cross-origin iframe.',
    });
    deactivatePicker('cross-origin-iframe');
    return;
  }

  session.selected = element;
  session.options = createExtractionOptions(element);
  renderHovered(element);
  showExtractionMenu(element);
};

const watchFrame = (frame: HTMLIFrameElement) => {
  if (!session || session.frames.has(frame)) return;
  session.frames.add(frame);
  const attachCurrentDocument = () => {
    try {
      if (frame.contentDocument) addDocumentListeners(frame.contentDocument);
    } catch {
      // Cross-origin frames are represented by their iframe element.
    }
  };
  frame.addEventListener('load', attachCurrentDocument);
  session.cleanups.push(() => frame.removeEventListener('load', attachCurrentDocument));
  attachCurrentDocument();
};

function addDocumentListeners(documentValue: Document) {
  if (!session || session.documents.has(documentValue)) return;
  session.documents.add(documentValue);

  const pointerMove = (event: PointerEvent) => {
    if (!session?.selecting && !isOverlayEvent(event)) renderHovered(deepestElement(event));
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
      if (session.selecting) {
        closeExtractionMenu();
        return;
      }
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
    if (session.selecting) return;
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
    watchFrame(frame);
  }
}

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
      .extract-menu {
        position: fixed;
        box-sizing: border-box;
        width: 238px;
        overflow: hidden;
        padding: 6px;
        border: 1px solid rgba(255, 255, 255, .11);
        border-radius: 12px;
        color: #f4f7f5;
        background: rgba(18, 21, 19, .98);
        box-shadow:
          0 20px 55px rgba(0, 0, 0, .34),
          0 2px 8px rgba(0, 0, 0, .28);
        opacity: 0;
        pointer-events: none;
        transform: translate3d(0, 4px, 0) scale(.98);
        transform-origin: top left;
        transition:
          opacity 120ms ease,
          transform 150ms cubic-bezier(.2, .8, .2, 1);
        font: 500 12px/1.25 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .extract-title {
        padding: 7px 9px 6px;
        color: rgba(244, 247, 245, .5);
        font-size: 10px;
        font-weight: 700;
        letter-spacing: .08em;
        text-transform: uppercase;
      }
      .extract-option {
        display: flex;
        width: 100%;
        align-items: center;
        gap: 9px;
        box-sizing: border-box;
        padding: 8px 9px;
        border: 0;
        border-radius: 7px;
        color: inherit;
        background: transparent;
        cursor: pointer;
        text-align: left;
        font: inherit;
      }
      .extract-option:hover,
      .extract-option:focus-visible {
        outline: none;
        background: rgba(72, 197, 145, .14);
      }
      .extract-option + .extract-option {
        margin-top: 1px;
      }
      .extract-option svg {
        flex: 0 0 auto;
        color: #48c591;
      }
      .extract-option span {
        flex: 1;
      }
    </style>
    <div class="glow"></div>
    <div class="status"></div>
    <div class="outline"></div>
    <div class="label"></div>
    <div class="extract-menu" role="menu" aria-label="Extraction format">
      <div class="extract-title">Extract element as</div>
      <button class="extract-option" type="button" role="menuitem" data-extraction-mode="selector">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m8 9-4 3 4 3m8-6 4 3-4 3m-2-9-4 12"/></svg>
        <span>Copy Selector</span>
      </button>
      <button class="extract-option" type="button" role="menuitem" data-extraction-mode="js-path">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m8 9-4 3 4 3m8-6 4 3-4 3"/></svg>
        <span>Copy JS Path</span>
      </button>
      <button class="extract-option" type="button" role="menuitem" data-extraction-mode="xpath">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 6h16M7 12h10M9 18h6"/></svg>
        <span>Copy XPath</span>
      </button>
      <button class="extract-option" type="button" role="menuitem" data-extraction-mode="full-xpath">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M4 5h16M4 12h16M4 19h16"/></svg>
        <span>Copy Full XPath</span>
      </button>
      <button class="extract-option" type="button" role="menuitem" data-extraction-mode="minimal">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m20 6-11 11-5-5"/></svg>
        <span>Copy Minimal Selector</span>
      </button>
    </div>
  `;
  root.querySelector<HTMLDivElement>('.status')!.textContent = standalone
    ? 'Puppetflow Grabber · Click an element to copy its selector · Esc to cancel'
    : 'Puppetflow Grabber · Click an element · Esc to cancel';
  document.documentElement.appendChild(host);
  return {
    host,
    outline: root.querySelector<HTMLDivElement>('.outline')!,
    label: root.querySelector<HTMLDivElement>('.label')!,
    status: root.querySelector<HTMLDivElement>('.status')!,
    menu: root.querySelector<HTMLDivElement>('.extract-menu')!,
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
    selected: null,
    options: [],
    documents: new Set(),
    frames: new WeakSet(),
    cleanups: [],
    ...overlay,
  };
  overlay.menu.addEventListener('click', handleExtractionChoice);
  session.cleanups.push(() => overlay.menu.removeEventListener('click', handleExtractionChoice));
  addDocumentListeners(document);

  const observer = new MutationObserver(() => {
    if (!session) return;
    for (const frame of document.querySelectorAll('iframe')) {
      watchFrame(frame);
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
