import './icons.css';

type Shape = readonly [tag: 'path' | 'rect' | 'circle' | 'line', attributes: Record<string, string | number>];
const paths = (d: string): Shape[] => [['path', { d }]];
const icons = {
  download: paths('M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4'),
  history: paths('M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2'),
  plus: paths('M12 5v14M5 12h14'),
  bookmark: paths('M6 4h12v17l-6-4-6 4V4Z'),
  star: paths('m12 3 2.8 5.7 6.3.9-4.5 4.4 1.1 6.2L12 17.3l-5.7 2.9 1.1-6.2L3 9.6l6.3-.9L12 3Z'),
  settings: [...paths('M4 7h2m6 0h8M4 17h8m6 0h2'), ['circle', { cx: 9, cy: 7, r: 3 }], ['circle', { cx: 15, cy: 17, r: 3 }]],
  page: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }], ...paths('M3 9h18M7 6.5h.01M10 6.5h.01')],
  document: paths('M7 3h7l4 4v14H6V3h1m7 0v5h4M9 12h6m-6 4h4'),
  table: [['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }], ...paths('M3 10h18M9 10v10m6-10v10')],
  compare: [['rect', { x: 3, y: 5, width: 7, height: 14, rx: 2 }], ['rect', { x: 14, y: 5, width: 7, height: 14, rx: 2 }], ...paths('M6 9h1m10 0h1M6 13h1m10 0h1')],
  edit: paths('M13 5H5v15h15v-8M10 14l1-4 8-8 3 3-8 8-4 1Z'),
  'arrow-right': paths('M5 12h14m-6-6 6 6-6 6'),
  'arrow-up-right': paths('M6 18 18 6M6 6h12v12'),
  'arrow-up': paths('M12 19V5m-6 6 6-6 6 6'),
  'arrow-down': paths('M12 5v14m-6-6 6 6 6-6'),
  'chevron-down': paths('m6 9 6 6 6-6'),
  close: paths('m6 6 12 12M18 6 6 18'),
  cpu: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }], ['rect', { x: 9, y: 9, width: 6, height: 6, rx: 1 }], ...paths('M9 3v3m6-3v3M9 18v3m6-3v3M3 9h3m-3 6h3m12-6h3m-3 6h3')],
  copy: [['rect', { x: 8, y: 8, width: 12, height: 12, rx: 2 }], ...paths('M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3')],
  check: paths('m5 12 4 4L19 6'),
  'alert-circle': [['circle', { cx: 12, cy: 12, r: 9 }], ...paths('M12 7v6m0 4h.01')],
  loader: paths('M20 12a8 8 0 1 1-8-8'),
  pause: paths('M8 5v14M16 5v14'),
  stop: [['rect', { x: 6, y: 6, width: 12, height: 12, rx: 2 }]],
  trash: paths('M3 6h18M9 6V3h6v3M5 6l1 14h12l1-14M10 10v6m4-6v6'),
  eye: [...paths('M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z'), ['circle', { cx: 12, cy: 12, r: 3 }]],
  'eye-off': paths('m3 3 18 18M10.6 5.1A13 13 0 0 1 12 5c6.5 0 10 7 10 7a19 19 0 0 1-3.1 4.1M6.1 6.1A22 22 0 0 0 2 12s3.5 7 10 7a13 13 0 0 0 5-1M10 10a3 3 0 0 0 4 4'),
  'rotate-ccw': paths('M3 10a9 9 0 1 1 2.7 8M3 3v7h7'),
  save: paths('M5 3h12l4 4v14H3V3h2Zm2 0v6h10V3M7 21v-8h10v8'),
  sparkles: paths('m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4L12 3Z'),
} satisfies Record<string, Shape[]>;

export type IconName = keyof typeof icons;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Fixed application artwork only; no page or model markup is parsed. */
export function createIcon(name: IconName, className = ''): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', ['ui-icon', className].filter(Boolean).join(' '));
  for (const [tag, attributes] of icons[name]) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attributes)) shape.setAttribute(key, String(value));
    svg.append(shape);
  }
  return svg;
}

/** Replace declarative icon placeholders while retaining ids and layout classes. */
export function mountIcons(root: ParentNode = document): void {
  for (const placeholder of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = placeholder.dataset.icon;
    if (!name || !Object.hasOwn(icons, name) || placeholder.namespaceURI === SVG_NS) continue;
    const svg = createIcon(name as IconName, placeholder.className);
    for (const { name: key, value } of placeholder.attributes) {
      if (key !== 'class' && key !== 'aria-hidden' && key !== 'focusable') svg.setAttribute(key, value);
    }
    placeholder.replaceWith(svg);
  }
}
