// ==UserScript==
// @name         Rainbow Filter
// @namespace    https://github.com/Timi-Duban/rainbow-filter
// @version      3.3.0
// @description  Filtre les résultats de recherche par combinaisons de couleurs (ET), avec nuances configurables.
// @homepageURL  https://github.com/Timi-Duban/rainbow-filter
// @updateURL    https://raw.githubusercontent.com/Timi-Duban/rainbow-filter/main/rainbow-filter.user.js
// @downloadURL  https://raw.githubusercontent.com/Timi-Duban/rainbow-filter/main/rainbow-filter.user.js
// @match        https://www.vinted.fr/*
// @match        https://www.vinted.be/*
// @match        https://www.vinted.lu/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // Vinted answers 429 after ~55 quick requests and recovers in under a minute
  const CONCURRENCY = 1;
  const DELAY_MS = 700;
  const BACKOFF_MS = 60_000;
  const CACHE_KEY = 'vinted-rainbow:colors';
  const SETTINGS_KEY = 'vinted-rainbow:settings';
  const TAB_KEY = 'vinted-rainbow:tab';
  const CHIP_SELECTOR = '[data-testid^="catalog--selected-filter-colorIds-"][data-testid$="--text"]';
  const CARD_SELECTOR = '[data-testid="grid-item"]';
  // Sellers can pick at most 2 colors, so a 3-color combination never matches
  const MAX_ITEM_COLORS = 2;

  /** Vinted color labels (as shown on item pages) with a swatch for the panel. */
  const COLORS = {
    'Noir': '#111', 'Gris': '#9e9e9e', 'Blanc': '#fff', 'Crème': '#f3e9d2', 'Beige': '#d8c3a5',
    'Abricot': '#f8b878', 'Orange': '#f57c00', 'Corail': '#ff7f6a', 'Rouge': '#d32f2f', 'Bordeaux': '#7b1e2b',
    'Fuchsia': '#e91e63', 'Rose': '#f8bbd0', 'Violet': '#7b1fa2', 'Lila': '#c8a2c8', 'Bleu clair': '#90caf9',
    'Bleu': '#1e63d6', 'Marine': '#1a237e', 'Turquoise': '#26c6da', 'Menthe': '#a8e6cf', 'Vert': '#43a047',
    'Vert foncé': '#1b5e20', 'Kaki': '#78866b', 'Marron': '#6d4c41', 'Moutarde': '#d4a017', 'Jaune': '#fdd835',
    'Argenté': '#c0c0c0', 'Doré': '#d4af37',
    'Multicolore': 'conic-gradient(#e53935,#fdd835,#43a047,#1e88e5,#8e24aa,#e53935)', 'Transparence': 'transparent',
  };

  /** Default shades: a required color also accepts these when "nuances" is on. */
  const DEFAULT_SHADES = {
    'Blanc': ['Crème'], 'Beige': ['Crème'], 'Gris': ['Argenté'], 'Orange': ['Abricot', 'Corail'],
    'Rouge': ['Bordeaux'], 'Rose': ['Fuchsia'], 'Fuchsia': ['Rose'], 'Violet': ['Lila'],
    'Bleu': ['Bleu clair', 'Marine', 'Turquoise'], 'Vert': ['Vert foncé', 'Menthe', 'Kaki'], 'Jaune': ['Moutarde'],
  };

  /**
   * @typedef {{ enabled: boolean, shades: boolean, combos: string[][], shadeMap: Record<string, string[]> }} Settings
   */

  // Shade preferences persist across tabs; the filter itself (enabled, combos) lives per tab and starts off
  /** @type {Settings} */
  const settings = { enabled: false, shades: false, combos: [], shadeMap: structuredClone(DEFAULT_SHADES) };
  try {
    const { shades = false, shadeMap = settings.shadeMap } = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    const { enabled = false, combos = [] } = JSON.parse(sessionStorage.getItem(TAB_KEY) || '{}');
    Object.assign(settings, { shades, shadeMap, enabled, combos });
  } catch { /* blocked storage */ }
  settings.combos = settings.combos.filter((combo) => combo.length <= MAX_ITEM_COLORS);
  const saveSettings = () => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ shades: settings.shades, shadeMap: settings.shadeMap }));
      sessionStorage.setItem(TAB_KEY, JSON.stringify({ enabled: settings.enabled, combos: settings.combos }));
    } catch { /* blocked storage */ }
  };

  // --- Cache (memoization): itemId -> color labels, kept for the tab session ---
  /** @type {Record<string, string[]>} */
  let cache = {};
  try { cache = JSON.parse(sessionStorage.getItem(CACHE_KEY) || '{}'); } catch { cache = {}; }
  const saveCache = () => { try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* quota or blocked */ } };

  const norm = (s) => s.trim().toLowerCase();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Color labels of the active Vinted filter chips, e.g. ["Bleu", "Rouge"]. */
  const vintedColors = () => [...document.querySelectorAll(CHIP_SELECTOR)].map((e) => (e.textContent || '').trim());

  /** Combinations to apply: the user's own, else the Vinted filter as one combination. */
  const activeCombos = () => {
    if (settings.combos.length) return settings.combos;
    const chips = vintedColors();
    return chips.length === MAX_ITEM_COLORS ? [chips] : [];
  };

  /** @param {string} color */
  const accepted = (color) => new Set([color, ...(settings.shades ? settings.shadeMap[color] || [] : [])].map(norm));

  /** Strategy: an item matches if it satisfies at least one combination (OR of ANDs). @param {string[]} itemColors */
  const matches = (itemColors, combos) =>
    combos.some((combo) => combo.every((color) => { const ok = accepted(color); return itemColors.some((c) => ok.has(c)); }));

  /** @param {HTMLElement} card */
  const itemOf = (card) => {
    const a = card.querySelector('a[href*="/items/"]');
    const m = a?.getAttribute('href')?.match(/\/items\/(\d+)/);
    return m ? { id: m[1], url: new URL(a.getAttribute('href'), location.origin).pathname } : null;
  };

  /** @param {string} url @returns {Promise<string[]>} */
  const fetchColors = async (url) => {
    const res = await fetch(url, { credentials: 'include' });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    const text = doc.querySelector('[itemprop="color"]')?.textContent || '';
    return text.split(',').map(norm).filter(Boolean);
  };

  // --- Work queue (producer/consumer): cards are queued, a worker fetches their colors ---
  /** @type {Map<string, { url: string }>} */
  const queue = new Map();
  let running = 0;
  let paused = false;

  const pump = async () => {
    while (running < CONCURRENCY && queue.size > 0 && !paused) {
      const [id, { url }] = queue.entries().next().value;
      queue.delete(id);
      running++;
      try {
        cache[id] = await fetchColors(url);
        saveCache();
        applyFilter();
      } catch (e) {
        if (e.status === 403 || e.status === 429) {
          paused = true;
          resumeAt = Date.now() + BACKOFF_MS;
          queue.set(id, { url });
          setTimeout(() => { paused = false; pump(); }, BACKOFF_MS);
        }
      }
      await sleep(DELAY_MS);
      running--;
    }
    applyFilter();
  };

  // --- View helpers ---
  /** Tiny element factory. @param {string} tag @param {Record<string, unknown>} [props] @param {...(Node|string)} children */
  const h = (tag, props = {}, ...children) => {
    const el = Object.assign(document.createElement(tag), props);
    el.append(...children);
    return el;
  };

  const RAINBOW = 'linear-gradient(90deg,#e53935,#fb8c00,#fdd835,#43a047,#1e88e5,#8e24aa)';
  // Deeper stops keep white text above 4.5:1 contrast
  const RAINBOW_DEEP = 'linear-gradient(90deg,#c62828,#bf360c,#8d6e00,#2e7d32,#1565c0,#6a1b9a)';
  const CSS = `
    .vr{position:fixed;z-index:2147483647;font:13px/1.4 "Avenir Next","Helvetica Neue",Arial,sans-serif;color:#f2f2f2;background:#1c1c1e;outline:none}
    .vr *{box-sizing:border-box}
    .vr button{font:inherit;color:inherit;background:none;border:none;padding:0;cursor:pointer}
    .vr-tab{right:0;top:50%;transform:translateY(-50%);width:64px;border-radius:12px 0 0 12px;padding:10px 6px 12px;text-align:center;box-shadow:-4px 0 18px rgba(0,0,0,.3);cursor:pointer;overflow:hidden}
    .vr-tab.mini{width:36px;padding:8px 0;font-size:18px;line-height:1;opacity:.85}
    .vr-tab .found{font-size:22px;font-weight:700;line-height:1.1;margin-top:6px}
    .vr-tab small{display:block;color:#aaa;font-size:10px}
    .vr-drawer{right:0;top:0;bottom:0;width:340px;box-shadow:-6px 0 24px rgba(0,0,0,.3);overflow:auto}
    .vr-line{height:4px;background:${RAINBOW}}
    .vr-in{padding:16px 18px 24px}
    .vr-hd{display:flex;align-items:center;gap:10px;font-weight:700;font-size:16px}
    .vr-hd .t{flex:1}
    .vr .vr-x{color:#aaa;font-size:18px}
    .vr-sw{width:34px;height:20px;border-radius:10px;background:#48484a;position:relative;flex:none}
    .vr-sw::after{content:"";position:absolute;left:2px;top:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
    .vr-sw.on{background:linear-gradient(90deg,#43a047,#1e88e5)}
    .vr-sw.on::after{left:16px}
    .vr-big{margin-top:14px;color:#aaa;font-size:12px;display:flex;justify-content:space-between;align-items:flex-end}
    .vr-big b{display:block;font-size:26px;color:#fff;line-height:1.1}
    .vr-pb{height:6px;border-radius:3px;background:#333;margin-top:8px;overflow:hidden}
    .vr-pb i{display:block;height:100%;border-radius:3px;background:${RAINBOW};transition:width .3s}
    .vr-tab .vr-pb{height:4px;margin-top:8px}
    .vr-warn{margin-top:10px;background:#3a2d12;color:#ffc857;border-radius:6px;padding:7px 10px;font-size:12px}
    .vr-dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#ffc857;margin-top:6px}
    .vr-info{margin-top:14px;color:#aaa;font-size:12px}
    .vr-step{margin-top:16px}
    .vr-h5{font-size:12px;color:#aaa;font-weight:600;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center}
    .vr-n{display:inline-block;width:18px;height:18px;border-radius:50%;background:#333;color:#fff;text-align:center;line-height:18px;margin-right:6px}
    .vr-chips{display:flex;flex-wrap:wrap;gap:5px}
    .vr-c{border:1px solid #3a3a3c !important;border-radius:14px;padding:2px 8px !important;font-size:12px !important;display:inline-flex;gap:5px;align-items:center;color:#ddd !important}
    .vr-c.on{border-color:#fff !important;background:#2c2c2e !important;color:#fff !important;font-weight:600}
    .vr-d{width:10px;height:10px;border-radius:50%;border:1px solid #555;display:inline-block;flex:none}
    .vr-pv{margin-top:14px;color:#aaa;font-size:12px}
    .vr .vr-btn{display:block;width:100%;margin-top:10px;padding:11px !important;border-radius:8px;text-align:center;font-weight:700;font-size:14px;background:${RAINBOW_DEEP} !important;color:#fff !important;text-shadow:0 1px 2px rgba(0,0,0,.5)}
    .vr .vr-btn:disabled{background:#333 !important;color:#777 !important;text-shadow:none;cursor:default}
    .vr-big .vr-found{color:#fff;font-weight:600;font-size:13px}
    .vr-sec{margin-top:18px;border-top:1px solid #333;padding-top:14px}
    .vr-lk{color:#64b5f6 !important;font-size:12px;font-weight:600}
    .vr-row{display:flex;justify-content:space-between;align-items:center}
    .vr-muted{color:#888;font-size:11px;margin-top:6px}
    .vr select{font:inherit;background:#2c2c2e;color:#fff;border:1px solid #3a3a3c;border-radius:6px;padding:4px 6px;margin:8px 0}
  `;
  document.head.append(h('style', { textContent: CSS }));

  /** @param {string} color */
  const dot = (color) => h('span', { className: 'vr-d', style: `background:${COLORS[color] || '#eee'}` });

  /** @param {string[]} combo */
  const comboLabel = (combo) => combo.flatMap((c, i) => [...(i ? [' + '] : []), dot(c), c]);

  /** @param {boolean} on @param {() => void} onToggle */
  const switchBtn = (on, onToggle, label) => {
    const btn = h('button', { type: 'button', className: `vr-sw${on ? ' on' : ''}`, title: label, ariaLabel: label, ariaPressed: String(on) });
    btn.addEventListener('click', onToggle);
    return btn;
  };

  /**
   * Reusable color picker: toggles colors in `selected`, calls onChange.
   * @param {Set<string>} selected @param {() => void} onChange @param {{ exclude?: string[] }} [opts]
   */
  const colorGrid = (selected, onChange, { exclude = [] } = {}) => h('div', { className: 'vr-chips' },
    ...Object.keys(COLORS).filter((c) => !exclude.includes(c)).map((c) => {
      const btn = h('button', { type: 'button', className: `vr-c${selected.has(c) ? ' on' : ''}` }, dot(c), c);
      btn.addEventListener('click', () => { selected.has(c) ? selected.delete(c) : selected.add(c); btn.classList.toggle('on'); onChange(); });
      return btn;
    }));

  // --- UI state (not persisted): drawer open, builder selections, shade editor ---
  let open = false;
  const first = new Set();
  const second = new Set();
  /** @type {string | null | undefined} undefined = shade editor closed, null = open with no color picked */
  let shadeColor;
  let resumeAt = 0;

  const panel = h('div', { tabIndex: -1 });
  const update = () => { saveSettings(); renderPanel(); scan(); };

  /** @param {string[]} combo */
  const comboKey = (combo) => [...combo].sort().join('+');

  /** Every pair first × second (or each first color alone when second is empty), minus existing ones. */
  const draftCombos = () => {
    const existing = new Set(settings.combos.map(comboKey));
    /** @type {Map<string, string[]>} */
    const out = new Map();
    for (const a of first) {
      for (const combo of second.size ? [...second].filter((b) => b !== a).map((b) => [a, b]) : [[a]]) {
        const key = comboKey(combo);
        if (!existing.has(key)) out.set(key, combo);
      }
    }
    return [...out.values()];
  };

  const addDraftCombos = () => {
    const combos = draftCombos();
    if (!combos.length) return;
    settings.combos.push(...combos);
    settings.enabled = true; // adding is an explicit request to filter
    first.clear();
    second.clear();
    update();
    panel.focus({ preventScroll: true }); // re-render dropped the focused button: keep Enter/Escape working
  };

  /** @param {boolean} value */
  const setOpen = (value) => { open = value; renderPanel(); if (open) panel.focus({ preventScroll: true }); };

  // Enter adds, Escape folds; preventDefault stops Enter from also "clicking" the focused color button
  document.addEventListener('keydown', (e) => {
    if (!open) return;
    const focus = document.activeElement;
    if (focus !== document.body && !panel.contains(focus)) return;
    if (e.key === 'Enter' && focus?.tagName !== 'SELECT') { e.preventDefault(); addDraftCombos(); }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
  }, true);

  // Fold the drawer when clicking on the page
  document.addEventListener('mousedown', (e) => { if (open && !panel.contains(/** @type {Node} */ (e.target))) setOpen(false); }, true);

  // --- Live status: nodes kept across re-renders, updated by applyFilter ---
  const stat = {
    count: h('b'), bar: h('i'), found: h('span', { className: 'vr-found' }), warn: h('div', { className: 'vr-warn' }),
    tabFound: h('div', { className: 'found' }), tabLabel: h('small'), tabCount: h('small'), tabBar: h('i'), tabDot: h('span', { className: 'vr-dot' }),
  };
  let progress = { analysed: 0, total: 0, shown: 0, active: false };

  const renderStatus = () => {
    const { analysed, total, shown, active } = progress;
    const pct = total ? Math.round((analysed / total) * 100) : 0;
    stat.count.textContent = active ? `${analysed} / ${total}` : '–';
    stat.bar.style.width = `${active ? pct : 0}%`;
    const label = `trouvé${shown > 1 ? 's' : ''}`;
    stat.found.textContent = active ? `${shown} ${label}` : '';
    stat.tabFound.textContent = active ? String(shown) : '–';
    stat.tabLabel.textContent = label;
    stat.tabCount.textContent = active ? `${analysed}/${total}` : 'inactif';
    stat.tabBar.style.width = stat.bar.style.width;
    const wait = Math.max(0, Math.ceil((resumeAt - Date.now()) / 1000));
    stat.warn.textContent = `Vinted limite les requêtes — reprise dans ${wait} s`;
    stat.warn.style.display = paused && active ? '' : 'none';
    stat.tabDot.style.display = paused && active ? '' : 'none';
  };
  setInterval(() => { if (paused) renderStatus(); }, 1000);

  const renderTab = () => {
    panel.onclick = () => setOpen(true);
    if (!settings.enabled) {
      panel.className = 'vr vr-tab mini';
      panel.title = 'Rainbow Filter (désactivé)';
      panel.replaceChildren('🌈');
      return;
    }
    panel.className = 'vr vr-tab';
    panel.title = 'Ouvrir Rainbow Filter';
    panel.replaceChildren(h('div', {}, '🌈'), stat.tabFound, stat.tabLabel, h('div', { className: 'vr-pb' }, stat.tabBar), stat.tabCount, stat.tabDot);
  };

  const renderDrawer = () => {
    panel.className = 'vr vr-drawer';
    panel.title = '';
    panel.onclick = null;

    const close = h('button', { type: 'button', className: 'vr-x', title: 'Replier (Échap)' }, '✕');
    close.addEventListener('click', () => setOpen(false));
    const header = h('div', { className: 'vr-hd' }, h('span', { className: 't' }, '🌈 Rainbow Filter'),
      h('span', { style: 'font-size:12px;font-weight:400;color:#aaa' }, 'Filtrer'),
      switchBtn(settings.enabled, () => { settings.enabled = !settings.enabled; update(); }, 'Filtrer les couleurs'), close);

    const analysis = h('div', { className: 'vr-big' }, h('div', {}, 'Analyse', stat.count), stat.found);

    // Where the active combinations come from when the user has none
    const chips = vintedColors();
    const info = settings.combos.length ? [] : [h('div', { className: 'vr-info' }, chips.length === MAX_ITEM_COLORS
      ? h('span', {}, 'Filtre Vinted : ', ...comboLabel(chips))
      : chips.length > MAX_ITEM_COLORS
        ? `${chips.length} couleurs cochées sur Vinted, mais un article en a ${MAX_ITEM_COLORS} au plus : ajoutez des combinaisons.`
        : 'Choisissez des couleurs ci-dessous, ou cochez 2 couleurs sur Vinted.')];

    // Builder: Couleur 1 × Couleur 2
    const add = h('button', { type: 'button', className: 'vr-btn' });
    const preview = h('div', { className: 'vr-pv' });
    const refresh = () => {
      const draft = draftCombos();
      add.disabled = draft.length === 0;
      add.textContent = draft.length ? `Ajouter ${draft.length} combinaison${draft.length > 1 ? 's' : ''}` : 'Ajouter';
      preview.textContent = draft.length
        ? `${[...first].join(', ')}${second.size ? ` × ${[...second].join(', ')}` : ''} → ${draft.length} combinaison${draft.length > 1 ? 's' : ''}`
        : first.size ? 'Rien de nouveau à ajouter.' : 'Choisissez au moins une couleur 1.';
    };
    add.addEventListener('click', addDraftCombos);
    const step = (n, label, grid) => h('div', { className: 'vr-step' },
      h('div', { className: 'vr-h5' }, h('span', {}, h('span', { className: 'vr-n' }, String(n)), label)), grid);
    refresh();

    // Active combinations
    const active = h('div', { className: 'vr-sec' });
    if (settings.combos.length) {
      const clear = h('button', { type: 'button', className: 'vr-lk' }, 'Tout effacer');
      clear.addEventListener('click', () => { settings.combos = []; update(); });
      active.append(h('div', { className: 'vr-h5' }, h('span', {}, 'Combinaisons actives'), clear),
        h('div', { className: 'vr-chips' }, ...settings.combos.map((combo, i) => {
          const del = h('button', { type: 'button', title: 'Supprimer', style: 'color:#888' }, '✕');
          del.addEventListener('click', () => { settings.combos.splice(i, 1); update(); });
          return h('span', { className: 'vr-c on' }, ...comboLabel(combo), del);
        })));
    } else {
      active.append(h('div', { className: 'vr-h5' }, 'Combinaisons actives'), h('div', { className: 'vr-muted' }, 'Aucune pour l’instant.'));
    }

    // Shades
    const edit = h('button', { type: 'button', className: 'vr-lk' }, shadeColor === undefined ? 'Modifier' : 'Fermer');
    edit.addEventListener('click', () => { shadeColor = shadeColor === undefined ? null : undefined; renderPanel(); });
    const shades = h('div', { className: 'vr-sec' },
      h('div', { className: 'vr-row' },
        h('span', { style: 'display:flex;align-items:center;gap:8px' },
          switchBtn(settings.shades, () => { settings.shades = !settings.shades; update(); }, 'Inclure les nuances'), 'Inclure les nuances'),
        edit),
      h('div', { className: 'vr-muted' }, Object.entries(settings.shadeMap).filter(([, s]) => s.length)
        .map(([c, s]) => `${c} → ${s.join(', ')}`).join(' · ') || 'Aucune nuance définie.'));
    if (shadeColor !== undefined) {
      const pick = h('select', {}, h('option', { value: '' }, 'Choisir une couleur…'),
        ...Object.keys(COLORS).map((c) => h('option', { value: c, selected: c === shadeColor }, c)));
      pick.addEventListener('change', () => { shadeColor = pick.value || null; renderPanel(); });
      const reset = h('button', { type: 'button', className: 'vr-lk' }, 'Réinitialiser');
      reset.addEventListener('click', () => { settings.shadeMap = structuredClone(DEFAULT_SHADES); update(); });
      shades.append(pick);
      if (shadeColor) {
        const color = shadeColor;
        const selected = new Set(settings.shadeMap[color] || []);
        shades.append(h('div', { className: 'vr-muted', style: 'margin-bottom:8px' }, `Nuances acceptées pour ${color} :`),
          colorGrid(selected, () => { settings.shadeMap[color] = [...selected]; update(); }, { exclude: [color] }));
      }
      shades.append(h('div', { style: 'margin-top:8px' }, reset));
    }

    panel.replaceChildren(h('div', { className: 'vr-line' }), h('div', { className: 'vr-in' },
      header, analysis, h('div', { className: 'vr-pb' }, stat.bar), stat.warn, ...info,
      step(1, 'Couleur 1', colorGrid(first, refresh)),
      step(2, 'Couleur 2 (facultatif)', colorGrid(second, refresh)),
      preview, add, active, shades));
  };

  const renderPanel = () => { (open ? renderDrawer : renderTab)(); renderStatus(); };

  const onSearchPage = () => location.pathname.startsWith('/catalog');

  const applyFilter = () => {
    const combos = activeCombos();
    const active = onSearchPage() && settings.enabled && combos.length > 0;
    let shown = 0, analysed = 0, total = 0;

    for (const card of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll(CARD_SELECTOR))) {
      const item = itemOf(card);
      if (!item) continue;
      total++;
      const colors = cache[item.id];
      let visible = true;
      card.style.opacity = '';
      if (active) {
        if (!colors) card.style.opacity = '0.35';
        else { analysed++; visible = matches(colors, combos); }
      }
      card.style.display = visible ? '' : 'none';
      if (active && visible && colors) shown++;
    }

    progress = { analysed, total, shown, active };
    renderStatus();
  };

  const scan = () => {
    const search = onSearchPage();
    panel.style.display = search ? '' : 'none';
    if (!search) queue.clear();
    else if (settings.enabled && activeCombos().length) {
      for (const card of document.querySelectorAll(CARD_SELECTOR)) {
        const item = itemOf(/** @type {HTMLElement} */ (card));
        if (item && !cache[item.id] && !queue.has(item.id)) queue.set(item.id, { url: item.url });
      }
      pump();
    }
    applyFilter();
  };

  // --- Observer: Vinted is a SPA, re-scan when results or filters change ---
  let timer = 0;
  let lastChips = '';
  new MutationObserver((mutations) => {
    if (mutations.every((m) => panel.contains(m.target))) return;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      const chips = vintedColors().join('|');
      if (chips !== lastChips) { lastChips = chips; if (open) renderPanel(); }
      scan();
    }, 300);
  }).observe(document.body, { childList: true, subtree: true });

  document.body.appendChild(panel);
  lastChips = vintedColors().join('|');
  renderPanel();
  scan();
})();
