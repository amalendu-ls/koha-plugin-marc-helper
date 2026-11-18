/*
  Koha MARC Helper - the panel on Koha's Add MARC record page.
  Copyright (C) 2026 Amalendu Das. GPL v3 or later, see LICENSE.

  It reuses the browser extension's own code without changes:
  - background.js searches the sources and builds the record; here it gets the relay
    (the Koha server fetches from the approved sources) instead of direct web access,
    and the library's settings from the server instead of browser storage;
  - content.js fills the Koha form, which is on this same page.
  marc-parser.js, marcxml.js, marc-tools.js and marc-labels.js are loaded as page scripts.

  On the batch cataloguing page (Tools) the same panel edits one queued record at a time
  (mode 'batch': no Fill tab; openRecord, searchFor and recordFromBook are used by batch.js).

  The panel is docked on the right and moves the Koha form aside; it has four tabs:
  Search, Record (editor with Check record, Check headings and AI Helper), Fill (preview of what goes into the form)
  and Export. The settings page uses the same engine for "Test sources" (testSources).
*/
window.MarcHelper = (function () {
  'use strict';

  const API = '/api/v1/contrib/marchelper';
  const CONFIGURE = '/cgi-bin/koha/plugins/run.pl?class=Koha%3A%3APlugin%3A%3AMarcHelper&method=configure';
  const WIDTH_KEY = 'marchelper.width';
  const OPEN_KEY = 'marchelper.open';
  const MIN_WIDTH = 380;
  let VERSION = '';
  let engine = null;   // searchBooks, makeRecord, sourceNames (background.js)
  let filler = null;   // populateFields, getTagBlocks, findSubfieldInput (content.js)
  let settings = {};
  let record = null;
  let problems = [];   // last Check record result
  let checked = false;
  let headings = null; // last Check headings run: [{field, text, lc, local, done}]
  let mode = 'editor'; // 'editor' (Add MARC record page) or 'batch' (batch cataloguing page)
  let batchHooks = {};  // batch mode: {onUse(record), onClose()}
  let ai = null;       // AI Helper box: {picked: Set, results: [{key, state, lines, error}]}
  let aiUrl = '';      // the AI provider's address, reached through /relay (not grouped)
  let fillRows = [];
  const closedGroups = new Set();
  const ui = {};

  // --- Small helpers ------------------------------------------------------------------

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
      if (value === undefined || value === null || value === false) return;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    });
    children.flat().forEach(child => {
      if (child === null || child === undefined || child === false) return;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  const button = (text, onclick, kind = 'default', attrs = {}) =>
    el('button', {type: 'button', class: `mh-btn mh-btn-${kind}`, onclick, ...attrs}, text);
  const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
  const code = field => Object.keys(field)[0];
  const value = field => Object.values(field)[0];

  // A Koha-style alert: kind info | ok | warn | error
  function alert(kind, ...content) {
    const icon = {info: 'ℹ', ok: '✓', warn: '⚠', error: '✗'}[kind];
    return el('div', {class: `mh-alert mh-alert-${kind}`, role: kind === 'error' ? 'alert' : 'status'},
      el('span', {class: 'mh-alert-icon', 'aria-hidden': 'true', text: icon}), el('div', {}, ...content));
  }

  function setMessage(box, kind, ...content) {
    box.textContent = '';
    if (kind) box.append(alert(kind, ...content));
  }

  function emptyState(title, text, ...actions) {
    return el('div', {class: 'mh-empty'},
      el('div', {class: 'mh-empty-title', text: title}), el('p', {text}), actions.length ? el('div', {class: 'mh-row'}, ...actions) : null);
  }

  // Koha's REST API with the staff session cookie; newer Koha versions also want the
  // page's CSRF token on requests that change or send data
  async function api(path, options = {}) {
    const token = document.querySelector('meta[name="csrf-token"]');
    const headers = {Accept: 'application/json', ...(options.body ? {'Content-Type': 'application/json'} : {}),
      ...(token ? {'CSRF-TOKEN': token.content} : {})};
    const response = await window.fetch(API + path, {credentials: 'same-origin', ...options, headers});
    if (response.status === 401 || response.status === 403) {
      throw new Error('You need the cataloguing permission (edit_catalogue) to use Koha MARC Helper.');
    }
    if (!response.ok) throw new Error(`The Koha server answered ${response.status}.`);
    return response.json();
  }

  // --- The relay, in place of the browser's fetch for the search code ------------------

  const cookieJar = {};   // per source host, for sources that keep a session (IndCat)

  function plainHeaders(headers) {
    const out = {};
    if (!headers) return out;
    if (typeof headers.forEach === 'function' && !Array.isArray(headers)) headers.forEach((v, k) => { out[k.toLowerCase()] = v; });
    else Object.entries(headers).forEach(([k, v]) => { out[k.toLowerCase()] = String(v); });
    return out;
  }

  async function relayFetch(input, options = {}) {
    const url = String(input);
    const host = new URL(url).host;
    const headers = plainHeaders(options.headers);
    let body = options.body;
    if (body instanceof URLSearchParams) {
      body = body.toString();
      headers['content-type'] = headers['content-type'] || 'application/x-www-form-urlencoded;charset=UTF-8';
    } else if (body !== undefined && body !== null && typeof body !== 'string') {
      body = String(body);
    }
    const payload = {url, method: options.method || 'GET', headers, body: body === undefined ? null : body, cookies: cookieJar[host] || {}};
    let response;
    try {
      // An AI answer can take a minute: never grouped with the source requests
      const isAi = aiUrl && url.split('?')[0] === aiUrl.split('?')[0];
      response = batchMode && !isAi
        ? await relayQueued(payload)
        : await api('/relay', {method: 'POST', signal: options.signal, body: JSON.stringify(payload)});
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      throw new TypeError(`Relay: ${error.message}`);
    }
    if (response.error) throw new TypeError(response.error);
    (response.cookies || []).forEach(cookie => {
      const pair = cookie.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) (cookieJar[host] = cookieJar[host] || {})[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
    });
    const answerHeaders = response.headers || {};
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: '',
      url: response.url || url,
      headers: {get: name => answerHeaders[String(name).toLowerCase()] ?? null, getSetCookie: () => response.cookies || []},
      text: async () => response.body || '',
      json: async () => JSON.parse(response.body || 'null')
    };
  }

  // On a Koha with few Plack workers, single requests would queue behind each other and
  // time out; there requests made at about the same time go to the server together
  // (relay/batch), which fetches them in parallel within one worker.
  const BATCH_BELOW_WORKERS = 6;
  let batchMode = false;
  const queue = [];
  let flushTimer = null;

  function configureRelay(values) {
    aiUrl = values.aiUrl || '';
    const workers = Number(values.relayWorkers) || 0;
    batchMode = workers > 0 && workers < BATCH_BELOW_WORKERS;
    // Grouped requests answer together, so each source is given more time
    return batchMode ? {...values, providerTimeoutMs: 25000} : values;
  }

  function relayQueued(payload) {
    return new Promise((resolve, reject) => {
      queue.push({payload, resolve, reject});
      if (!flushTimer) flushTimer = setTimeout(flush, 40);
    });
  }

  function flush() {
    flushTimer = null;
    while (queue.length) {
      const items = queue.splice(0, 30);
      api('/relay/batch', {method: 'POST', body: JSON.stringify({requests: items.map(item => item.payload)})})
        .then(answer => items.forEach((item, i) => item.resolve((answer.results || [])[i] || {status: 0, error: 'No answer from the relay'})))
        .catch(error => items.forEach(item => item.reject(error)));
    }
  }

  // The parts of the extension API the shared code uses, kept in memory on this page
  function extensionShim(values) {
    const store = new Map([['kohaMarcSettings', values]]);
    const later = (cb, result) => { if (cb) setTimeout(() => cb(result), 0); };
    return {
      runtime: {lastError: null, onInstalled: {addListener() {}}, onStartup: {addListener() {}}, onMessage: {addListener() {}}},
      storage: {
        local: {
          get(keys, cb) {
            const out = {};
            if (keys === null) store.forEach((v, k) => { out[k] = v; });
            else [].concat(keys).forEach(k => { if (store.has(k)) out[k] = store.get(k); });
            later(cb, out);
          },
          set(items, cb) { Object.entries(items).forEach(([k, v]) => store.set(k, v)); later(cb); },
          remove(keys, cb) { [].concat(keys).forEach(k => store.delete(k)); later(cb); }
        },
        sync: {get(keys, cb) { later(cb, {}); }, remove(keys, cb) { later(cb); }}
      },
      permissions: {contains(query, cb) { later(cb, true); }},
      tabs: {query() {}, sendMessage() {}}
    };
  }

  // The extension's scripts, wrapped by tools/build_kpz.py (engine.js, filler.js): each runs
  // in its own scope with the stand-ins given here and returns the functions it needs
  function startShared(name, values) {
    const make = window.MarcHelperShared && window.MarcHelperShared[name];
    if (typeof make !== 'function') throw new Error(`The ${name} script did not load.`);
    return make(extensionShim(values), relayFetch, undefined);
  }

  // --- MARC text --------------------------------------------------------------------------

  const fieldText = field => (/^00\d$/.test(field.tag)
    ? `${field.tag}    ${field.value || ''}`
    : `${field.tag} ${(field.indicators || [' ', ' ']).map(i => (i === ' ' || !i ? '#' : i)).join('')} ${(field.subfields || []).map(sf => `$${code(sf)} ${value(sf)}`).join(' ')}`);
  const subfieldsText = field => (/^00\d$/.test(field.tag) ? (field.value || '') : (field.subfields || []).filter(sf => value(sf) !== '').map(sf => `$${code(sf)} ${value(sf)}`).join(' '));
  const recordText = rec => sortFields(rec.fields).map(fieldText).join('\n');

  function labels(tag) {
    return (typeof MARC_LABELS !== 'undefined' && MARC_LABELS[String(tag).padStart(3, '0')]) || null;
  }

  // --- Panel frame ------------------------------------------------------------------------

  const ALL_TABS = [['search', 'Search'], ['record', 'Record'], ['fill', 'Fill'], ['export', 'Export']];
  let TABS = ALL_TABS;

  function build() {
    ui.tabs = {};
    ui.bodies = {};
    ui.counts = {};
    const tablist = el('div', {class: 'mh-tabs', role: 'tablist', 'aria-label': 'MARC Helper'});
    TABS.forEach(([id, name]) => {
      ui.counts[id] = el('span', {class: 'mh-count', hidden: true});
      ui.tabs[id] = el('button', {type: 'button', role: 'tab', id: `mh-tab-${id}`, 'aria-controls': `mh-body-${id}`,
        'aria-selected': 'false', tabindex: '-1', onclick: () => selectTab(id)}, name, ui.counts[id]);
      ui.bodies[id] = el('section', {class: 'mh-body', id: `mh-body-${id}`, role: 'tabpanel', 'aria-labelledby': `mh-tab-${id}`, hidden: true});
      tablist.append(ui.tabs[id]);
    });
    tablist.addEventListener('keydown', event => {
      const ids = TABS.map(t => t[0]);
      const at = ids.indexOf(TABS.find(([id]) => ui.tabs[id] === document.activeElement)?.[0]);
      if (at < 0) return;
      const next = {ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: ids.length - 1}[event.key];
      if (next === undefined) return;
      event.preventDefault();
      const id = ids[(next + ids.length) % ids.length];
      selectTab(id);
      ui.tabs[id].focus();
    });

    ui.grip = el('div', {class: 'mh-grip', title: 'Drag to resize', 'aria-hidden': 'true'});
    ui.panel = el('aside', {id: 'marchelper-panel', class: 'mh-panel', 'aria-label': 'Koha MARC Helper', hidden: true},
      ui.grip,
      el('header', {class: 'mh-head'},
        el('div', {class: 'mh-logo', 'aria-hidden': 'true', text: 'M'}),
        el('div', {class: 'mh-title'}, el('h2', {text: 'MARC Helper'}), el('small', {text: 'AACR2 · local rules · nothing guessed'})),
        el('a', {class: 'mh-icon', href: CONFIGURE, target: '_blank', rel: 'noopener', title: 'Settings (opens in a new tab)', 'aria-label': 'Settings'}, '⚙'),
        el('button', {type: 'button', class: 'mh-icon', title: 'Close (Alt+M)', 'aria-label': 'Close panel', onclick: () => toggle(false)}, '✕')),
      tablist,
      ...TABS.map(([id]) => ui.bodies[id]),
      el('footer', {class: 'mh-foot', text: `Koha MARC Helper ${VERSION} · GPL v3`}));
    document.body.append(ui.panel);
    makeResizable();

    // The button goes in Koha's own button row, after "Z39.50/SRU search"
    ui.open = el('button', {type: 'button', class: 'btn btn-default', id: 'marchelper-open', 'aria-controls': 'marchelper-panel',
      'aria-pressed': 'false', title: 'Koha MARC Helper (Alt+M)', onclick: () => toggle()},
      el('i', {class: 'fa fa-book', 'aria-hidden': 'true'}), ' MARC Helper');
    const z3950 = document.querySelector('#z3950search');
    const group = z3950 && z3950.closest('.btn-group');
    const toolbar = document.querySelector('#toolbar');
    if (mode === 'batch') { /* opened from the queue (openRecord) */ }
    else if (group) group.after(el('div', {class: 'btn-group'}, ui.open));
    else if (toolbar) toolbar.append(el('div', {class: 'btn-group'}, ui.open));
    else document.body.append(el('div', {class: 'mh-float'}, ui.open));

    document.addEventListener('keydown', event => {
      if (event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'm' || event.key === 'M' || event.code === 'KeyM')) {
        event.preventDefault();
        toggle();
      }
      if (event.key === 'Escape' && !ui.panel.hidden && ui.panel.contains(document.activeElement) && window.innerWidth < 1100) toggle(false);
    });

    buildSearch();
    showRecordTabs();
    selectTab('search');
  }

  function selectTab(id) {
    TABS.forEach(([tab]) => {
      const on = tab === id;
      ui.tabs[tab].setAttribute('aria-selected', String(on));
      ui.tabs[tab].tabIndex = on ? 0 : -1;
      ui.bodies[tab].hidden = !on;
    });
    if (id === 'record') renderRecord();
    if (id === 'fill') renderFill();
    if (id === 'export') renderExport();
  }

  function setWidth(width) {
    const max = Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.7));
    const w = Math.min(max, Math.max(MIN_WIDTH, Math.round(width)));
    document.documentElement.style.setProperty('--mh-width', `${w}px`);
    return w;
  }

  function makeResizable() {
    setWidth(Number(localStorage.getItem(WIDTH_KEY)) || 540);
    ui.grip.addEventListener('pointerdown', event => {
      event.preventDefault();
      ui.grip.setPointerCapture(event.pointerId);
      document.body.classList.add('mh-resizing');
      const move = e => setWidth(window.innerWidth - e.clientX);
      const up = e => {
        localStorage.setItem(WIDTH_KEY, String(setWidth(window.innerWidth - e.clientX)));
        document.body.classList.remove('mh-resizing');
        ui.grip.removeEventListener('pointermove', move);
        ui.grip.removeEventListener('pointerup', up);
      };
      ui.grip.addEventListener('pointermove', move);
      ui.grip.addEventListener('pointerup', up);
    });
  }

  function toggle(open = ui.panel.hidden) {
    ui.panel.hidden = !open;
    document.body.classList.toggle('mh-docked', open);
    ui.open.setAttribute('aria-pressed', String(open));
    ui.open.classList.toggle('active', open);
    if (mode === 'batch') {
      if (!open && batchHooks.onClose) batchHooks.onClose();
      return;
    }
    sessionStorage.setItem(OPEN_KEY, open ? '1' : '');
    if (open && !ui.bodies.search.hidden) ui.input.focus();
    if (!open) ui.open.focus();
  }

  // --- Search ------------------------------------------------------------------------------

  function buildSearch() {
    ui.input = el('input', {type: 'search', class: 'mh-input', placeholder: 'ISBN, ISSN, title, or title and author', 'aria-label': 'Search', autocomplete: 'off'});
    ui.searchBtn = button('Search', null, 'primary', {type: 'submit'});
    ui.sourcesHead = el('h3', {class: 'mh-sec', hidden: true});
    ui.sources = el('div', {class: 'mh-sources', 'aria-live': 'polite', hidden: true});
    ui.searchMsg = el('div');
    ui.resultsHead = el('h3', {class: 'mh-sec', hidden: true});
    ui.results = el('div', {class: 'mh-results'},
      emptyState('Find a record to copy', 'Search by ISBN (books) or ISSN (journals and other serials) for the most exact match, or by title and author. Library catalogues come first; open sources fill the gaps.'));
    ui.bodies.search.append(
      el('form', {class: 'mh-searchrow', role: 'search', onsubmit: event => { event.preventDefault(); search(); }}, ui.input, ui.searchBtn),
      ui.searchMsg, ui.sourcesHead, ui.sources, ui.resultsHead, ui.results);
  }

  const STATE = {
    searching: ['…', 'searching'],
    found: ['✓', 'found'],
    none: ['–', 'nothing found'],
    failed: ['⚠', 'failed']
  };

  function drawSources(states) {
    const list = Object.entries(states);
    const answered = list.filter(([, s]) => s.state !== 'searching').length;
    ui.sourcesHead.textContent = `Sources · ${answered} of ${list.length} answered`;
    ui.sources.textContent = '';
    list.forEach(([name, s]) => {
      const [mark, word] = STATE[s.state];
      const detail = s.state === 'found' ? plural(s.detail, 'record')
        : s.state === 'failed' ? (/timed out/i.test(s.detail) ? 'timed out' : /quota|429/i.test(s.detail) ? 'quota used' : 'failed')
          : s.state === 'searching' ? 'searching' : `${s.ms} ms`;
      const time = s.ms !== undefined && s.state !== 'none' ? ` · ${(s.ms / 1000).toFixed(1)} s` : '';
      ui.sources.append(el('div', {class: `mh-src mh-src-${s.state}`, title: s.state === 'failed' ? s.detail : `${name}: ${word}`},
        el('span', {class: 'mh-src-mark', 'aria-hidden': 'true', text: mark}),
        el('span', {class: 'mh-src-name', text: name}),
        el('span', {class: 'mh-src-detail', text: s.state === 'none' ? `none${time}` : `${detail}${s.state === 'searching' ? '' : time}`})));
    });
  }

  function skeletons() {
    return [1, 2].map(() => el('div', {class: 'mh-card mh-skeleton', 'aria-hidden': 'true'},
      el('i', {class: 'mh-sk mh-sk-title'}), el('i', {class: 'mh-sk'}), el('i', {class: 'mh-sk mh-sk-short'})));
  }

  async function search() {
    const query = ui.input.value.trim();
    if (!query) { setMessage(ui.searchMsg, 'warn', 'Type an ISBN, an ISSN, a title, or a title and author.'); ui.input.focus(); return; }
    if (!engine) return;
    setMessage(ui.searchMsg);
    ui.searchBtn.disabled = true;
    ui.searchBtn.textContent = 'Searching…';
    ui.results.textContent = '';
    ui.results.append(...skeletons());
    ui.resultsHead.hidden = true;
    ui.sourcesHead.hidden = false;
    ui.sources.hidden = false;
    const states = {};
    const started = {};
    const onProgress = (name, state, detail) => {
      if (state === 'searching') started[name] = performance.now();
      states[name] = {state, detail, ms: state === 'searching' ? undefined : Math.round(performance.now() - (started[name] || performance.now()))};
      drawSources(states);
    };
    try {
      const response = await engine.searchBooks(query, onProgress);
      showResults(response.results || [], response.warnings || []);
      // A wrong check digit is usually a typing error; a record found must be compared with the book
      const digits = query.replace(/[\s-]/g, '').toUpperCase();
      if (/^(97[89]\d{10}|\d{9}[\dX])$/.test(digits) && typeof isbnValid === 'function' && !isbnValid(digits)) {
        ui.searchMsg.prepend(alert('warn', el('b', {text: 'The ISBN check digit is wrong.'}),
          ' Check the number typed, and compare any record below with the book before using it.'));
      }
      if (/^\s*(?:issn\s*:?\s*)?\d{4}[\s-]?\d{3}[\dXx]\s*$/i.test(query) && typeof issnValid === 'function' && !issnValid(query)) {
        ui.searchMsg.prepend(alert('warn', el('b', {text: 'The ISSN check digit is wrong.'}),
          ' Check the number typed, and compare any record below with the journal before using it.'));
      }
    } catch (error) {
      ui.results.textContent = '';
      setMessage(ui.searchMsg, 'error', `Search failed: ${error.message}`);
    } finally {
      ui.searchBtn.disabled = false;
      ui.searchBtn.textContent = 'Search';
    }
  }

  function showResults(results, warnings) {
    ui.results.textContent = '';
    ui.counts.search.hidden = !results.length;
    ui.counts.search.textContent = String(results.length);
    if (warnings.length) {
      setMessage(ui.searchMsg, 'warn', el('details', {},
        el('summary', {text: `${plural(warnings.length, 'source')} did not answer. The results below are from the others.`}),
        el('ul', {}, warnings.map(w => el('li', {text: w})))));
    }
    if (!results.length) {
      ui.resultsHead.hidden = true;
      ui.results.append(emptyState('No record found', 'Check the ISBN, or try the title with the author’s surname. You can also start a blank record and type it yourself.',
        button('Start a blank record', () => useRecord({leader: '', fields: []}), 'default')));
      return;
    }
    ui.resultsHead.hidden = false;
    ui.resultsHead.textContent = plural(results.length, 'result');
    results.slice(0, 30).forEach((book, i) => ui.results.append(resultCard(book, i === 0)));
  }

  // The key fields a good copy record has; the meter shows how many this result gives
  const KEY_FIELDS = [
    ['ISBN or ISSN (020/022)', rec => has(rec, '020', 'a') || has(rec, '022', 'a')],
    ['Class number (082)', rec => has(rec, '082', 'a')],
    ['Main entry (1XX)', rec => rec.fields.some(f => /^1\d\d$/.test(f.tag))],
    ['Title (245)', rec => has(rec, '245', 'a')],
    ['Publisher (260/264 $b)', rec => has(rec, '260', 'b') || has(rec, '264', 'b')],
    ['Date (260/264 $c)', rec => has(rec, '260', 'c') || has(rec, '264', 'c')],
    ['Extent (300)', rec => has(rec, '300', 'a')],
    ['Subjects (6XX)', rec => rec.fields.some(f => /^6\d\d$/.test(f.tag))]
  ];
  function has(rec, tag, sub) {
    return rec.fields.some(f => f.tag === tag && (f.subfields || []).some(sf => code(sf) === sub && String(value(sf)).trim()));
  }

  function resultCard(book, best) {
    let built = null;
    try { built = engine.makeRecord(book, settings); } catch (error) { built = null; }
    const present = built ? KEY_FIELDS.map(([name, test]) => [name, test(built)]) : [];
    const score = present.filter(([, ok]) => ok).length;
    const details = [
      (book.authors || []).join('; ') || 'Author not given',
      [book.publisher, book.publishedDate].filter(Boolean).join(', ') || 'Publisher not given',
      book.serial && book.issn ? `ISSN ${book.issn} · serial` : book.isbn ? `ISBN ${book.isbn}` : 'No ISBN'
    ].join(' · ');
    const preview = el('pre', {class: 'mh-marc', hidden: true, text: built ? recordText(built) : 'This result could not be turned into a record.'});
    const previewBtn = button('Preview', () => {
      preview.hidden = !preview.hidden;
      previewBtn.textContent = preview.hidden ? 'Preview' : 'Hide preview';
      previewBtn.setAttribute('aria-expanded', String(!preview.hidden));
    }, 'default', {'aria-expanded': 'false'});
    return el('article', {class: `mh-card${best ? ' mh-card-best' : ''}`},
      el('div', {class: 'mh-card-title'}, book.title || 'Untitled', book.subtitle ? el('small', {text: ` : ${book.subtitle}`}) : null),
      el('div', {class: 'mh-card-meta', text: details}),
      el('div', {class: 'mh-badges'}, String(book.source || 'Unknown source').split(' + ').map(name =>
        el('span', {class: `mh-badge${/Library|Harvard|Princeton|Penn|ANU|IndCat|K10plus|WorldCat/.test(name) ? ' mh-badge-lib' : ''}`, text: name}))),
      built ? el('div', {class: 'mh-meter', title: present.map(([name, ok]) => `${ok ? '✓' : '–'} ${name}`).join('\n')},
        el('span', {text: 'Completeness'}),
        el('span', {class: 'mh-cells', 'aria-hidden': 'true'}, present.map(([, ok]) => el('i', {class: ok ? 'on' : ''}))),
        el('span', {text: `${score} of ${KEY_FIELDS.length} key fields`})) : null,
      preview,
      el('div', {class: 'mh-card-actions'}, previewBtn,
        button('Use this record', () => { if (built) useRecord(built); }, best ? 'primary' : 'default', {disabled: !built})));
  }

  function useRecord(rec) {
    record = rec;
    record.fields = sortFields(record.fields || []);
    problems = checkRecord(record);
    checked = true;
    headings = null;
    ai = null;
    // Batch: a record chosen in Search (or a blank one) replaces the queued item's record
    if (mode === 'batch' && batchHooks.onUse) batchHooks.onUse(record);
    showRecordTabs();
    selectTab('record');
  }

  // Batch mode: edit this queued record (the object itself, so edits stay with the item)
  function openRecord(rec, hooks = {}) {
    batchHooks = hooks;
    record = rec;
    record.fields = sortFields(record.fields || []);
    problems = checkRecord(record);
    checked = true;
    headings = null;
    ai = null;
    if (hooks.query && ui.input) ui.input.value = hooks.query;
    showRecordTabs();
    ui.panel.hidden = false;
    document.body.classList.add('mh-docked');
    selectTab(hooks.tab === 'search' ? 'search' : 'record');
    if (hooks.tab === 'search' && ui.input) ui.input.focus();
  }

  // Batch mode: the search and the record builder, with this Koha's settings
  function searchFor(query, onProgress) {
    if (!engine) return Promise.reject(new Error('Koha MARC Helper has not started.'));
    return engine.searchBooks(query, onProgress);
  }

  function recordFromBook(book) {
    const rec = engine.makeRecord(book, settings);
    rec.fields = sortFields(rec.fields || []);
    return rec;
  }

  function showRecordTabs() {
    const errors = problems.filter(p => p.level === 'error').length;
    ui.counts.record.hidden = !record || !problems.length;
    ui.counts.record.textContent = String(problems.length);
    ui.counts.record.classList.toggle('mh-count-error', errors > 0);
  }

  // --- Record editor ---------------------------------------------------------------------------

  const GROUPS = {
    0: 'Numbers and codes', 1: 'Main entry', 2: 'Title, edition, publication', 3: 'Physical description',
    4: 'Series statement', 5: 'Notes', 6: 'Subjects', 7: 'Added entries', 8: 'Series added entries', 9: 'Local (Koha)'
  };

  function renderRecord() {
    const body = ui.bodies.record;
    body.textContent = '';
    if (!record) {
      body.append(emptyState('No record yet', 'Search for the book and choose “Use this record”, or start a blank record.',
        button('Go to Search', () => selectTab('search'), 'primary'),
        button('Start a blank record', () => useRecord({leader: '', fields: []}), 'default')));
      return;
    }
    const errors = problems.filter(p => p.level === 'error');
    const warnings = problems.filter(p => p.level !== 'error');
    const tags = new Set(record.fields.map(f => f.tag));
    const elsewhere = problems.filter(p => !tags.has(p.tag));
    ui.checkMsg = el('div');
    if (checked) {
      if (!problems.length) ui.checkMsg.append(alert('ok', el('b', {text: 'Check record: no problems found.'})));
      else ui.checkMsg.append(alert(errors.length ? 'error' : 'warn',
        el('b', {text: [errors.length ? plural(errors.length, 'error') : '', warnings.length ? plural(warnings.length, 'warning') : ''].filter(Boolean).join(' and ')}),
        ' from Check record, shown at the fields concerned. Nothing is changed by the check.',
        elsewhere.length ? el('ul', {}, elsewhere.map(p => el('li', {text: `${p.tag}: ${p.text}`}))) : null));
    }
    body.append(
      el('div', {class: 'mh-row'},
        button('✓ Check record', () => { problems = checkRecord(record); checked = true; showRecordTabs(); renderRecord(); }, 'default'),
        button('⚑ Check headings', checkHeadings, 'default', {title: 'Names and subjects against LC and your own authority file'}),
        button('✦ AI Helper', toggleAi, 'default', {title: 'Suggestions for 082, 500, 650 and 246, for review'}),
        el('span', {class: 'mh-grow'}),
        button('＋ Add field', addField, 'default'),
        mode === 'batch'
          ? button('Done: back to the queue', () => toggle(false), 'primary')
          : button('Next: Fill ›', () => selectTab('fill'), 'primary')),
      ui.checkMsg,
      headingsBox() || '',
      aiBox() || '');

    const byGroup = {};
    record.fields.forEach((field, index) => {
      const g = /^\d/.test(field.tag || '') ? field.tag[0] : '?';
      (byGroup[g] = byGroup[g] || []).push([field, index]);
    });
    Object.keys(byGroup).sort().forEach(g => {
      const items = byGroup[g];
      const groupProblems = problems.filter(p => items.some(([f]) => f.tag === p.tag));
      const groupErrors = groupProblems.filter(p => p.level === 'error').length;
      const details = el('details', {class: 'mh-group', open: !closedGroups.has(g)},
        el('summary', {},
          el('span', {text: g === '?' ? 'New fields' : `${g}XX · ${GROUPS[g]}`}),
          el('span', {class: `mh-flag${groupErrors ? ' mh-flag-error' : groupProblems.length ? ' mh-flag-warn' : ''}`,
            text: groupProblems.length ? plural(groupProblems.length, groupErrors ? 'problem' : 'warning') : plural(items.length, 'field')})));
      details.addEventListener('toggle', () => { if (details.open) closedGroups.delete(g); else closedGroups.add(g); });
      const shownFor = new Set();
      items.forEach(([field, index]) => {
        const notes = shownFor.has(field.tag) ? [] : problems.filter(p => p.tag === field.tag);
        shownFor.add(field.tag);
        details.append(fieldEditor(field, index, notes));
      });
      body.append(details);
    });
  }

  function fieldEditor(field, index, notes) {
    const control = /^00\d$/.test(field.tag || '');
    const entry = labels(field.tag);
    const level = notes.some(p => p.level === 'error') ? 'error' : notes.length ? 'warn' : '';
    const tag = el('input', {class: 'mh-tag', value: field.tag || '', maxlength: '3', inputmode: 'numeric', 'aria-label': 'Tag', placeholder: 'Tag'});
    tag.addEventListener('change', () => {
      const t = tag.value.trim();
      const nowControl = /^00\d$/.test(t);
      if (nowControl && !control) record.fields[index] = {tag: t, value: (field.subfields || []).map(value).join(' ')};
      else if (!nowControl && control) record.fields[index] = {tag: t, indicators: [' ', ' '], subfields: [{a: field.value || ''}]};
      else field.tag = t;
      record.fields = sortFields(record.fields);
      renderRecord();
    });
    const del = el('button', {type: 'button', class: 'mh-x', title: `Delete field ${field.tag}`, 'aria-label': `Delete field ${field.tag}`, text: '🗑',
      onclick: () => { record.fields.splice(index, 1); renderRecord(); }});
    const head = el('div', {class: 'mh-fld-head'}, tag);
    const box = el('div', {class: `mh-fld${level ? ` mh-fld-${level}` : ''}`}, head);
    if (control) {
      head.append(el('span', {class: 'mh-fname'}, el('b', {text: entry ? entry.n : 'Control field'})), del);
      const input = el('input', {class: 'mh-val mh-mono', value: field.value || '', 'aria-label': `${field.tag} value`});
      input.addEventListener('input', () => { field.value = input.value; });
      box.append(el('div', {class: 'mh-subs'}, input));
    } else {
      const inds = (field.indicators || [' ', ' ']).map((ind, i) => {
        const input = el('input', {class: 'mh-ind', value: ind === ' ' ? '' : ind, maxlength: '1', placeholder: '#', 'aria-label': `${field.tag} indicator ${i + 1}`, title: `Indicator ${i + 1} (empty = blank)`});
        input.addEventListener('input', () => {
          field.indicators = field.indicators || [' ', ' '];
          field.indicators[i] = input.value.trim() || ' ';
        });
        return input;
      });
      head.append(el('span', {class: 'mh-inds'}, inds), el('span', {class: 'mh-fname'}, el('b', {text: entry ? entry.n : (field.tag ? 'Not in the default framework' : 'New field')})), del);
      const subs = el('div', {class: 'mh-subs'});
      (field.subfields || []).forEach((sf, i) => subs.append(subfieldEditor(field, sf, i, entry)));
      subs.append(el('button', {type: 'button', class: 'mh-add', text: '＋ Add subfield', onclick: () => {
        field.subfields = field.subfields || [];
        field.subfields.push({'': ''});
        renderRecord();
        const inputs = ui.bodies.record.querySelectorAll(`.mh-fld[data-index="${index}"] .mh-code`);
        if (inputs.length) inputs[inputs.length - 1].focus();
      }}));
      box.append(subs);
    }
    box.dataset.index = String(index);
    notes.forEach(p => box.append(el('div', {class: `mh-note mh-note-${p.level === 'error' ? 'error' : 'warn'}`, text: `${p.level === 'error' ? '✗' : '⚠'} ${p.text}`})));
    return box;
  }

  function subfieldEditor(field, sf, i, entry) {
    const c = code(sf);
    const name = c && entry ? (entry.s[c] || 'Not in the default framework') : '';
    const codeInput = el('input', {class: 'mh-code', value: c, maxlength: '1', 'aria-label': `${field.tag} subfield code`, placeholder: '$'});
    const label = el('label', {class: 'mh-sflabel', text: name, title: name});
    const valueInput = el('input', {class: 'mh-val', value: value(sf), 'aria-label': `${field.tag} $${c} ${name}`.trim()});
    codeInput.addEventListener('input', () => {
      const nc = codeInput.value.trim().toLowerCase();
      field.subfields[i] = {[nc]: valueInput.value};
      const n = nc && entry ? (entry.s[nc] || 'Not in the default framework') : '';
      label.textContent = n;
      label.title = n;
    });
    valueInput.addEventListener('input', () => { field.subfields[i] = {[code(field.subfields[i])]: valueInput.value}; });
    return el('div', {class: 'mh-sf'}, el('span', {class: 'mh-dollar', 'aria-hidden': 'true', text: '$'}), codeInput, label, valueInput,
      el('button', {type: 'button', class: 'mh-x', 'aria-label': `Remove $${c}`, title: `Remove $${c}`, text: '×',
        onclick: () => { field.subfields.splice(i, 1); renderRecord(); }}));
  }

  // --- Check headings: LC (id.loc.gov) and the library's own authority file ---------------------

  // The rules (heading forms, LC file, punctuation, $9) are shared with the extension:
  // headingForm, headingLcScheme, writeHeadingForm, headingTextToSubfields, headingWire in marc-tools.js

  async function checkHeadings() {
    const fields = record.fields.filter(isHeadingField);
    const run = fields.map(field => ({field, text: headingForm(field), lc: null, local: null}));
    headings = run;
    renderRecord();
    if (!fields.length) return;
    const local = api('/authorities', {method: 'POST', body: JSON.stringify({headings: fields.map(headingWire)})})
      .then(answer => (answer.results || []).forEach((r, i) => { if (run[i]) run[i].local = r; }))
      .catch(error => run.forEach(h => { h.local = {error: error.message, matches: []}; }));
    const lc = run.map(h => {
      const scheme = headingLcScheme(h.field);
      if (!scheme) {
        h.lc = {status: 'skip', why: `second indicator ${((h.field.indicators || [])[1] || ' ').replace(' ', '#')}: not LCSH`};
        return null;
      }
      return engine.lcshCheck(h.text, scheme).then(r => { h.lc = {...r, scheme}; }).catch(error => { h.lc = {status: 'error', error: error.message}; });
    });
    let pending = true;
    const tick = () => { if (pending && headings === run && !ui.bodies.record.hidden) renderRecord(); if (pending) setTimeout(tick, 800); };
    setTimeout(tick, 800);
    await Promise.all([local, ...lc]);
    pending = false;
    if (headings === run && !ui.bodies.record.hidden) renderRecord();
  }

  const small = (text, onclick, title) => button(text, onclick, 'default', {class: 'mh-btn mh-btn-default mh-btn-xs', title});

  function lcLine(h) {
    const r = h.lc;
    if (!r) return el('div', {class: 'mh-hd-line mh-hd-muted', text: 'LC: checking…'});
    const file = r.scheme === 'subjects' ? 'LCSH' : 'LC names';
    if (r.status === 'skip') return el('div', {class: 'mh-hd-line mh-hd-muted', text: `LC: not checked (${r.why})`});
    if (r.status === 'error') return el('div', {class: 'mh-hd-line mh-hd-warn', text: `LC: could not be checked (${r.error})`});
    if (r.status === 'authorised') {
      return el('div', {class: 'mh-hd-line mh-hd-ok'}, `✓ ${file}: authorised`,
        r.uri ? [' · ', el('a', {href: r.uri, target: '_blank', rel: 'noopener', text: 'id.loc.gov'})] : null);
    }
    if (r.status === 'use') {
      // Replaced only for a heading without subdivisions, where the swap is unambiguous
      const simple = !h.text.includes('--');
      return el('div', {class: 'mh-hd-line mh-hd-warn'}, `↪ ${file}: not used – USE `,
        r.use.map((u, i) => [i ? ' or ' : '', el('b', {text: u}), simple && !u.includes('--')
          ? [' ', small('Use', () => { writeHeadingForm(h.field, headingTextToSubfields(h.field.tag, u)); h.done = `LC form written: ${u}`; h.text = headingForm(h.field); renderRecord(); }, `Write "${u}"`)]
          : null]));
    }
    if (r.status === 'mainOnly') {
      const m = r.main;
      return el('div', {class: 'mh-hd-line mh-hd-warn',
        text: `⚠ ${file}: not listed as a whole; "${m.heading}" is ${m.status === 'authorised' ? 'authorised' : `not used – USE ${(m.use || []).join(' or ')}`}. Check the subdivisions.`});
    }
    return el('div', {class: 'mh-hd-line mh-hd-bad', text: `✗ ${file}: not found. Check it at id.loc.gov.`});
  }

  function localLine(h) {
    const r = h.local;
    if (!r) return el('div', {class: 'mh-hd-line mh-hd-muted', text: 'Your authorities: checking…'});
    if (r.error) return el('div', {class: 'mh-hd-line mh-hd-warn', text: `Your authorities: ${r.error}`});
    if (!r.matches.length) return el('div', {class: 'mh-hd-line mh-hd-muted', text: 'Your authorities: not in your authority file yet'});
    const linked = headingValues(h.field, '9')[0];
    return el('div', {class: 'mh-hd-line'},
      r.via === 'see' ? 'Your authorities: found as a “see from” form; your library uses:' : 'Your authorities:',
      el('ul', {class: 'mh-hd-matches'}, r.matches.map(m => el('li', {},
        el('span', {class: m.same ? 'mh-hd-ok' : ''}, m.same ? '✓ ' : '', el('b', {text: m.heading})),
        el('span', {class: 'mh-hint', text: ` · authority ${m.authid} · used in ${plural(m.usage, 'record')}`}), ' ',
        String(linked) === String(m.authid)
          ? el('span', {class: 'mh-pill mh-pill-same', text: 'linked ($9)'})
          : small(m.same ? 'Link' : 'Use', () => {
            writeHeadingForm(h.field, m.subfields.map(([c, v]) => ({[c]: v})), m.authid);
            h.done = `Your library's form written and linked to authority ${m.authid} ($9).`;
            h.text = headingForm(h.field);
            renderRecord();
          }, `Write this form with $9 ${m.authid}`)))));
  }

  function headingsBox() {
    if (!headings) return null;
    const live = headings.filter(h => record.fields.includes(h.field));
    if (!live.length) return alert('info', 'There are no name or subject headings (100, 110, 111, 600, 610, 611, 650, 651, 700, 710, 711) to check.');
    const busy = live.some(h => !h.local || !h.lc);
    return el('div', {class: 'mh-hd'},
      el('div', {class: 'mh-hd-title'}, el('b', {text: 'Check headings'}),
        el('span', {class: 'mh-hint', text: busy ? ' · checking…' : ' · nothing is changed unless you click Use or Link'}),
        el('span', {class: 'mh-grow'}),
        el('button', {type: 'button', class: 'mh-x', title: 'Close', 'aria-label': 'Close the headings check', text: '✕', onclick: () => { headings = null; renderRecord(); }})),
      live.map(h => el('div', {class: 'mh-hd-item'},
        el('div', {class: 'mh-hd-head'}, el('span', {class: 'mh-tagchip', text: h.field.tag}), el('span', {text: h.text})),
        h.done ? el('div', {class: 'mh-hd-line mh-hd-ok', text: `✓ ${h.done}`}) : null,
        lcLine(h), localLine(h))));
  }

  // --- AI Helper: suggestions for review (the rules are shared with the extension in
  // marc-tools.js; the prompts and providers in background.js, reached through the relay) ---

  const SAMPLE_BOOK = {title: 'Gitanjali', subtitle: 'song offerings', author: 'Tagore, Rabindranath',
    publisher: 'Dover Publications', year: '2000', summary: ''};

  function aiChoices() {
    const nonLatin = aiTitleIsNonLatin(record);
    return AI_FIELD_CHOICES.filter(c => !c.nonLatinOnly || nonLatin);
  }

  function toggleAi() {
    if (ai) { ai = null; renderRecord(); return; }
    const choices = aiChoices();
    ai = {picked: new Set(choices.filter(c => c.checked).map(c => c.key)), results: null};
    renderRecord();
  }

  async function runAi() {
    const keys = aiChoices().map(c => c.key).filter(k => ai.picked.has(k));
    if (!keys.length) return;
    const run = {picked: ai.picked, results: keys.map(key => ({key, state: 'wait', lines: []}))};
    ai = run;
    renderRecord();
    const info = aiBiblioInfo(record);
    const keep = settings.ruleEndingPunctuation === 'keep';
    // One at a time, as the extension does: providers limit requests per minute
    for (const r of run.results) {
      try {
        const text = await engine.handleAiHelper(r.key, info);
        r.lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
          const tag = marcTagForAiKey(r.key);
          return {text: subfieldsToString(aiSubfields(line, tag, keep)) || line, added: false, lcsh: null};
        });
        r.state = r.lines.length ? 'ok' : 'empty';
        if (r.key === '650_lcsh') {
          r.lines.forEach(line => {
            const heading = headingForm({tag: '650', subfields: aiSubfields(line.text, '650', keep)});
            engine.lcshCheck(heading, 'subjects').then(result => { line.lcsh = result; }, error => { line.lcsh = {status: 'error', error: error.message}; })
              .then(() => { if (ai === run && !ui.bodies.record.hidden) renderRecord(); });
          });
        }
      } catch (error) {
        r.state = 'error';
        r.error = error.message;
      }
      if (ai === run && !ui.bodies.record.hidden) renderRecord();
    }
  }

  function lcshMark(result) {
    if (!result) return el('div', {class: 'mh-hd-line mh-hd-muted', text: 'LCSH: checking…'});
    if (result.status === 'authorised') return el('div', {class: 'mh-hd-line mh-hd-ok', text: '✓ LCSH: authorised'});
    if (result.status === 'use') return el('div', {class: 'mh-hd-line mh-hd-warn', text: `↪ LCSH: not used – USE ${result.use.join(' or ')}`});
    if (result.status === 'mainOnly') return el('div', {class: 'mh-hd-line mh-hd-warn', text: `⚠ LCSH: not listed as a whole; "${result.main.heading}" is ${result.main.status === 'authorised' ? 'authorised' : 'not used'}. Check the subdivisions.`});
    if (result.status === 'error') return el('div', {class: 'mh-hd-line mh-hd-warn', text: `LCSH: could not be checked (${result.error})`});
    return el('div', {class: 'mh-hd-line mh-hd-bad', text: '✗ LCSH: not found – check it before adding'});
  }

  function aiBox() {
    if (!ai) return null;
    const close = el('button', {type: 'button', class: 'mh-x', title: 'Close', 'aria-label': 'Close the AI Helper', text: '✕', onclick: () => { ai = null; renderRecord(); }});
    if (!settings.llmProvider) {
      return el('div', {class: 'mh-hd'}, el('div', {class: 'mh-hd-title'}, el('b', {text: 'AI Helper'}), el('span', {class: 'mh-grow'}), close),
        alert('info', 'The AI Helper is off. A Koha administrator can choose an AI provider in ',
          el('a', {href: `${CONFIGURE}&tab=ai`, target: '_blank', rel: 'noopener', text: 'Settings › AI Helper'}), '.'));
    }
    const choices = aiChoices();
    const busy = ai.results && ai.results.some(r => r.state === 'wait');
    const box = el('div', {class: 'mh-hd mh-ai'},
      el('div', {class: 'mh-hd-title'}, el('b', {text: 'AI Helper'}),
        el('span', {class: 'mh-hint', text: ' · suggestions to review; nothing is added unless you click Add'}), el('span', {class: 'mh-grow'}), close),
      el('div', {class: 'mh-ai-opts', role: 'group', 'aria-label': 'Fields to suggest'}, choices.map(c => {
        const box = el('input', {type: 'checkbox', checked: ai.picked.has(c.key)});
        box.addEventListener('change', () => { if (box.checked) ai.picked.add(c.key); else ai.picked.delete(c.key); });
        return el('label', {}, box, ` ${c.label}`);
      })),
      el('div', {class: 'mh-row'}, button(busy ? 'Working…' : 'Run AI Helper', runAi, 'primary', {disabled: busy})));
    (ai.results || []).forEach(r => {
      const name = (AI_FIELD_CHOICES.find(c => c.key === r.key) || {}).label || r.key;
      const item = el('div', {class: 'mh-hd-item'}, el('div', {class: 'mh-hd-head'}, el('span', {text: name})));
      if (r.state === 'wait') item.append(el('div', {class: 'mh-hd-line mh-hd-muted', text: 'Asking the AI…'}));
      else if (r.state === 'error') item.append(el('div', {class: 'mh-hd-line mh-hd-bad', text: `✗ ${r.error}`}));
      else if (r.state === 'empty') item.append(el('div', {class: 'mh-hd-line mh-hd-muted', text: 'No suggestion.'}));
      r.lines.forEach(line => {
        const input = el('input', {class: 'mh-val mh-mono', value: line.text, 'aria-label': `${name} suggestion`, disabled: line.added});
        input.addEventListener('input', () => { line.text = input.value; });
        const add = line.added ? el('span', {class: 'mh-pill mh-pill-same', text: 'added'}) : button('Add', () => {
          const result = addAiSuggestion(record, r.key, line.text, settings);
          if (!result.ok) { line.note = result.message; renderRecord(); return; }
          line.added = true;
          line.note = result.message;
          record.fields = sortFields(record.fields);
          renderRecord();
        }, 'default', {class: 'mh-btn mh-btn-default mh-btn-xs'});
        item.append(el('div', {class: 'mh-ai-line'}, input, add));
        if (line.note) item.append(el('div', {class: `mh-hd-line ${line.added ? 'mh-hd-ok' : 'mh-hd-warn'}`, text: line.note}));
        if (r.key === '650_lcsh') item.append(lcshMark(line.lcsh));
      });
      box.append(item);
    });
    return box;
  }

  function addField() {
    record.fields.push({tag: '', indicators: [' ', ' '], subfields: [{a: ''}]});
    closedGroups.delete('?');
    renderRecord();
    const tags = ui.bodies.record.querySelectorAll('.mh-tag');
    const last = [...tags].find(t => !t.value);
    if (last) last.focus();
  }

  // Fields without an empty tag or code, and without empty subfields
  function cleanRecord(rec) {
    return {...rec, fields: rec.fields
      .filter(f => /^\d{3}$/.test(f.tag || ''))
      .map(f => (/^00\d$/.test(f.tag) ? f : {...f, subfields: (f.subfields || []).filter(sf => code(sf) && String(value(sf)).trim() !== '')}))
      .filter(f => (/^00\d$/.test(f.tag) ? String(f.value || '').trim() : f.subfields.length))};
  }

  // --- Fill: preview, choose, fill ---------------------------------------------------------------

  // What is in the Koha form now for occurrence `index` of `tag`
  function formState(tag, index) {
    const blocks = filler.getTagBlocks(tag);
    const inputs = scope => [...scope.querySelectorAll(`input[id^="tag_${tag}_subfield_"]:not([type="hidden"]), textarea[id^="tag_${tag}_subfield_"], select[id^="tag_${tag}_subfield_"]`)];
    if (!blocks.length) {
      const loose = index === 1 ? inputs(document) : [];
      if (!loose.length) return {state: index === 1 ? 'missing' : 'repeat'};
      const text = loose.filter(i => i.value.trim()).map(i => i.value.trim()).join(' ');
      return {state: text ? 'filled' : 'empty', text};
    }
    if (index > blocks.length) return {state: 'repeat'};
    const block = blocks[index - 1];
    const parts = inputs(block).filter(i => i.value.trim() && i.tagName !== 'SELECT').map(i => {
      const m = i.id.match(new RegExp(`^tag_${tag}_subfield_([a-z0-9@])`));
      return m && m[1] !== '@' ? `$${m[1]} ${i.value.trim()}` : i.value.trim();
    });
    return {state: parts.length ? 'filled' : 'empty', text: parts.join(' ')};
  }

  const normal = text => String(text || '').replace(/\s+/g, ' ').replace(/[\s.,;:/]+$/, '').trim().toLowerCase();

  // Each row's target occurrence depends on which earlier rows of the same tag are chosen
  function planStates() {
    const counts = {};
    fillRows.forEach(row => {
      if (!row.pick.checked) { row.target = null; row.form = null; return; }
      counts[row.field.tag] = (counts[row.field.tag] || 0) + 1;
      row.target = counts[row.field.tag];
      row.form = formState(row.field.tag, row.target);
    });
  }

  function describeRow(row) {
    row.now.textContent = '';
    row.tr.classList.remove('mh-conflict');
    if (!row.pick.checked) { row.now.append(el('span', {class: 'mh-pill mh-pill-skip', text: 'not filled'})); return; }
    const f = row.form;
    if (f.state === 'missing') row.now.append(el('span', {class: 'mh-pill mh-pill-miss', text: 'not in this framework'}));
    else if (f.state === 'repeat') row.now.append(el('span', {class: 'mh-pill mh-pill-new', text: 'added with Repeat'}));
    else if (f.state === 'empty') row.now.append(el('span', {class: 'mh-pill mh-pill-new', text: 'empty'}));
    else if (normal(f.text) === normal(subfieldsText(row.field))) row.now.append(el('span', {class: 'mh-pill mh-pill-same', text: 'already the same'}));
    else {
      row.tr.classList.add('mh-conflict');
      row.now.append(el('span', {class: 'mh-now-text', text: f.text}), ' ', el('span', {class: 'mh-pill mh-pill-over', text: 'will be replaced'}));
    }
  }

  function renderFill() {
    const body = ui.bodies.fill;
    body.textContent = '';
    if (!record) {
      body.append(emptyState('Nothing to fill yet', 'Choose a record in Search first. You will see here what goes into the Koha form before anything is changed.',
        button('Go to Search', () => selectTab('search'), 'primary')));
      return;
    }
    const rec = cleanRecord(record);
    const fields = rec.fields.filter(f => f.tag !== '008');
    if (!fields.length) {
      body.append(emptyState('The record is empty', 'Add fields in the Record tab first.', button('Go to Record', () => selectTab('record'), 'primary')));
      return;
    }
    const all = el('input', {type: 'checkbox', checked: true, 'aria-label': 'All fields'});
    const tbody = el('tbody');
    fillRows = fields.map(field => {
      const pick = el('input', {type: 'checkbox', checked: true, 'aria-label': `Fill ${field.tag}`});
      const now = el('td', {class: 'mh-now'});
      const tr = el('tr', {}, el('td', {}, pick), el('td', {class: 'mh-mono', text: field.tag}), el('td', {class: 'mh-mono mh-from', text: subfieldsText(field)}), now);
      tbody.append(tr);
      return {field, pick, now, tr};
    });
    // Start with fields already in the form unticked; repeat, as unticking moves later occurrences
    for (let pass = 0; pass < fillRows.length; pass++) {
      planStates();
      const clash = fillRows.find(row => row.pick.checked && row.form.state === 'filled');
      if (!clash) break;
      clash.pick.checked = false;
      clash.clash = true;
    }
    planStates();
    // Fields this framework does not have would only be reported as not filled
    fillRows.forEach(row => { if (row.pick.checked && row.form.state === 'missing') row.pick.checked = false; });
    const count = el('span', {class: 'mh-hint'});
    const refresh = () => {
      planStates();
      fillRows.forEach(describeRow);
      const n = fillRows.filter(r => r.pick.checked).length;
      count.textContent = `${n} of ${fillRows.length} fields selected`;
      all.checked = n === fillRows.length;
      all.indeterminate = n > 0 && n < fillRows.length;
      ui.fillBtn.disabled = n === 0;
    };
    fillRows.forEach(row => row.pick.addEventListener('change', refresh));
    all.addEventListener('change', () => { fillRows.forEach(r => { r.pick.checked = all.checked; }); refresh(); });
    const kept = fillRows.filter(r => r.clash).length;
    ui.fillMsg = el('div', {'aria-live': 'polite'});
    ui.fillBtn = button('Fill the Koha form', () => fill(rec), 'primary');
    body.append(
      alert('info', kept
        ? `Choose what goes into the Koha form. ${plural(kept, 'field')} already ${kept === 1 ? 'has' : 'have'} text in the form and ${kept === 1 ? 'is' : 'are'} left unticked, so ${kept === 1 ? 'it is' : 'they are'} not replaced unless you tick ${kept === 1 ? 'it' : 'them'}.`
        : 'Choose what goes into the Koha form. Nothing is changed until you press Fill.'),
      el('div', {class: 'mh-table-wrap'}, el('table', {class: 'mh-fill'},
        el('thead', {}, el('tr', {}, el('th', {}, all), el('th', {text: 'Field'}), el('th', {text: 'From the record'}), el('th', {text: 'Now in the Koha form'}))),
        tbody)),
      el('div', {class: 'mh-sticky'}, count, el('span', {class: 'mh-grow'}), ui.fillBtn),
      ui.fillMsg);
    refresh();
  }

  async function fill(rec, confirmed = false) {
    const chosen = fillRows.filter(r => r.pick.checked).map(r => r.field);
    const found = checkRecord(rec);   // the whole record (008 is not a row, but is part of it)
    const errors = found.filter(p => p.level === 'error');
    if (errors.length && !confirmed) {
      setMessage(ui.fillMsg, 'error', el('b', {text: `Check record found ${plural(errors.length, 'error')}:`}),
        el('ul', {}, errors.map(p => el('li', {text: `${p.tag}: ${p.text}`}))),
        el('div', {class: 'mh-row'}, button('Fill anyway', () => fill(rec, true), 'danger'), button('Cancel', () => setMessage(ui.fillMsg), 'default')));
      return;
    }
    ui.fillBtn.disabled = true;
    ui.fillBtn.textContent = 'Filling…';
    setMessage(ui.fillMsg, 'info', 'Filling the Koha form…');
    try {
      const failed = await filler.populateFields({...rec, fields: chosen});
      const counts = {};
      const jumps = chosen.map(f => { counts[f.tag] = (counts[f.tag] || 0) + 1; return [f.tag, counts[f.tag]]; });
      const links = el('div', {class: 'mh-jumps'}, el('span', {text: 'Go to: '}),
        [...new Map(jumps.map(j => [j.join('/'), j])).values()].map(([tag, n]) =>
          el('button', {type: 'button', class: 'mh-link', text: n > 1 ? `${tag} (${n})` : tag, onclick: () => jumpTo(tag, n)})));
      if (failed.length) {
        setMessage(ui.fillMsg, 'warn', el('b', {text: `Koha form filled, but ${plural(failed.length, 'part')} could not be placed:`}),
          el('ul', {}, failed.map(text => el('li', {text}))),
          'Those subfields are hidden or missing in this framework, or the tag has no “Repeat this tag” button. Add them by hand, then Save.', links);
      } else {
        setMessage(ui.fillMsg, 'ok', el('b', {text: `${plural(chosen.length, 'field')} filled`}), ' and highlighted in green. Check the form, then Save.', links);
      }
      fillRows.forEach(row => { if (row.pick.checked) row.form = formState(row.field.tag, row.target); describeRow(row); });
    } catch (error) {
      setMessage(ui.fillMsg, 'error', `Could not fill the form: ${error.message}`);
    } finally {
      ui.fillBtn.disabled = false;
      ui.fillBtn.textContent = 'Fill the Koha form';
    }
  }

  // Show a field in the Koha form: open its section tab, scroll to it, focus its first input
  function jumpTo(tag, index) {
    const block = filler.getTagBlocks(tag)[index - 1];
    const input = filler.findSubfieldInput(tag, '', index);
    const target = block || input;
    if (!target) return;
    const pane = target.closest('.tab-pane, [role="tabpanel"]');
    if (pane && pane.id) {
      const link = document.querySelector(`a[href="#${pane.id}"], [data-bs-target="#${pane.id}"], [data-target="#${pane.id}"], [aria-controls="${pane.id}"]`);
      if (link && link !== target) link.click();
    }
    setTimeout(() => {
      target.scrollIntoView({behavior: 'smooth', block: 'center'});
      const all = [...(block || document).querySelectorAll(`input[id^="tag_${tag}_subfield_"]:not([type="hidden"])`)];
      const first = all.find(i => i.value.trim()) || all[0] || input;
      if (first) first.focus({preventScroll: true});
    }, 150);
  }

  // --- Export ------------------------------------------------------------------------------------

  function renderExport() {
    const body = ui.bodies.export;
    body.textContent = '';
    if (!record) {
      body.append(emptyState('Nothing to export yet', 'Choose a record in Search first.', button('Go to Search', () => selectTab('search'), 'primary')));
      return;
    }
    const rec = cleanRecord(record);
    ui.exportMsg = el('div', {'aria-live': 'polite'});
    const text = el('pre', {class: 'mh-marc', text: recordText(rec)});
    const copied = el('span', {class: 'mh-hint', 'aria-live': 'polite'});
    body.append(
      el('div', {class: 'mh-exports'},
        el('div', {class: 'mh-ex'}, el('b', {text: 'MARC 21 file (.mrc)'}), el('span', {class: 'mh-hint', text: 'UTF-8, for Cataloging › Stage records for import'}),
          button('Download .mrc', () => download(rec, 'mrc'), 'default')),
        el('div', {class: 'mh-ex'}, el('b', {text: 'MARCXML'}), el('span', {class: 'mh-hint', text: 'For Koha import or other systems'}),
          button('Download MARCXML', () => download(rec, 'xml'), 'default'))),
      ui.exportMsg,
      el('h3', {class: 'mh-sec', text: 'As MARC text'}),
      text,
      el('div', {class: 'mh-row'}, button('Copy MARC text', async () => {
        try { await navigator.clipboard.writeText(text.textContent); copied.textContent = 'Copied.'; }
        catch (error) { copied.textContent = 'Select the text above and copy it.'; }
      }, 'default'), copied));
  }

  function download(rec, format) {
    let content;
    try {
      content = format === 'mrc' ? toIso2709([rec]) : toMarcXml([rec]);
    } catch (error) {
      setMessage(ui.exportMsg, 'error', `Not downloaded: ${error.message}`);
      return;
    }
    const isbn = ((rec.fields.find(f => f.tag === '020') || {}).subfields || []).map(sf => sf.a).find(Boolean) || 'record';
    const url = URL.createObjectURL(new Blob([content], {type: format === 'mrc' ? 'application/marc' : 'application/marcxml+xml'}));
    const link = el('a', {href: url, download: `koha-marc-${String(isbn).replace(/[^0-9Xx]/g, '') || 'record'}.${format === 'mrc' ? 'mrc' : 'xml'}`});
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    setMessage(ui.exportMsg, 'ok', `Downloaded ${format === 'mrc' ? 'the .mrc file' : 'the MARCXML file'}.`);
  }

  // --- Start ---------------------------------------------------------------------------------

  async function init(staticBase, version, options = {}) {
    mode = options.mode === 'batch' ? 'batch' : 'editor';
    // Only on the cataloguing editor itself (not, say, the login page shown at the same address)
    if (mode === 'editor' && !document.querySelector('#toolbar, form[name="f"], [id^="tag_245_"]')) return null;
    TABS = mode === 'batch' ? ALL_TABS.filter(([id]) => id !== 'fill') : ALL_TABS;
    VERSION = version;
    build();
    try {
      settings = configureRelay(await api('/settings'));
      engine = startShared('engine', settings);
      filler = startShared('filler', settings);
      if (!String(settings.institutionName || '').trim()) {
        setMessage(ui.searchMsg, 'info', 'No institution name is set yet, so 040 will be empty. ',
          el('a', {href: CONFIGURE, target: '_blank', rel: 'noopener', text: 'Open the settings'}), '.');
      }
    } catch (error) {
      setMessage(ui.searchMsg, 'error', `Koha MARC Helper could not start: ${error.message}`);
      ui.searchBtn.disabled = true;
      return null;
    }
    if (mode === 'editor' && sessionStorage.getItem(OPEN_KEY)) toggle(true);
    return settings;
  }

  // For the settings page: search a known ISBN with the given settings and report each source
  async function testSources(values, onProgress, query = '9780131103627') {
    const testEngine = startShared('engine', configureRelay(values));
    return testEngine.searchBooks(query, onProgress);
  }

  // For the settings page: ask the saved AI provider for a 500 note on a sample book
  async function testAi() {
    const values = configureRelay(await api('/settings'));
    if (!values.llmProvider) throw new Error('No AI provider is saved (or its address is missing). Choose one, save, then test.');
    const answer = await startShared('engine', values).handleAiHelper('500', SAMPLE_BOOK);
    if (!String(answer || '').trim()) throw new Error('The AI provider answered with nothing.');
    return String(answer);
  }

  function sourceList(values = {}) {
    return startShared('engine', values).sourceNames(values);
  }

  return {init, testSources, testAi, sourceList, api, openRecord, searchFor, recordFromBook};
})();
