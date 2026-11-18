// Koha MARC Helper - a stand-in for Koha, to try the panel without a Koha server.
// GPL v3 or later. Run after tools/build_kpz.py:   node t/dev-server.js [port]
// Then open http://localhost:8790/cgi-bin/koha/cataloguing/addbiblio.pl
// Serves the built static files, answers /settings, and relays to the same approved
// sources as Relay.pm (a development copy of its rules, for this test page only).
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATIC = path.join(ROOT, 'build', 'Koha', 'Plugin', 'MarcHelper', 'static');
const PORT = +process.argv[2] || 8790;
const HOSTS = ['lx2.loc.gov', 'id.loc.gov', 'indcat.inflibnet.ac.in', 'isbn.gov.in', 'www.googleapis.com', 'sru.k10plus.de',
  'api.crossref.org', 'oauth.oclc.org', 'americas.discovery.api.oclc.org', 'api.isbndb.com', 'gutendex.com', 'archive.org', 'openlibrary.org'];
// The AI Helper: a local Ollama (MH_OLLAMA=http://localhost:11434 to try it), only its generate address
const OLLAMA = process.env.MH_OLLAMA || '';
const AI_URL = OLLAMA ? `${OLLAMA.replace(/\/+$/, '')}/api/generate` : '';
const allowed = url => { if (AI_URL && String(url).split('?')[0] === AI_URL) return true; try { const u = new URL(url); return u.protocol === 'https:' && !u.port && (HOSTS.includes(u.hostname) || /\.(alma\.exlibrisgroup\.com|archive\.org)$/.test(u.hostname)); } catch (e) { return false; } };

const AUTHORITIES = [
  {authid: 2235, type: 'PERSO_NAME', tags: ['00'], heading: 'Tagore, Rabindranath, 1861-1941', see: ['Thakur, Rabindranath, 1861-1941'], usage: 14, subfields: [['a', 'Tagore, Rabindranath'], ['d', '1861-1941']]},
  {authid: 12, type: 'TOPIC_TERM', tags: ['50'], heading: 'Hindu philosophy', see: ['Philosophy, Hindu'], usage: 9, subfields: [['a', 'Hindu philosophy']]}
];
const settings = {institutionName: 'Test Library', itemType: 'BK', ruleEndingPunctuation: 'remove', ruleStatement: 'by', ruleOfThree: 'apply',
  ruleItemNumber: 'generate', rulePublicationField: '260', localFields: '', googleApiKey: '', worldcatApiKey: '', worldcatApiSecret: '', isbnDbApiKey: '', opacUrl: '', llmProvider: OLLAMA ? 'ollama' : '', ollamaBaseUrl: OLLAMA, ollamaModel: 'llama3', aiUrl: AI_URL, serialItemType: 'CR', matchers: [{id: 1, code: 'ISBN', description: '020$a'}, {id: 2, code: 'ISSN', description: '022$a'}]};

// The loader exactly as Koha::Plugin::MarcHelper->intranet_js returns it
const pm = fs.readFileSync(path.join(ROOT, 'Koha', 'Plugin', 'MarcHelper.pm'), 'utf8');
const loader = pm.split('return <<"JS";\n')[1].split('\nJS\n')[0]
  .replace(/\$version/g, 'dev').replace(/\\\\/g, '\\').replace(/\\\$/g, '$');

// A few fields shaped like Koha's Add MARC record form, enough to try filling
const field = (tag, subs) => `<li class="tag" id="tag_${tag}_1"><input name="tag_${tag}_indicator1_1" size="1"><input name="tag_${tag}_indicator2_1" size="1"> <b>${tag}</b><ul>` +
  subs.map(c => `<li class="subfield_line"><label>$${c}</label><input id="tag_${tag}_subfield_${c}_1_${c}" name="tag_${tag}_subfield_${c}_1_${c}"></li>`).join('') + '</ul></li>';
