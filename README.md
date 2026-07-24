# Puppetflow Grabber

Puppetflow Grabber is the Chrome extension for selecting page elements without writing CSS selectors by hand. It can send a selector back to the correct field in Puppetflow or copy it to the clipboard when used on its own.

## What it does

- Picks elements from any HTTP or HTTPS page.
- Connects nodal selector fields and code editor gizmos to the browser.
- Builds selectors from tags, stable IDs, class chains, HTML attributes, and nearby parents.
- Supports open shadow roots and same-origin iframes.
- Keeps picking active when the selected tab navigates.
- Copies selectors to the clipboard in standalone mode.

## Local development

Install dependencies:

```bash
npm install
```

Start the development build:

```bash
npm run dev
```

Create a production build:

```bash
npm run build
```

Type-check the project:

```bash
npm run lint
```

The built extension is written to `dist/`.

## Load the extension in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose the `puppetflow-grabber/dist` directory.

After rebuilding, reload the extension from `chrome://extensions`. Also reload any browser tab that was open before the extension reload. Chrome invalidates content scripts from the previous extension version.

## Standalone mode

The first click on the toolbar icon opens a short introduction. Select **Pick an element** to continue. Future clicks start picking directly.

Hover an element to inspect it, then click to copy its selector. Press `Esc` or click the extension icon again to cancel.

## Puppetflow editor integration

Puppetflow Core communicates with the extension through the versioned protocol in `src/shared/protocol.ts`.

Hosted editors under `puppetflow.com` are allowed through Chrome's external connection API. Localhost is allowed for development. The Core application can use `VITE_PUPPETFLOW_GRABBER_EXTENSION_ID` when the extension ID is known.

Self-hosted editors use the content-script bridge. Their exact origin must first be added from the extension's **Options** page. Trust is stored locally in Chrome under `puppetflow_grabber_trusted_origins`.

## Selector strategy

The selector engine prefers stable page information in this order:

1. HTML tag with a stable ID.
2. HTML tag with a stable class chain.
3. Useful attributes such as `data-testid`, `aria-label`, `role`, `name`, or `type`.
4. Up to two enriched parent elements.
5. A positional path as a last resort.

Generated-looking IDs, classes, and attribute values are ignored when possible. Shadow boundaries use `>>>`, while iframe boundaries use `>>iframe>>`. Puppetflow's runtime resolves both forms.

## Project layout

- `manifest.json` contains the Manifest V3 configuration.
- `src/background/service-worker.ts` owns editor requests, standalone sessions, tab navigation, and toolbar state.
- `src/content/content-script.ts` connects pages to the service worker and hosts the editor bridge.
- `src/content/picker.ts` handles page interaction, highlighting, keyboard navigation, and clipboard feedback.
- `src/content/selector.ts` generates selectors.
- `src/popup/` contains the first-use standalone popup.
- `src/options/` manages trusted self-hosted origins.
- `public/assets/icons/` contains the Puppetflow extension icons.

## Browser limitations

Chrome does not allow content scripts on internal pages such as `chrome://extensions` or on the Chrome Web Store. Cross-origin iframe contents are also unavailable to the extension, although the iframe element itself can still be selected.
