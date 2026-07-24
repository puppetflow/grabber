const PREFERRED_ATTRIBUTES = [
  'data-testid',
  'data-test-id',
  'data-test',
  'data-cy',
  'data-qa',
  'aria-label',
  'role',
  'name',
  'title',
  'alt',
  'href',
  'src',
];

const GENERATED_VALUE = /(^|[-_])(?:css|sc|jsx|chakra|mui|ant|ember)[-_]?[a-z0-9]{5,}|[a-f0-9]{8,}|\d{5,}/i;
const IGNORED_ATTRIBUTES = new Set(['id', 'class', 'style', 'value']);

const escapeCss = (value: string) => CSS.escape(value);
const quoteAttribute = (value: string) => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const isShadowRoot = (root: Node): root is ShadowRoot => (
  root.nodeType === Node.DOCUMENT_FRAGMENT_NODE && 'host' in root
);

const getRoot = (element: Element): Document | ShadowRoot => {
  const root = element.getRootNode();
  return isShadowRoot(root) ? root : element.ownerDocument;
};

const queryCount = (root: Document | ShadowRoot, selector: string): number => {
  try {
    return root.querySelectorAll(selector).length;
  } catch {
    return 0;
  }
};

const isStableValue = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 120 && !GENERATED_VALUE.test(trimmed);
};

const stableAttributes = (element: Element): Array<[string, string]> => {
  const names = [
    ...PREFERRED_ATTRIBUTES,
    ...[...element.attributes].map(attribute => attribute.name),
  ];
  const seen = new Set<string>();
  const attributes: Array<[string, string]> = [];

  for (const name of names) {
    if (seen.has(name) || IGNORED_ATTRIBUTES.has(name)) continue;
    seen.add(name);
    const value = element.getAttribute(name);
    if (!value || !isStableValue(value)) continue;
    attributes.push([name, value]);
  }
  return attributes;
};

const ownCandidates = (element: Element): string[] => {
  const tag = element.localName;
  const candidates: string[] = [];
  const stableClasses = [...element.classList].filter(isStableValue).slice(0, 4);
  const attributes = stableAttributes(element);
  const identities: string[] = [];

  if (element.id && isStableValue(element.id)) {
    identities.push(`${tag}#${escapeCss(element.id)}`);
  }
  if (stableClasses.length > 0) {
    identities.push(`${tag}.${stableClasses.map(escapeCss).join('.')}`);
    for (const className of stableClasses) {
      identities.push(`${tag}.${escapeCss(className)}`);
    }
  }
  identities.push(tag);

  for (const identity of identities) {
    for (const [name, value] of attributes) {
      candidates.push(`${identity}[${escapeCss(name)}=${quoteAttribute(value)}]`);
    }
    candidates.push(identity);
  }

  return [...new Set(candidates)];
};

const positionalCandidate = (element: Element): string => {
  const tag = element.localName;
  const parent = element.parentElement;
  if (!parent) return tag;
  const sameTag = [...parent.children].filter(child => child.localName === tag);
  if (sameTag.length === 1) return tag;
  return `${tag}:nth-of-type(${sameTag.indexOf(element) + 1})`;
};

const richCandidate = (element: Element): string => (
  ownCandidates(element)[0] ?? positionalCandidate(element)
);

const richAncestryCandidate = (element: Element): string => {
  const path = [element];
  let parent: Element | null = element.parentElement;
  while (parent && path.length < 3) {
    path.unshift(parent);
    parent = parent.parentElement;
  }
  return path.map(richCandidate).join(' > ');
};

const createLocalSelector = (element: Element): string => {
  const root = getRoot(element);
  const richAncestry = richAncestryCandidate(element);
  if (queryCount(root, richAncestry) === 1) return richAncestry;

  for (const candidate of ownCandidates(element)) {
    if (queryCount(root, candidate) === 1) return candidate;
  }

  let current: Element | null = element;
  let suffixes = ownCandidates(element).slice(0, 12);
  for (let depth = 0; current?.parentElement && depth < 6; depth += 1) {
    current = current.parentElement;
    const ancestors = ownCandidates(current).slice(0, 10);
    const combined: string[] = [];
    for (const ancestor of ancestors) {
      for (const suffix of suffixes) {
        const candidate = `${ancestor} > ${suffix}`;
        const hasTwoAvailableParents = Boolean(element.parentElement?.parentElement);
        if ((!hasTwoAvailableParents || depth >= 1) && queryCount(root, candidate) === 1) {
          return candidate;
        }
        combined.push(candidate);
      }
    }
    suffixes = combined.slice(0, 40);
  }

  const path: string[] = [];
  current = element;
  while (current) {
    const candidate = positionalCandidate(current);
    path.unshift(candidate);
    const selector = path.join(' > ');
    if (queryCount(root, selector) === 1) return selector;
    const parent: Element | null = current.parentElement;
    if (!parent) break;
    current = parent;
  }
  return path.join(' > ');
};

const createSelectorAcrossBoundaries = (element: Element): string => {
  const localSelector = createLocalSelector(element);
  const root = getRoot(element);
  if (isShadowRoot(root)) {
    return `${createSelectorAcrossBoundaries(root.host)} >>> ${localSelector}`;
  }

  const frame = root.defaultView?.frameElement;
  if (frame?.localName === 'iframe') {
    return `${createSelectorAcrossBoundaries(frame)} >>iframe>> ${localSelector}`;
  }
  return localSelector;
};

const semanticTarget = (element: Element): Element => {
  const target = element.closest(
    'button, a[href], input, textarea, select, [role], [data-testid], [data-test-id], [data-test], [data-cy], [data-qa]',
  );
  if (!target) return element;
  const descendantCount = target.querySelectorAll('*').length;
  const documentCount = target.ownerDocument.querySelectorAll('*').length;
  return descendantCount < documentCount / 2 ? target : element;
};

export const createElementSelector = (element: Element) => {
  const target = semanticTarget(element);
  const selector = createSelectorAcrossBoundaries(target);
  return {
    target,
    selector,
    matchCount: queryCount(getRoot(target), createLocalSelector(target)),
  };
};