const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="csrf-token" content="dev-token"><title>Add MARC record (test)</title>
<style>body{font-family:sans-serif;margin:16px} li.tag{list-style:none;margin:6px 0} input{margin:2px}</style></head><body>
<h1>Add MARC record (stand-in for Koha)</h1><div id="toolbar" class="btn-toolbar"><button class="btn">Save</button></div>
<ul>${field('020', ['a', 'q', 'c'])}${field('040', ['a', 'b', 'c'])}${field('082', ['a', 'b', '2'])}${field('100', ['a', 'd', 'e', 'q', '9'])}${field('245', ['a', 'b', 'c', 'n', 'p'])}${field('250', ['a', 'b'])}${field('260', ['a', 'b', 'c'])}${field('300', ['a', 'b', 'c', 'e'])}${field('650', ['a', 'x', 'y', 'z', 'v', '9'])}${field('942', ['2', 'c', 'h', 'i'])}</ul>
${loader}</body></html>`;

// The batch cataloguing page (tool.tt) with its template parts filled in as Koha would
const toolTt = fs.readFileSync(path.join(ROOT, 'Koha', 'Plugin', 'MarcHelper', 'tool.tt'), 'utf8');
const toolPage = `<!doctype html><html><head><meta charset="utf-8"><meta name="csrf-token" content="dev-token"><title>Batch cataloguing (test)</title>${
  (toolTt.match(/<link rel="stylesheet"[^>]*>/) || [''])[0].replace(/\[% static %\]/g, '/api/v1/contrib/marchelper/static/static/').replace(/\[% plugin_version \| uri %\]/g, 'dev')}${(toolTt.match(/<style>[\s\S]*?<\/style>/) || [''])[0]}</head><body>${
  toolTt.slice(toolTt.indexOf('<div class="main'), toolTt.indexOf("[% INCLUDE 'intranet-bottom.inc' %]"))
    .replace(/\[% UNLESS can_catalogue %\][\s\S]*?\[% ELSE %\]/, '')
    .replace(/\[% IF can_stage %\]([\s\S]*?)\[% ELSE %\][\s\S]*?\[% END %\]/, '$1')
    .replace(/\[% (?:IF can_catalogue|END) %\]/g, '')
    .replace(/\[% static %\]/g, '/api/v1/contrib/marchelper/static/static/')
    .replace(/\[% plugin_version \| (?:uri|html) %\]/g, 'dev').replace(/\[% can_stage \| html %\]/g, '1')}</body></html>`;
let stagedBatches = 0;
const TYPES = {'.js': 'application/javascript', '.css': 'text/css'};
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const send = (code, body, type = 'application/json') => { res.writeHead(code, {'Content-Type': type, 'Cache-Control': 'no-store'}); res.end(body); };
  if (url.pathname === '/cgi-bin/koha/cataloguing/addbiblio.pl') return send(200, page, 'text/html; charset=utf-8');
  if (url.pathname === '/cgi-bin/koha/plugins/run.pl' && url.searchParams.get('method') === 'tool') return send(200, toolPage, 'text/html; charset=utf-8');
  // Staging stand-in: counts the records (in Koha: Stage.pm with C4::ImportBatch)
  if (url.pathname === '/api/v1/contrib/marchelper/stage' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || '{}');
    const count = (String(body.marcxml || '').match(/<record\b/g) || []).length;
    if (!count) return send(400, JSON.stringify({error: 'No records were sent'}));
    stagedBatches++;
    return send(200, JSON.stringify({batch_id: stagedBatches, staged: count, invalid: 0, matches: 0, matcher: body.matcher_id ? 'ISBN' : '',
      link: `/cgi-bin/koha/tools/manage-marc-import.pl?import_batch_id=${stagedBatches}`}));
  }
  if (url.pathname.startsWith('/api/v1/contrib/marchelper/static/static/')) {
    const file = path.join(STATIC, path.basename(url.pathname));
    return fs.existsSync(file) ? send(200, fs.readFileSync(file), TYPES[path.extname(file)] || 'text/plain') : send(404, '{"error":"not found"}');
  }
  if (url.pathname === '/api/v1/contrib/marchelper/settings') return send(200, JSON.stringify(settings));
  // A small stand-in authority file (in Koha: Authorities.pm with C4::Heading)
  if (url.pathname === '/api/v1/contrib/marchelper/authorities' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const norm = t => String(t).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const results = (JSON.parse(raw || '{}').headings || []).map(h => {
      const text = norm(h.subfields.filter(([c]) => /[a-z]/.test(c) && !'e4'.includes(c)).map(([, v]) => v).join(' '));
      const matches = AUTHORITIES.filter(a => a.tags.includes(h.tag.slice(1)) && (norm(a.heading) === text || a.see.some(s => norm(s) === text)))
        .map(a => ({authid: a.authid, heading: a.heading, subfields: a.subfields, usage: a.usage, same: norm(a.heading) === text ? 1 : 0, type: a.type}));
      const via = matches.length && !matches.some(m => m.same) ? 'see' : undefined;
      return {tag: h.tag, display: text, matches, ...(via ? {via} : {})};
    });
    return send(200, JSON.stringify({results}));
  }
  if (url.pathname === '/api/v1/contrib/marchelper/relay' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const r = JSON.parse(raw || '{}');
    if (!allowed(r.url)) return send(200, JSON.stringify({status: 0, error: 'Address is not one of the approved book sources'}));
    try {
      const headers = {};
      Object.entries(r.headers || {}).forEach(([k, v]) => { if (['accept', 'content-type', 'authorization'].includes(k.toLowerCase())) headers[k] = v; });
      const cookies = Object.entries(r.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
      if (cookies) headers.cookie = cookies;
      const answer = await fetch(r.url, {method: r.method || 'GET', headers, body: r.method === 'POST' ? r.body : undefined, redirect: 'follow'});
      return send(200, JSON.stringify({status: answer.status, url: answer.url, headers: {'content-type': answer.headers.get('content-type') || ''},
        cookies: answer.headers.getSetCookie ? answer.headers.getSetCookie() : [], body: await answer.text()}));
    } catch (error) {
      return send(200, JSON.stringify({status: 0, error: `Could not reach the source (${error.message})`}));
    }
  }
  send(404, '{"error":"not found"}');
}).listen(PORT, () => console.log(`Stand-in Koha at http://localhost:${PORT}/cgi-bin/koha/cataloguing/addbiblio.pl`));
