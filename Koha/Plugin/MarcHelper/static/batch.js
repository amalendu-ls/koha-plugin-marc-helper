/*
  Koha MARC Helper - batch cataloguing (Tools › Plugins › Koha MARC Helper).
  Copyright (C) 2026 Amalendu Das. GPL v3 or later, see LICENSE.

  A queue of ISBNs and ISSNs, searched one at a time with the panel's engine (same sources,
  same rules); the record with exactly that number from the highest-priority source is
  taken (pickExactRecord, shared with the extension). Each record is checked in the panel
  (openRecord), then the ticked ones are staged in Koha (/stage) or downloaded. The queue
  is kept in this browser (localStorage), so a reload does not lose it.
*/
(function () {
  'use strict';
  const root = document.getElementById('mhb');
  if (!root || !window.MarcHelper) return;
  const MH = window.MarcHelper;
  const $ = id => document.getElementById(id);
  const KEY = 'marchelper.batch';
  const STATUS = {
    pending: 'Waiting', searching: 'Searching…', found: 'Found', check: 'Found – check digit wrong: compare with the item',
    notFound: 'Not found', invalid: 'Not an ISBN or ISSN', error: 'Error'
  };

  // item: {number, type, status, bad, title, source, record, include, staged, error}
  let queue = load();
  let running = false;
  let editing = null;

  function load() {
    try {
      const items = JSON.parse(localStorage.getItem(KEY) || '[]');
      // A search cut off by leaving the page starts again
      return Array.isArray(items) ? items.map(item => (item.status === 'searching' ? {...item, status: 'pending'} : item)) : [];
    } catch (error) { return []; }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(queue)); }
    catch (error) { note($('mhb-add-note'), 'bad', 'The queue is too large to keep in this browser: stage or download the records soon.'); }
  }
  // Edits in the panel change the queued record itself; keep them while it is open
  setInterval(() => { if (editing !== null) save(); }, 3000);
  window.addEventListener('beforeunload', save);

  function note(box, cls, text) {
    box.className = `help ${cls || ''}`;
    box.textContent = text;
  }

  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    });
    children.flat().forEach(c => { if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c))); });
    return node;
  };

  // --- Adding numbers ---
  const keyOf = number => { const n = standardNumber(number); return n ? (n.type === 'isbn' ? toIsbn13(n.value) || n.value : n.value) : String(number); };

  function add(text) {
    const entries = String(text).split(/[\n,;\t]+/).map(s => s.trim()).filter(Boolean);
    let added = 0;
    let repeated = 0;
    entries.forEach(entry => {
      const n = standardNumber(entry);
      const number = n ? n.value : entry;
      if (queue.some(item => keyOf(item.number) === keyOf(number))) { repeated++; return; }
      queue.push({number, type: n ? n.type : '', status: n ? 'pending' : 'invalid', bad: !!(n && !n.valid), include: true});
      added++;
    });
    save();
    render();
    note($('mhb-add-note'), added ? 'ok' : '', `${added} added to the queue${repeated ? `, ${repeated} already in it` : ''}.`);
  }

  // --- Searching ---
  const title245 = record => {
    const f = ((record && record.fields) || []).find(x => x.tag === '245');
    return f ? (f.subfields || []).filter(sf => 'ab'.includes(Object.keys(sf)[0])).map(sf => Object.values(sf)[0]).join(' : ') : '';
  };

  async function searchItem(item) {
    item.status = 'searching';
    delete item.error;
    render();
    try {
      const response = await MH.searchFor(item.number);
      const book = pickExactRecord(response.results, item.number);
      if (!book) { item.status = 'notFound'; return; }
      item.record = MH.recordFromBook(book);
      item.title = book.title;
      item.source = book.source;
      item.include = true;
      item.status = item.bad ? 'check' : 'found';
    } catch (error) {
      item.status = 'error';
      item.error = error.message;
    }
  }

  async function run() {
    if (running) return;
    if (!queue.some(item => item.status === 'pending')) { note($('mhb-summary'), 'bad', 'Nothing is waiting. Add ISBNs or ISSNs first.'); return; }
    running = true;
    $('mhb-start').hidden = true;
    $('mhb-stop').hidden = false;
    // One at a time: each search asks about 20 sources through the Koha server
    for (const item of queue) {
      if (!running) break;
      if (item.status !== 'pending') continue;
      await searchItem(item);
      save();
      render();
    }
    running = false;
    $('mhb-start').hidden = false;
    $('mhb-stop').hidden = true;
    render();
  }

  // --- Checking a record in the panel ---
  function edit(index, tab) {
    const item = queue[index];
    if (!item.record) item.record = {leader: '#####nam#a22#####7c#4500', fields: []};
    editing = index;
    MH.openRecord(item.record, {
      query: item.number,
      tab,
      onUse: record => {
        item.record = record;
        item.title = title245(record) || item.title;
        item.source = 'chosen in Search';
        if (['notFound', 'error', 'pending'].includes(item.status)) item.status = 'found';
        item.include = true;
        save();
        render();
      },
      onClose: () => {
        if (item.record && item.record.fields.length) item.title = title245(item.record) || item.title;
        editing = null;
        save();
        render();
      }
    });
    render();
  }

  // --- The queue ---
  function render() {
    const rows = $('mhb-rows');
    rows.textContent = '';
    if (!queue.length) {
      rows.append(el('tr', {}, el('td', {colspan: '6', class: 'help', text: 'The queue is empty. Add ISBNs or ISSNs above.'})));
    }
    queue.forEach((item, i) => {
      const status = item.staged ? `Staged (batch ${item.staged})` : STATUS[item.status] || item.status;
      const pickable = !!(item.record && item.record.fields.length);
      const pick = el('input', {type: 'checkbox', checked: pickable && item.include !== false, disabled: !pickable, 'aria-label': `Stage ${item.number}`});
      pick.addEventListener('change', () => { item.include = pick.checked; save(); summary(); });
      rows.append(el('tr', {class: editing === i ? 'editing' : ''},
        el('td', {}, pick),
        el('td', {class: 'num', text: item.number}),
        el('td', {}, el('span', {class: `pill pill-${item.staged ? 'staged' : item.status}`, text: status, title: item.error || ''})),
        el('td', {text: item.title || ''}),
        el('td', {class: 'help', text: item.source || ''}),
        el('td', {style: 'white-space:nowrap'},
          pickable ? el('button', {type: 'button', class: 'btn-o', onclick: () => edit(i, 'record')}, 'Check / edit')
            : ['notFound', 'error'].includes(item.status) ? el('button', {type: 'button', class: 'btn-o', onclick: () => edit(i, 'search')}, 'Search by title…') : null,
          ['notFound', 'error'].includes(item.status) ? el('button', {type: 'button', class: 'btn-x', title: 'Search again', 'aria-label': `Search ${item.number} again`,
            onclick: () => { item.status = 'pending'; save(); render(); }}, '↻') : null,
          el('button', {type: 'button', class: 'btn-x', title: 'Remove from the queue', 'aria-label': `Remove ${item.number}`,
            onclick: () => { if (editing === i) return; queue.splice(i, 1); if (editing !== null && editing > i) editing--; save(); render(); }}, '✕'))));
    });
    summary();
  }

  function summary() {
    const count = s => queue.filter(item => item.status === s).length;
    const ready = chosen().length;
    $('mhb-summary').className = 'help';
    $('mhb-summary').textContent = queue.length
      ? `${queue.length} in the queue: ${count('found') + count('check')} found${count('check') ? ` (${count('check')} with a wrong check digit: compare with the item)` : ''}, ${count('notFound')} not found, ${count('pending') + count('searching')} waiting${count('invalid') + count('error') ? `, ${count('invalid') + count('error')} with problems` : ''}. ${ready} ticked for staging.`
      : '';
  }

  // Records to stage or download: ticked, with fields, without empty subfields
  function chosen() {
    return queue.filter(item => item.include !== false && item.record && item.record.fields.length);
  }

  function cleaned(record) {
    return {...record, fields: record.fields
      .filter(f => /^\d{3}$/.test(f.tag || ''))
      .map(f => (/^00\d$/.test(f.tag) ? f : {...f, subfields: (f.subfields || []).filter(sf => Object.keys(sf)[0] && String(Object.values(sf)[0]).trim() !== '')}))
      .filter(f => (/^00\d$/.test(f.tag) ? String(f.value || '').trim() : f.subfields.length))};
  }

  function download(kind) {
    const items = chosen();
    if (!items.length) { note($('mhb-stage-note'), 'bad', 'No records are ticked.'); return; }
    const records = items.map(item => cleaned(item.record));
    const blob = kind === 'mrc' ? new Blob([toIso2709(records)], {type: 'application/marc'}) : new Blob([toMarcXml(records)], {type: 'application/xml'});
    const link = el('a', {href: URL.createObjectURL(blob), download: `${$('mhb-name').value.trim() || 'marchelper-batch'}.${kind === 'mrc' ? 'mrc' : 'xml'}`});
    document.body.append(link);
    link.click();
    link.remove();
  }

  async function stage() {
    const items = chosen();
    const box = $('mhb-stage-note');
    if (!items.length) { note(box, 'bad', 'No records are ticked.'); return; }
    const problems = items.filter(item => checkRecord(item.record).some(p => p.level === 'error'));
    if (problems.length && !window.confirm(`${problems.length} of the ${items.length} records have errors in Check record (${problems.map(i => i.number).join(', ')}). Stage them anyway?`)) return;
    const button = $('mhb-stage');
    button.disabled = true;
    button.textContent = 'Staging…';
    note(box, '', '');
    try {
      const token = document.querySelector('meta[name="csrf-token"]');
      const response = await fetch('/api/v1/contrib/marchelper/stage', {method: 'POST', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', Accept: 'application/json', ...(token ? {'CSRF-TOKEN': token.content} : {})},
        body: JSON.stringify({marcxml: toMarcXml(items.map(item => cleaned(item.record))), name: `${$('mhb-name').value.trim() || 'marchelper-batch'}.xml`,
          matcher_id: Number($('mhb-matcher').value) || null})});
      const answer = await response.json().catch(() => ({}));
      if (response.status === 401 || response.status === 403) throw new Error('Staging needs the permission "Stage MARC records into the reservoir" (tools: stage_marc_import).');
      if (!response.ok || answer.error) throw new Error(answer.error || `The Koha server answered ${response.status}.`);
      items.forEach(item => { item.staged = answer.batch_id; item.include = false; });
      save();
      render();
      box.textContent = '';
      box.className = 'alert alert-info';
      box.append(`✓ ${answer.staged} record${answer.staged === 1 ? '' : 's'} staged as batch ${answer.batch_id}`,
        answer.matcher ? `; ${answer.matches} already in your catalogue (matching rule ${answer.matcher}: left alone, not overlaid)` : '',
        answer.invalid ? `; ${answer.invalid} could not be read` : '', '. ',
        el('a', {href: answer.link, text: 'Open the batch in Manage staged MARC records'}), ' to import it.');
    } catch (error) {
      note(box, 'bad', `✗ ${error.message}`);
    } finally {
      button.disabled = false;
      button.textContent = 'Stage in Koha';
    }
  }

  // --- Start ---
  $('mhb-add').addEventListener('click', () => { add($('mhb-input').value); $('mhb-input').value = ''; });
  $('mhb-file').addEventListener('change', async event => {
    const file = event.target.files[0];
    if (file) add(await file.text());
    event.target.value = '';
  });
  $('mhb-start').addEventListener('click', run);
  $('mhb-stop').addEventListener('click', () => { running = false; note($('mhb-summary'), '', 'Stopping after the current search…'); });
  $('mhb-clear').addEventListener('click', () => {
    if (!queue.length || !window.confirm(`Remove all ${queue.length} numbers and their records from the queue? Staged batches stay in Koha.`)) return;
    queue = [];
    save();
    render();
  });
  $('mhb-mrc').addEventListener('click', () => download('mrc'));
  $('mhb-xml').addEventListener('click', () => download('xml'));
  if ($('mhb-stage')) $('mhb-stage').addEventListener('click', stage);
  $('mhb-name').value = `marchelper-${new Date().toISOString().slice(0, 10)}`;
  render();

  MH.init('/api/v1/contrib/marchelper/static/static/', root.dataset.version, {mode: 'batch'}).then(settings => {
    if (!settings) { note($('mhb-summary'), 'bad', 'Koha MARC Helper could not start: see the panel for the reason.'); return; }
    const matchers = settings.matchers || [];
    matchers.forEach(m => $('mhb-matcher').append(el('option', {value: String(m.id), text: `${m.code} (${m.description})`})));
    // Books are matched by ISBN unless the queue holds only ISSNs
    const onlyIssn = queue.length && queue.every(item => item.type === 'issn');
    const preferred = matchers.find(m => m.code === (onlyIssn ? 'ISSN' : 'ISBN'));
    if (preferred) $('mhb-matcher').value = String(preferred.id);
  });
})();
