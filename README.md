<a href="https://puppetflow.com"><img src="https://www.puppetflow.com/img/puppetflow-promo-banner.png" width="100%" alt="Puppetflow" /></a>

# Puppetflow Grabber

Puppetflow Grabber is available as a Chrome extension and a native Firefox WebExtension. It selects page elements without requiring hand-written CSS selectors, sends the result back to Puppetflow, or copies it to the clipboard in standalone mode.

## Features

- Picks elements on HTTP and HTTPS pages.
- Connects Puppetflow selector fields and code editor gizmos to the browser.
- Produces CSS selectors, JS paths, XPath, full XPath, and compact Puppetflow selectors.
- Supports open shadow roots and same-origin iframes.
- Keeps an active editor request armed while the target tab navigates.
- Provides a standalone clipboard mode from the toolbar.

## Repository layout

- `chrome/` contains the complete Chrome Manifest V3 extension and service worker.
- `firefox/` contains the complete Firefox Manifest V3 extension and event-driven background script.
- `.github/workflows/release.yml` builds both browsers from the shared `version.txt`.

Each browser directory owns its manifest, source code, icons, TypeScript configuration, Vite configuration, dependencies, and generated `dist/` directory.

## Chrome development

```bash
cd chrome
npm install
npm run lint
npm run build
```

To load the build:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose `chrome/dist`.

After rebuilding, reload the extension and any page that was open before the reload.

The release workflow also creates a locally signed `chrome-enterprise` CRX. This artifact is intended for managed enterprise deployment; normal Chrome distribution requires publishing through the Chrome Web Store.

## Firefox development

The Firefox build targets Firefox 142 or newer.

```bash
cd firefox
npm install
npm run lint
npm run build
npm run lint:webext
```

To load the unsigned development build:

1. Open `about:debugging#/runtime/this-firefox`.
2. Select **Load Temporary Add-on**.
3. Choose `firefox/dist/manifest.json`.

Temporary add-ons are removed when Firefox closes. The release workflow produces an unsigned Firefox ZIP for development and review; permanent installation requires Mozilla Add-ons signing.

## Reproduce the Firefox submission

The AMO source build is supported on a 64-bit Linux environment such as Ubuntu 24.04, or on macOS, with a POSIX-compatible shell and internet access to the official npm registry.

Install Node.js 22.x, which includes npm, from [nodejs.org](https://nodejs.org/en/download). No globally installed npm package is required; `npm ci` restores the exact dependency versions from `firefox/package-lock.json`.

From the root of the extracted source archive, run:

```bash
./bin/build-firefox
```

The script checks the Node.js version, applies `version.txt` to the Firefox manifest, installs locked dependencies, type-checks the source, creates the production build, validates it with `web-ext`, and writes the reproducible submission archive to:

```text
release/puppetflow-grabber-firefox-v<version>.zip
```

The human-readable TypeScript, HTML, manifest, build configuration, lockfile, icons, and build script are included in the source archive. Generated `dist/` files and `node_modules/` are intentionally excluded.

## Standalone mode

The first toolbar click opens a short introduction. Select **Pick an element**, hover an element, then click it and choose an extraction format. Press `Esc` or click the toolbar icon again to cancel.

## Puppetflow editor integration

Both extensions use the versioned protocol in each browser's `src/shared/protocol.ts`.

Chrome supports direct external connections from allowed web pages and also includes a content-script bridge. Firefox does not expose `externally_connectable` messaging to web pages, so its integration always uses the content-script bridge:

`Puppetflow page → window.postMessage → content script → background script`

The browser-specific source trees intentionally remain independent so their manifests, API namespaces, background lifecycles, and release formats can evolve without browser conditionals in production code.

## Selector strategy

The selector engine prefers stable page information in this order:

1. An HTML tag with a stable ID.
2. An HTML tag with a stable class chain.
3. Useful attributes such as `data-testid`, `aria-label`, `role`, `name`, or `type`.
4. Up to two enriched parent elements.
5. A positional path as a last resort.

Generated-looking IDs, classes, and attributes are ignored when possible. Shadow boundaries use `>>>`, while iframe boundaries use `>>iframe>>`; Puppetflow's runtime resolves both forms.

## Browser limitations

Extensions cannot inspect browser-internal pages, browser stores, or cross-origin iframe contents. Cross-origin iframe selection is rejected because the target document cannot be traversed safely.
