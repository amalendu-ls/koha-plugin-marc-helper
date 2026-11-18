/*
  Koha MARC Helper - the settings page (tabs, rule examples, local-field check, source list
  with on/off and order, Test sources, Test key).
  Copyright (C) 2026 Amalendu Das. GPL v3 or later, see LICENSE.
*/
(function () {
  'use strict';
  const root = document.getElementById('mhs');
  if (!root) return;
  const $ = id => document.getElementById(id);
  const parse = text => { try { const v = JSON.parse(text || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };

  // --- Tabs (the open tab is kept across Save) ---
  const tabs = [...root.querySelectorAll('[role=tab]')];
  function select(tab) {
    tabs.forEach(t => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute('aria-controls')).hidden = !on;
    });
    $('mhs-tab').value = tab.id.replace(/^t-/, '');
  }
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => select(t));
    t.addEventListener('keydown', e => {
      const next = {ArrowRight: i + 1, ArrowLeft: i - 1}[e.key];
      if (next === undefined) return;
      const target = tabs[(next + tabs.length) % tabs.length];
      select(target);
      target.focus();
    });
  });
  select($(`t-${root.dataset.tab || 'library'}`) || tabs[0]);

  // --- Live examples for the cataloguing rules ---
  function examples() {
    const keep = $('ruleEndingPunctuation').value === 'keep';
    const by = $('ruleStatement').value === 'by';
    const end = keep ? '.' : '';
    const c = by ? 'by Rabindranath Tagore' : 'Rabindranath Tagore ; with an introduction by W.B. Yeats';
    $('ex-punct').textContent = keep ? `245 10 $a Gitanjali / $c ${c}.` : `245 10 $a Gitanjali $c ${c}`;
    $('ex-stmt').textContent = `245 10 $a Gitanjali ${keep ? '/ ' : ''}$c ${c}${end}`;
    $('ex-three').textContent = $('ruleOfThree').value === 'apply'
      ? `A book by four authors:\n245 00 $a Title ${keep ? '/ ' : ''}$c by A. Rao ... [et al.]${end}\n700 1# $a Rao, A.${end}   (no 100)`
      : `A book by four authors:\n100 1# $a Rao, A.${end}\n700 1# $a Sen, B.${end}  (and one 700 for each other author)`;
    $('ex-item').textContent = $('ruleItemNumber').value === 'generate'
      ? '082 04 $a 891.4414 $b TAG/G\n942 ## $c BK $h 891.4414 $i TAG/G' : '082 04 $a 891.4414\n942 ## $c BK $h 891.4414';
    const pub = $('rulePublicationField').value;
    $('ex-pub').textContent = `${pub} ${pub === '264' ? '#1' : '##'} $a Mineola, N.Y.${keep ? ' :' : ''} $b Dover Publications${keep ? ',' : ''} $c 2000${end}`;
  }
  ['ruleEndingPunctuation', 'ruleStatement', 'ruleOfThree', 'ruleItemNumber', 'rulePublicationField'].forEach(id => $(id).addEventListener('change', examples));
  examples();

  // --- Local fields: checked as you type, with the same parser the record builder uses ---
  function checkLocal() {
    const out = $('local-check');
    if (typeof parseLocalFields !== 'function') return;
    const {fields, errors} = parseLocalFields($('localFields').value);
    out.className = errors.length ? 'help bad' : 'help ok';
    out.textContent = errors.length ? `✗ ${errors.join('; ')}` : fields.length ? `✓ ${fields.length} field${fields.length === 1 ? '' : 's'}, written correctly: ${fields.map(f => f.tag).join(', ')}` : '';
  }
  $('localFields').addEventListener('input', checkLocal);
  checkLocal();

  // --- Sources: on/off, order, test ---
  const MH = window.MarcHelper;
  let sources = [];
  const opacBox = $('kohaOpacs');
  const listSources = () => { try { return MH.sourceList({kohaOpacs: opacBox.value}); } catch (e) { return []; } };
  sources = listSources();
  const off = new Set(parse(root.dataset.off));
  const saved = parse(root.dataset.order);
  const rank = name => { const i = saved.indexOf(name); return i < 0 ? saved.length + sources.findIndex(s => s.name === name) : i; };
  sources.sort((a, b) => rank(a.name) - rank(b.name));
  const results = {};
  const label = name => (name === 'OpenLibrary' ? 'Open Library' : name);

  function keep() {
    $('mhs-off').value = JSON.stringify([...off]);
    $('mhs-order').value = JSON.stringify(sources.map(s => s.name));
  }

  function draw() {
    const body = $('src-rows');
    body.textContent = '';
    if (!sources.length) {
      body.innerHTML = '<tr><td colspan="5" class="bad">The source list could not be loaded. Check that the plugin\'s files are served (reinstall the plugin).</td></tr>';
      return;
    }
    sources.forEach((s, i) => {
      const tr = document.createElement('tr');
      if (off.has(s.name)) tr.className = 'off';
      tr.innerHTML = '<td><span class="order"><button type="button" aria-label="Move up">&uarr;</button><button type="button" aria-label="Move down">&darr;</button></span></td>'
        + '<td></td><td><label class="switch"><input type="checkbox"><span></span></label></td><td class="help"></td><td></td>';
      tr.children[1].textContent = label(s.name);
      tr.children[3].textContent = s.by;
      const [up, down] = tr.querySelectorAll('.order button');
      up.disabled = i === 0;
      down.disabled = i === sources.length - 1;
      up.setAttribute('aria-label', `Move ${label(s.name)} up`);
      down.setAttribute('aria-label', `Move ${label(s.name)} down`);
      const swap = (a, b) => { [sources[a], sources[b]] = [sources[b], sources[a]]; keep(); draw(); body.querySelectorAll('.order button')[b * 2 + (b < a ? 0 : 1)]?.focus(); };
      up.addEventListener('click', () => swap(i, i - 1));
      down.addEventListener('click', () => swap(i, i + 1));
      const box = tr.querySelector('input');
      box.checked = !off.has(s.name);
      box.setAttribute('aria-label', `Search ${label(s.name)}`);
      box.addEventListener('change', () => { if (box.checked) off.delete(s.name); else off.add(s.name); keep(); tr.classList.toggle('off', !box.checked); });
      const r = results[s.name];
      if (r) {
        const pill = document.createElement('span');
        pill.className = `pill ${r.cls}`;
        pill.textContent = r.text;
        if (r.title) pill.title = r.title;
        tr.children[4].append(pill);
      }
      body.append(tr);
    });
  }
  keep();
  draw();

  // Koha OPACs: checked as they are typed; each becomes a source in the list (on/off, order)
  function checkOpacs() {
    const out = $('opac-check');
    if (typeof parseKohaOpacs !== 'function') return;
    const {opacs, errors} = parseKohaOpacs(opacBox.value);
    out.className = errors.length ? 'help bad' : 'help ok';
    out.textContent = errors.length ? `✗ ${errors.join('; ')}` : opacs.length ? `✓ ${opacs.length} OPAC${opacs.length === 1 ? '' : 's'}: ${opacs.map(o => o.name).join(', ')}` : '';
    const fresh = listSources();
    const known = new Set(sources.map(s => s.name));
    sources = [...sources.filter(s => fresh.some(f => f.name === s.name)), ...fresh.filter(f => !known.has(f.name))];
    keep();
    draw();
  }
  opacBox.addEventListener('input', checkOpacs);
  checkOpacs();

  async function runTest(values, button, idle) {
    const started = {};
    button.disabled = true;
    button.textContent = 'Testing…';
    try {
      const settings = await MH.api('/settings');
      await MH.testSources({...settings, ...values}, (name, state, detail) => {
        if (state === 'searching') { started[name] = performance.now(); results[name] = {cls: 'pill-no', text: 'testing…'}; }
        else {
          const secs = `${((performance.now() - (started[name] || performance.now())) / 1000).toFixed(1)} s`;
          results[name] = state === 'failed'
            ? {cls: /quota|429/i.test(detail) ? 'pill-warn' : 'pill-bad', text: /timed out/i.test(detail) ? 'timed out' : /quota|429/i.test(detail) ? 'quota used' : 'failed', title: detail}
            : {cls: 'pill-ok', text: `✓ answered · ${secs}`};
        }
        draw();
      });
      return true;
    } catch (error) {
      $('test-note').textContent = `The test could not run: ${error.message}`;
      $('test-note').className = 'help bad';
      return false;
    } finally {
      button.disabled = false;
      button.textContent = idle;
    }
  }

  // --- AI Helper: only the chosen provider's boxes; Test AI Helper (saved settings) ---
  const provider = $('llmProvider');
  const showProvider = () => root.querySelectorAll('[data-ai]').forEach(box => { box.hidden = box.dataset.ai !== provider.value; });
  provider.addEventListener('change', showProvider);
  showProvider();
  $('test-ai').addEventListener('click', async () => {
    const button = $('test-ai');
    const note = $('ai-note');
    button.disabled = true;
    button.textContent = 'Testing…';
    note.className = 'help';
    note.textContent = 'Waiting for the AI provider…';
    const started = performance.now();
    try {
      const answer = await MH.testAi();
      note.className = 'help ok';
      note.textContent = `✓ Answered in ${((performance.now() - started) / 1000).toFixed(1)} s: ${answer.split('\n')[0].slice(0, 160)}`;
    } catch (error) {
      note.className = 'help bad';
      note.textContent = `✗ ${error.message}`;
    } finally {
      button.disabled = false;
      button.textContent = 'Test AI Helper';
    }
  });

  $('test-sources').addEventListener('click', async () => {
    Object.keys(results).forEach(k => delete results[k]);
    const button = $('test-sources');
    if (!await runTest({sourcesOff: [], sourceOrder: []}, button, 'Test sources')) return;
    const answered = Object.values(results).filter(r => r.cls === 'pill-ok').length;
    $('test-note').className = 'help';
    $('test-note').textContent = `${answered} of ${Object.keys(results).length} sources answered from this server. "Answered" means the source replied; it may not hold this test book. Keys not set skip WorldCat and ISBNdb.`;
    $('net-check').innerHTML = answered
      ? '<span class="ok">&#10003;</span> Outgoing internet works (the last source test reached the sources)'
      : '<span class="warn">&#9888;</span> No source answered: check the server\'s outgoing internet or proxy';
  });

  // Test one saved key: search with only that source
  document.querySelectorAll('.test-key').forEach(button => button.addEventListener('click', async () => {
    const name = button.dataset.source;
    const state = button.parentNode.querySelector('.pill');
    delete results[name];
    const ok = await runTest({sourcesOff: sources.map(s => s.name).filter(n => n !== name), sourceOrder: []}, button, 'Test key');
    const r = results[name];
    if (!ok || !r) { state.className = 'pill pill-bad'; state.textContent = 'not tested (see Sources)'; return; }
    state.className = `pill ${r.cls === 'pill-ok' ? 'pill-ok' : r.cls}`;
    state.textContent = r.cls === 'pill-ok' ? 'saved · works' : `saved · ${r.text}`;
    if (r.title) state.title = r.title;
  }));
})();
