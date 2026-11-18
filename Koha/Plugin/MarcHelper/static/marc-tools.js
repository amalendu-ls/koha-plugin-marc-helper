/*
  Record tools used by the side panel and the background script:
  - checking a record before it goes to Koha (problems are listed, nothing is changed)
  - standard tag order
  - the library's fixed local fields (Settings)
  - export files for Koha's "Stage MARC records for import": MARC 21 (ISO 2709) and MARCXML
*/

// --- Check record ---

function isbnDigits(value) {
  const match = String(value || '').match(/^[\dXx\s-]+/);  // "9780262033848 (pbk.)" → the number
  return match ? match[0].replace(/[\s-]/g, '').toUpperCase() : '';
}

// ISSN: seven digits and a check digit (mod 11, X = 10). formatIssn gives "0028-0836", or ''.
function issnDigits(value) {
  return String(value || '').toUpperCase().replace(/[^0-9X]/g, '');
}

function formatIssn(value) {
  const d = issnDigits(value);
  return /^\d{7}[\dX]$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4)}` : '';
}

function issnValid(value) {
  const d = issnDigits(value);
  if (!/^\d{7}[\dX]$/.test(d)) return false;
  const sum = [...d.slice(0, 7)].reduce((s, c, i) => s + Number(c) * (8 - i), 0);
  const check = (11 - (sum % 11)) % 11;
  return d[7] === (check === 10 ? 'X' : String(check));
}

function isbnValid(value) {
  const d = isbnDigits(value);
  if (/^\d{9}[\dX]$/.test(d)) {
    const sum = [...d].reduce((total, ch, i) => total + (10 - i) * (ch === 'X' ? 10 : +ch), 0);
    return sum % 11 === 0;
  }
  if (/^97[89]\d{10}$/.test(d)) {
    const sum = [...d.slice(0, 12)].reduce((total, ch, i) => total + +ch * (i % 2 ? 3 : 1), 0);
    return (10 - sum % 10) % 10 === +d[12];
  }
  return false;
}

// ISBN-10 or ISBN-13 → ISBN-13 digits, so both forms of one ISBN compare equal ('' if not an ISBN)
function toIsbn13(value) {
  const d = isbnDigits(value);
  if (/^97[89]\d{10}$/.test(d)) return d;
  if (!/^\d{9}[\dX]$/.test(d)) return '';
  const core = `978${d.slice(0, 9)}`;
  const sum = [...core].reduce((total, ch, i) => total + +ch * (i % 2 ? 3 : 1), 0);
  return core + (10 - sum % 10) % 10;
}

// DDC class number: three digits, then optional decimals, with LC's segmentation marks
// ("/" and "'") allowed: 004, 891.4414, 891.44/14, 823/.912
const DDC_PATTERN = /^\d{3}(?:[./']+\d+)*$/;

// Fields that MARC 21 (and Koha, for 942) does not repeat
const NON_REPEATABLE_TAGS = ['001', '003', '005', '008', '040', '240', '245', '250', '942'];

const firstValue = (field, code) => ((field && field.subfields) || []).map(sf => sf[code]).find(v => v !== undefined);

/**
 * Problems in a record, most serious first: [{level: 'error' | 'warning', tag, text}].
 * Errors are things Koha or MARC 21 needs; warnings are things to look at.
 */
function checkRecord(record) {
  const problems = [];
  const fields = (record && record.fields) || [];
  const add = (level, tag, text) => problems.push({level, tag, text});
  const withTag = tag => fields.filter(f => f.tag === tag);

  fields.forEach(field => {
    if (!/^\d{3}$/.test(field.tag || '')) {
      add('error', field.tag || '???', `"${field.tag || ''}" is not a MARC tag (three digits).`);
      return;
    }
    if (parseInt(field.tag, 10) < 10) return;
    (field.indicators || []).forEach((ind, i) => {
      if (ind === '#') add('warning', field.tag, `Indicator ${i + 1} is "#": Koha stores it as "#". Use a blank (space) for "undefined".`);
      else if (!/^[0-9 ]$/.test(ind || ' ')) add('error', field.tag, `Indicator ${i + 1} "${ind}" is not valid (a digit or blank).`);
    });
    const subfields = field.subfields || [];
    if (!subfields.length) add('warning', field.tag, 'The field has no subfields.');
    subfields.forEach(sf => {
      const code = Object.keys(sf)[0];
      if (!/^[a-z0-9]$/.test(code || '')) add('error', field.tag, `"${code}" is not a subfield code.`);
      else if (!String(sf[code] || '').trim()) add('warning', field.tag, `$${code} is empty.`);
    });
  });

  // Required by Koha / for every record
  if (!withTag('040').some(f => String(firstValue(f, 'a') || '').trim())) add('error', '040', '040 $a (cataloguing agency) is empty – set your institution name in Settings.');
  if (!withTag('245').some(f => String(firstValue(f, 'a') || '').trim())) add('error', '245', 'There is no title (245 $a).');
  if (!withTag('942').some(f => String(firstValue(f, 'c') || '').trim())) add('error', '942', '942 $c (Koha item type) is empty.');
  const f008 = withTag('008')[0];
  if (!f008) add('error', '008', 'There is no 008 (fixed-length data).');
  else if ((f008.value || '').length !== 40) add('error', '008', `008 has ${(f008.value || '').length} characters; it must have exactly 40.`);

  // Repeats
  const mainEntries = fields.filter(f => /^1\d\d$/.test(f.tag));
  if (mainEntries.length > 1) add('error', mainEntries[1].tag, `There are ${mainEntries.length} main entries (1XX); a record has at most one.`);
  NON_REPEATABLE_TAGS.forEach(tag => {
    if (withTag(tag).length > 1) add('error', tag, `${tag} appears ${withTag(tag).length} times; it is not repeatable.`);
  });

  // Lengths MARC 21 allows (9,999 bytes a field, 99,999 a record)
  iso2709LengthProblems(record).forEach(p => add('error', p.tag === 'record' ? '000' : p.tag, p.tag === 'record'
    ? `The record is ${p.bytes.toLocaleString('en-GB')} bytes; MARC 21 allows at most 99,999. Shorten its longest fields.`
    : `${p.tag} is ${p.bytes.toLocaleString('en-GB')} bytes; MARC 21 allows at most 9,999 in a field. Shorten it.`));

  // Text that was in capital letters in the source (fixCapitals)
  const recapitalised = [...new Set(record.caseChanged || [])].filter(tag => withTag(tag).length);
  if (recapitalised.length) {
    add('warning', recapitalised[0], `The source was in capital letters; ${recapitalised.join(', ')} now ${recapitalised.length === 1 ? 'has' : 'have'} normal capitals (AACR2 Appendix A). Check the capitals of names of people, places and organisations.`);
  }

  // 245 $b that repeats words already in $a (e.g. "Scientology (the fundamentals of thought)" + $b "the fundamentals of thought")
  withTag('245').forEach(field => {
    const words = value => String(value || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
    const inA = new Set(words(firstValue(field, 'a')));
    const inB = words(firstValue(field, 'b'));
    if (inB.length >= 2 && inB.filter(w => inA.has(w)).length / inB.length >= 0.7) {
      add('warning', '245', '245 $b repeats words already in $a. Keep the other title information in one place only.');
    }
  });

  // Subject access: at least three headings where the content allows (none are made up)
  const subjectCount = fields.filter(f => /^6[0-5]\d$/.test(f.tag || '')).length;
  if (subjectCount < 3 && withTag('245').length) {
    add('warning', '650', subjectCount
      ? `Only ${subjectCount} subject heading${subjectCount === 1 ? '' : 's'} came from the sources. Add more if the book covers more topics (at least three where the content allows).`
      : 'There is no subject heading (6XX). Add the headings the book needs (at least three where the content allows).');
  }

  // ISBN check digits
  withTag('022').forEach(field => {
    const value = firstValue(field, 'a');
    if (value && !issnValid(value)) add('warning', '022', `ISSN ${value}: the check digit is wrong or the number is incomplete. Correct it, or record it in $y (incorrect ISSN).`);
  });
  withTag('020').forEach(field => {
    const value = firstValue(field, 'a');
    if (value && !isbnValid(value)) add('warning', '020', `ISBN ${value}: the check digit is wrong. Correct it, or record an invalid ISBN in $z.`);
  });

  // Classification and Koha call number
  withTag('082').forEach(field => {
    const value = String(firstValue(field, 'a') || '').trim();
    if (value && !DDC_PATTERN.test(value)) add('warning', '082', `082 $a "${value}" does not look like a DDC number (e.g. 891.4414).`);
  });
  const ddc = String(withTag('082').map(field => firstValue(field, 'a')).find(Boolean) || '').trim();
  if (/^\d00$/.test(ddc)) add('warning', '082', `082 $a ${ddc} is a DDC main class only. Check whether the book needs a more specific number.`);
  const kohaClass = String(firstValue(withTag('942')[0], 'h') || '').trim();
  const plain = value => value.replace(/[/']/g, '');
  if (ddc && kohaClass && plain(ddc) !== plain(kohaClass)) add('warning', '942', `942 $h (${kohaClass}) is not the 082 class number (${ddc}).`);
  if (ddc && withTag('942').length && !kohaClass) add('warning', '942', `942 $h is empty: Koha will not suggest the class number ${ddc} for items.`);

  // 245 indicators
  const title = withTag('245')[0];
  if (title) {
    const [ind1, ind2] = title.indicators || [' ', ' '];
    const expected1 = mainEntries.length ? '1' : '0';
    if (ind1 !== expected1) add('warning', '245', `245 indicator 1 should be ${expected1} (${mainEntries.length ? 'there is a main entry' : 'no main entry, title entry'}).`);
    const text = String(firstValue(title, 'a') || '');
    const article = text.match(/^(The|An|A) /);
    const skip = parseInt(ind2, 10) || 0;
    if (article && skip !== article[0].length) {
      add('warning', '245', `245 indicator 2 should be ${article[0].length} to skip "${article[1]}" when sorting.`);
    } else if (!article && skip && !/[\s']$/.test(text.slice(0, skip))) {
      add('warning', '245', `245 indicator 2 is ${skip}, but "${text.slice(0, skip)}" is not an article to skip.`);
    }
  }

  return problems.sort((x, y) => (x.level === 'error' ? 0 : 1) - (y.level === 'error' ? 0 : 1));
}

// --- Standard tag order ---

// Stable sort by tag, so repeated fields (e.g. 650s) keep their order. A row whose tag is
// not complete yet stays at the end.
function sortFields(fields) {
  const key = field => (/^\d{3}$/.test(field.tag || '') ? parseInt(field.tag, 10) : 1000);
  return fields
    .map((field, index) => ({field, index}))
    .sort((x, y) => key(x.field) - key(y.field) || x.index - y.index)
    .map(item => item.field);
}

// --- Other libraries' Koha OPACs as sources (Settings) ---

/**
 * One OPAC per line: "Name | https://opac.example.org", optionally with the library's Koha
 * SRU server: "Name | https://opac.example.org | sru=http://opac.example.org:9999/biblios",
 * or the SRU server alone: "Name | sru=…". An address alone is fine (the name is its host).
 * The OPAC address must be https; the SRU address may be http and on its own port (Koha's
 * Zebra server). "| api" takes each record from Koha's public REST API on the OPAC's host
 * (/api/v1/public/biblios/{id}), "| api=https://host" from another host. http is accepted
 * only for a Koha on this computer (localhost). Returns {opacs: [{name, base?, sru?, api?}], errors}.
 */
function parseKohaOpacs(text) {
  const opacs = [];
  const errors = [];
  const seen = new Set();
  const looksLikeAddress = part => /^(sru|api)\s*(=|$)/i.test(part) || /^[a-z]+:\/\//i.test(part) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(part);
  const local = url => /^(localhost|127\.0\.0\.1)$/.test(url.hostname);
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const parts = raw.split('|').map(part => part.trim()).filter(Boolean);
    if (!parts.length) return;
    const name = looksLikeAddress(parts[0]) ? '' : parts.shift();
    let base = '', sru = '', api = '', apiHere = false, bad = '';
    parts.forEach(part => {
      if (/^api$/i.test(part)) { apiHere = true; return; }
      const isApi = /^api\s*=/i.test(part);
      if (isApi) part = part.replace(/^api\s*=\s*/i, '');
      const isSru = /^sru\s*=/i.test(part);
      let address = part.replace(/^sru\s*=\s*/i, '');
      if (!/^[a-z]+:\/\//i.test(address)) address = `${isSru ? 'http' : 'https'}://${address}`;
      let url;
      try { url = new URL(address); } catch (error) { url = null; }
      if (!url || !(url.hostname.includes('.') || url.hostname === 'localhost')) { bad = 'write Name | https://opac.example.org (and, if the library has one, | sru=http://…:9999/biblios)'; return; }
      if (isApi) {
        if (url.protocol !== 'https:' && !local(url)) { bad = 'the API address must be https'; return; }
        api = url.origin;
        return;
      }
      if (isSru) {
        if (!/^https?:$/.test(url.protocol)) { bad = 'the SRU address must be http or https'; return; }
        sru = `${url.origin}${url.pathname.replace(/\/+$/, '') || '/biblios'}`;
      } else {
        if (url.protocol !== 'https:' && !local(url)) { bad = 'only https OPAC addresses can be searched (an SRU server may be http: write sru=…)'; return; }
        base = url.origin;
      }
    });
    if (apiHere) api = base;
    if (!bad && (api || apiHere) && !base) bad = 'the API has no search of its own: give the OPAC address too';
    if (bad || (!base && !sru)) { errors.push(`line ${i + 1}: ${bad || 'no address'}`); return; }
    const key = base || sru;
    if (seen.has(key)) return;
    seen.add(key);
    opacs.push({name: name || new URL(base || sru).hostname, ...(base ? {base} : {}), ...(sru ? {sru} : {}), ...(api ? {api} : {})});
  });
  return {opacs, errors};
}

// --- Fixed local fields (Settings) ---

/**
 * One field per line, like the Editor: "590 ## a:Purchased under UGC grant | b:2026"
 * ("#" or a space for a blank indicator). Control fields: "001 value".
 * Returns {fields, errors: ["line 2: …"]}.
 */
function parseLocalFields(text) {
  const fields = [];
  const errors = [];
  String(text || '').split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const control = line.match(/^(00\d)\s+(.+)$/);
    if (control) {
      fields.push({tag: control[1], value: control[2]});
      return;
    }
    const data = line.match(/^(\d{3})\s+([0-9#_ ]{2})\s+(.+)$/);
    if (!data) {
      errors.push(`line ${i + 1}: write tag, two indicators and subfields, e.g. 590 ## a:Note`);
      return;
    }
    const subfields = data[3].split('|').map(part => {
      const m = part.trim().match(/^([a-z0-9])\s*:\s*(.*)$/);
      return m ? {[m[1]]: m[2].trim()} : null;
    });
    if (!subfields.length || subfields.some(sf => !sf || !Object.values(sf)[0])) {
      errors.push(`line ${i + 1}: subfields must look like a:Text | b:Text`);
      return;
    }
    const indicators = [...data[2]].map(ch => (ch === '#' || ch === '_' ? ' ' : ch));
    fields.push({tag: data[1], indicators, subfields});
  });
  return {fields, errors};
}

// Add the local fields to a record (not twice), in tag order
function applyLocalFields(record, localFields) {
  if (!record || !Array.isArray(record.fields) || !localFields || !localFields.length) return record;
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  localFields.forEach(field => {
    if (!record.fields.some(existing => same(existing, field))) record.fields.push(JSON.parse(JSON.stringify(field)));
  });
  record.fields = sortFields(record.fields);
  return record;
}

// --- Export: MARC 21 transmission format (ISO 2709) and MARCXML ---

const FIELD_END = '\x1e';
const RECORD_END = '\x1d';
const SUBFIELD_START = '\x1f';
const stripControlChars = value => String(value == null ? '' : value).replace(/[\x00-\x1f]/g, ' ');

// Leader for export, with the lengths filled in. Koha's own default for a new book record
// is "     nam a22     7a 4500"; position 9 is "a" (UTF-8), and position 18 says whether
// ISBD punctuation is present ("a" AACR2 with punctuation, "c" ISBD punctuation omitted).
function exportLeader(record, recordLength, baseAddress) {
  const given = String((record && record.leader) || '').replace(/#/g, ' ');
  const at = (pos, fallback, allowed) => (given.length === 24 && allowed.test(given[pos]) ? given[pos] : fallback);
  return String(recordLength).padStart(5, '0') +
    at(5, 'n', /[acdnp]/) + at(6, 'a', /[a-z]/) + at(7, 'm', /[a-z]/) + ' a22' +
    String(baseAddress).padStart(5, '0') +
    at(17, '7', /[ 1-8uz]/) + at(18, 'c', /[ acinu]/) + ' 4500';
}

function exportableFields(record) {
  return ((record && record.fields) || []).filter(f => /^\d{3}$/.test(f.tag || ''));
}

// The ISO 2709 directory gives each field 4 digits for its length and the leader 5 digits
// for the record's, so MARC 21 allows at most 9,999 bytes in a field and 99,999 in a record
const MAX_FIELD_BYTES = 9999;
const MAX_RECORD_BYTES = 99999;
const utf8Length = text => new TextEncoder().encode(text).length;

// A field as written in an ISO 2709 file (with its field terminator)
function iso2709FieldBody(field) {
  if (parseInt(field.tag, 10) < 10) return stripControlChars(field.value) + FIELD_END;
  const ind = (field.indicators || [' ', ' ']).map(ch => (/^[0-9a-z ]$/.test(ch || ' ') ? ch || ' ' : ' ')).join('').padEnd(2, ' ');
  return ind + (field.subfields || []).map(sf => {
    const code = Object.keys(sf)[0];
    return SUBFIELD_START + code + stripControlChars(sf[code]);
  }).join('') + FIELD_END;
}

// Problems that would make a .mrc file unreadable: [{tag, bytes, max}]
function iso2709LengthProblems(record) {
  const fields = exportableFields(record);
  const problems = fields.map(field => ({tag: field.tag, bytes: utf8Length(iso2709FieldBody(field)), max: MAX_FIELD_BYTES}))
    .filter(p => p.bytes > p.max);
  const total = 24 + fields.length * 12 + 1 + fields.reduce((n, f) => n + utf8Length(iso2709FieldBody(f)), 0) + 1;
  if (total > MAX_RECORD_BYTES) problems.push({tag: 'record', bytes: total, max: MAX_RECORD_BYTES});
  return problems;
}

/**
 * One or more records as MARC 21 (ISO 2709, UTF-8) bytes. Throws, naming the field,
 * when a field or record is longer than MARC 21 allows (the file would be unreadable).
 */
function toIso2709(records) {
  const encoder = new TextEncoder();
  const parts = [];
  for (const record of records) {
    const tooLong = iso2709LengthProblems(record)[0];
    if (tooLong) {
      const title = String(firstValue(exportableFields(record).find(f => f.tag === '245'), 'a') || 'a record');
      throw new Error(tooLong.tag === 'record'
        ? `"${title}" is ${tooLong.bytes.toLocaleString('en-GB')} bytes; a MARC record can have at most 99,999. Shorten its longest fields, or download MARCXML.`
        : `${tooLong.tag} in "${title}" is ${tooLong.bytes.toLocaleString('en-GB')} bytes; a MARC field can have at most 9,999. Shorten it, or download MARCXML.`);
    }
    let directory = '';
    let data = '';
    let position = 0;
    for (const field of exportableFields(record)) {
      const body = iso2709FieldBody(field);
      const length = encoder.encode(body).length;
      directory += field.tag + String(length).padStart(4, '0') + String(position).padStart(5, '0');
      data += body;
      position += length;
    }
    directory += FIELD_END;
    const baseAddress = 24 + directory.length;
    const recordLength = baseAddress + position + 1;
    parts.push(encoder.encode(exportLeader(record, recordLength, baseAddress) + directory + data + RECORD_END));
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  parts.forEach(p => { out.set(p, offset); offset += p.length; });
  return out;
}

const xmlEscape = value => stripControlChars(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** One or more records as a MARCXML collection. */
function toMarcXml(records) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<collection xmlns="http://www.loc.gov/MARC21/slim">'];
  for (const record of records) {
    lines.push('  <record>');
    lines.push(`    <leader>${xmlEscape(exportLeader(record, 0, 0))}</leader>`);
    for (const field of exportableFields(record)) {
      if (parseInt(field.tag, 10) < 10) {
        lines.push(`    <controlfield tag="${field.tag}">${xmlEscape(field.value)}</controlfield>`);
        continue;
      }
      const [ind1, ind2] = (field.indicators || [' ', ' ']).map(ch => xmlEscape(ch === '#' ? ' ' : ch || ' '));
      lines.push(`    <datafield tag="${field.tag}" ind1="${ind1}" ind2="${ind2}">`);
      (field.subfields || []).forEach(sf => {
        const code = Object.keys(sf)[0];
        lines.push(`      <subfield code="${xmlEscape(code)}">${xmlEscape(sf[code])}</subfield>`);
      });
      lines.push('    </datafield>');
    }
    lines.push('  </record>');
  }
  lines.push('</collection>');
  return lines.join('\n') + '\n';
}

// --- Check headings: shared by the extension (sidebar) and the Koha plugin (panel) ---
// The heading as LC writes it, which LC file to ask, the library's authority records, and
// the form written back with AACR2 punctuation and $9 (the link to the authority record).

const HEADING_TAGS = ['100', '110', '111', '600', '610', '611', '650', '651', '700', '710', '711'];
const HEADING_SUBDIVISIONS = ['v', 'x', 'y', 'z'];
const HEADING_KEEP_CODES = ['e', '4', '2', '3', '5', '8'];   // kept from the record when a form is written

function isHeadingField(field) {
  return HEADING_TAGS.includes(field.tag) && headingValues(field, 'a').length > 0;
}

function headingValues(field, code) {
  return (field.subfields || []).filter(sf => Object.keys(sf)[0] === code).map(sf => String(Object.values(sf)[0]).trim()).filter(Boolean);
}

// Without ending punctuation; the full stop of an initial ("Smith, J. W.") stays
function headingBare(text) {
  return String(text).replace(/[\s,:;/]+$/, '').replace(/([^.A-Z])\.$/, '$1').trim();
}

/**
 * "Tagore, Rabindranath, 1861-1941", "Yeats, W. B. (William Butler), 1865-1939",
 * "United Nations. General Assembly", "India--History--1947-"
 */
function headingForm(field) {
  const t = String(field.tag).slice(1);
  const v = code => headingValues(field, code);
  let main;
  if (t === '10') main = [...v('a'), ...v('b')].map(headingBare).join('. ');
  else if (t === '11') main = [...v('a'), ...v('n'), ...v('d'), ...v('c')].map(headingBare).join(' ');
  else if (t === '00') {
    const name = [v('a')[0], v('b')[0], ...v('q')].filter(Boolean).map(headingBare).join(' ');
    main = [name, ...v('c'), ...v('d')].map(headingBare).filter(Boolean).join(', ');
  } else main = v('a').map(headingBare).join(' ');
  const subs = (field.subfields || []).filter(sf => HEADING_SUBDIVISIONS.includes(Object.keys(sf)[0]))
    .map(sf => headingBare(Object.values(sf)[0])).filter(Boolean);
  return [main, ...subs].filter(Boolean).join('--');
}

// The heading form of an authority record's 1XX: tag "100", subfields [[code, value], ...]
function authorityHeadingForm(tag, subfields) {
  const field = {tag, subfields: subfields.map(([c, v]) => ({[c]: v}))};
  return headingForm(field);
}

// For comparing forms: letters and digits only
function headingKey(text) {
  return String(text || '').toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Which LC file to ask: LCSH for 650/651, LC names for the others; a subject (6XX) only when
// its second indicator says LCSH. null: not asked.
function headingLcScheme(field) {
  if (/^6/.test(field.tag) && (field.indicators || [])[1] !== '0') return null;
  return /^65/.test(field.tag) ? 'subjects' : 'names';
}

// Koha's authority type for a heading field
function headingAuthorityType(tag) {
  return {'00': 'PERSO_NAME', '10': 'CORPO_NAME', '11': 'MEETI_NAME', '50': 'TOPIC_TERM', '51': 'GEOGR_NAME'}[String(tag).slice(1)] || '';
}

/**
 * AACR2/ISBD punctuation for a heading taken from an authority record or LC (they carry
 * none): "$a Tagore, Rabindranath, $d 1861-1941, $e author.", "$a United Nations.
 * $b General Assembly.", "$a India $x History." An open date ("1933-") takes nothing.
 */
function headingPunctuate(tag, subfields) {
  const t = String(tag).slice(1);
  const out = subfields.map(sf => ({[Object.keys(sf)[0]]: headingBare(Object.values(sf)[0])})).filter(sf => Object.values(sf)[0]);
  return out.map((sf, i) => {
    const c = Object.keys(sf)[0];
    const next = out[i + 1] ? Object.keys(out[i + 1])[0] : null;
    let v = sf[c];
    if (next === null || next === '4') { if (!/[-.?!)]$/.test(v)) v += '.'; }
    else if (t === '00' && ['c', 'd', 'e'].includes(next) && !/-$/.test(v)) v += ',';
    else if (t === '10' && next === 'b' && !/[.?!]$/.test(v)) v += '.';
    else if (t === '10' && next === 'e') v += ',';
    return {[c]: v};
  });
}

/**
 * Write a form into the record's field: subfields [{a: …}, {d: …}] with punctuation; the
 * record's relators ($e, $4), $2, $3, $5, $8 are kept; old links ($0, $9) are replaced by
 * $9 = authid when given. endingPunctuation is the library's rule (Settings › Cataloguing
 * rules): "remove" takes the ending punctuation off each subfield as the record builder does
 * (initials and abbreviations keep their full stop); "keep" (the default) writes AACR2's.
 */
function writeHeadingForm(field, subfields, authid = null, endingPunctuation = 'keep') {
  const kept = (field.subfields || []).filter(sf => HEADING_KEEP_CODES.includes(Object.keys(sf)[0]));
  const relators = kept.filter(sf => ['e', '4'].includes(Object.keys(sf)[0]));
  const rest = kept.filter(sf => !['e', '4'].includes(Object.keys(sf)[0]));
  let written = headingPunctuate(field.tag, [...subfields, ...relators]);
  if (endingPunctuation === 'remove' && typeof stripEndingPunctuation === 'function') {
    written = written.map(sf => { const code = Object.keys(sf)[0]; return {[code]: stripEndingPunctuation(sf[code])}; });
  }
  field.subfields = [...written, ...rest, ...(authid ? [{9: String(authid)}] : [])];
  return field;
}

// A form given as text (LC "USE", an OPAC result) as subfields: "Name, dates" into $a and $d,
// "Body. Unit" into $a and $b, a subject's subdivisions ("--") into $x
function headingTextToSubfields(tag, form) {
  const t = String(tag).slice(1);
  const [main, ...subs] = String(form).split('--').map(s => s.trim());
  let parts;
  const dated = t === '00' && main.match(/^(.*?),\s*((?:ca\.\s*|b\.\s*|d\.\s*|fl\.\s*)?\d{3,4}.*)$/);
  if (dated) parts = [{a: dated[1]}, {d: dated[2]}];
  else if (t === '10') parts = main.split(/\.\s+/).map((p, i) => ({[i ? 'b' : 'a']: p}));
  else parts = [{a: main}];
  return [...parts, ...subs.filter(Boolean).map(s => ({x: s}))];
}

// A heading field as the plugin's /authorities endpoint takes it
function headingWire(field) {
  return {tag: field.tag, ind1: (field.indicators || [' '])[0] || ' ', ind2: (field.indicators || [' ', ' '])[1] || ' ',
    subfields: (field.subfields || []).filter(sf => /^[a-z0-8]$/.test(Object.keys(sf)[0])).map(sf => [Object.keys(sf)[0], String(Object.values(sf)[0])])};
}

function headingDecode(text) {
  return String(text).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

/**
 * Koha's staff authority search results (authorities-home.pl): [{authid, heading, usage}].
 * The heading shown there loses its punctuation; the record itself gives the form.
 */
function parseStaffAuthorityResults(html) {
  const rows = String(html).split(/<tr\b/).slice(1);
  return rows.map(row => {
    const authid = (row.match(/data-authid="(\d+)"/) || row.match(/authid=(\d+)/) || [])[1];
    const heading = (row.match(/<span class="authorizedheading[^"]*">\s*<a[^>]*>([\s\S]*?)<\/a>/) || row.match(/class="authorizedheading"[^>]*>([\s\S]*?)<\/(?:div|span)>/) || [])[1];
    const usage = (row.match(/>\s*(\d+)\s*record\(?s?\)?\s*</) || [])[1];
    return authid && heading ? {authid: +authid, heading: headingDecode(heading.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(), usage: usage ? +usage : 0} : null;
  }).filter(Boolean).filter((r, i, all) => all.findIndex(x => x.authid === r.authid) === i);
}

// The 1XX of an authority record in MARCXML: {tag, subfields: [[code, value], ...]}
function authorityMainHeading(xml) {
  const m = String(xml).match(/<(?:\w+:)?datafield[^>]*tag="(1\d\d)"[^>]*>([\s\S]*?)<\/(?:\w+:)?datafield>/);
  if (!m) return null;
  const subfields = [...m[2].matchAll(/<(?:\w+:)?subfield[^>]*code="([a-z0-9])"[^>]*>([\s\S]*?)<\/(?:\w+:)?subfield>/g)]
    .map(s => [s[1], headingDecode(s[2]).trim()]).filter(([c, v]) => /[a-z]/.test(c) && v);
  return {tag: m[1], subfields};
}

/**
 * One heading's result from the library's authorities, the same shape on every route:
 * {matches: [{authid, heading, subfields, usage, same}], via?}. via "see": none has the
 * record's form (found under a "see from" form).
 */
function authorityMatches(field, found) {
  const want = headingKey(headingForm(field));
  const matches = found.map(m => {
    const heading = m.subfields && m.subfields.length ? authorityHeadingForm(m.tag || `1${String(field.tag).slice(1)}`, m.subfields) : m.heading;
    return {authid: m.authid, heading, subfields: m.subfields && m.subfields.length ? m.subfields : headingTextToSubfields(field.tag, m.heading).map(sf => [Object.keys(sf)[0], Object.values(sf)[0]]),
      usage: m.usage || 0, same: headingKey(heading) === want ? 1 : 0};
  });
  matches.sort((x, y) => y.same - x.same);
  return {matches, ...(matches.length && !matches.some(m => m.same) ? {via: 'see'} : {})};
}

// --- AI Helper: shared by the extension (side panel) and the Koha plugin (panel) ---
// The AI's suggestions are read here and added to the record only when the cataloguer
// clicks Add. The prompts and provider calls are in background.js (handleAiHelper).

const AI_FIELD_CHOICES = [
  {key: '082', label: '082 (Classification)', checked: true},
  {key: '500', label: '500 (General Note)', checked: true},
  {key: '650_lcsh', label: '650 (LCSH Subject)', checked: true},
  {key: '650_sears', label: '650 (Sears Subject)', checked: false},
  {key: '246', label: '246 (Transliterated title)', checked: false, nonLatinOnly: true}
];

// Linking/control subfields a model cannot know: $0/$1 authority identifiers, $6 linkage,
// $8 field link, $9 Koha authority number. Models sometimes misuse them (e.g. "0:Textbooks").
const AI_EXCLUDED_SUBFIELDS = new Set(['0', '1', '6', '8', '9']);

// AI helper keys such as "650_lcsh" map to a plain MARC tag
function marcTagForAiKey(tagKey) {
  return tagKey.split('_')[0];
}

/**
 * One AI suggestion as [{code: value}, ...]. Accepts the requested "a:Value | x:Value"
 * format and the MARC display forms models sometimes return instead: "500 0 a Note",
 * "650 #0 $a Term $x Sub", "$a Note". keepPunctuation: the library keeps ISBD punctuation
 * (otherwise ending punctuation goes, as in generated records).
 */
function aiSubfields(text, marcTag, keepPunctuation = false) {
  return parseAiSubfieldsRaw(text, marcTag)
    .filter(sf => !AI_EXCLUDED_SUBFIELDS.has(Object.keys(sf)[0]))
    .map(sf => {
      const code = Object.keys(sf)[0];
      return {[code]: keepPunctuation ? sf[code].trim() : stripEndingPunctuation(sf[code])};
    })
    .filter(sf => Object.values(sf)[0]);
}

function parseAiSubfieldsRaw(text, marcTag) {
  let line = (text || '').trim();
  // Drop a leading tag and indicators, e.g. "500 ", "500 0 ", "650 #0 "
  const withoutTag = line.replace(new RegExp(`^${marcTag}\\s+(?:[0-9#_]{1,2}\\s+)?`), '');
  const hadTagPrefix = withoutTag !== line;
  line = withoutTag;
  if (line.includes('$')) {
    return line.split('$').slice(1).map(part => part.trim()).filter(Boolean)
      .map(part => ({[part.charAt(0)]: part.slice(1).trim()}));
  }
  if (/^[a-z0-9]\s*:/.test(line)) {
    return line.split('|').map(segment => {
      const [code, ...rest] = segment.split(':');
      if (!code || rest.length === 0) return null;
      return {[code.trim()]: rest.join(':').trim()};
    }).filter(Boolean);
  }
  // "a Note text" – only trusted after a tag prefix, so notes starting with "A " are not misread
  const single = hadTagPrefix && line.match(/^([a-z0-9])\s+(.+)$/);
  if (single) return [{[single[1]]: single[2].trim()}];
  return line ? [{a: line}] : [];
}

function subfieldsToString(subfields) {
  return subfields.map(sf => `${Object.keys(sf)[0]}:${Object.values(sf)[0]}`).join(' | ');
}

// What the AI is told about the book, from the record
function aiBiblioInfo(record) {
  const firstSubfield = (tag, code) => {
    const field = ((record && record.fields) || []).find(f => f.tag === tag && (f.subfields || []).some(sf => sf[code]));
    return field ? field.subfields.find(sf => sf[code])[code] : '';
  };
  // Without ISBD punctuation (" :", " /", trailing ".")
  const clean = value => (value || '').replace(/\s*[:/;]\s*$/, '').trim();
  return {
    title: clean(firstSubfield('245', 'a')),
    subtitle: clean(firstSubfield('245', 'b')),
    author: firstSubfield('100', 'a') || firstSubfield('700', 'a'),   // main entry first
    publisher: firstSubfield('260', 'b') || firstSubfield('264', 'b'),
    year: firstSubfield('260', 'c') || firstSubfield('264', 'c'),
    summary: firstSubfield('520', 'a')
  };
}

// The 246 transliteration is offered only for titles in a non-Latin script
function aiTitleIsNonLatin(record) {
  const field245 = ((record && record.fields) || []).find(f => f.tag === '245');
  const title = ((field245 && field245.subfields) || []).filter(sf => 'ab'.includes(Object.keys(sf)[0])).map(sf => Object.values(sf)[0]).join(' ');
  return [...title].some(ch => /\p{L}/u.test(ch) && !/\p{Script=Latin}/u.test(ch));
}

// Koha builds the items' call number from 942 $2 (classification source) and $h (class
// part), so a class number added to 082 goes there too. $c (item type), $i (item number)
// and any other subfield are kept, in the order the record builder uses: $2 $c $h $i.
function setKoha942ClassNumber(record, ddc, itemType = 'BK') {
  let field = record.fields.find(f => f.tag === '942');
  if (!field) {
    field = {tag: '942', indicators: [' ', ' '], subfields: [{c: itemType || 'BK'}]};
    record.fields.push(field);
  }
  const rest = (field.subfields || []).filter(sf => !('2' in sf) && !('h' in sf));
  const first = code => rest.filter(sf => code in sf);
  field.subfields = [{2: 'ddc'}, ...first('c'), {h: ddc}, ...first('i'), ...rest.filter(sf => !('c' in sf) && !('i' in sf))];
}

/**
 * Add one reviewed suggestion to the record. 650 LCSH as 650 #0, Sears as 650 #8, 246 as
 * 246 3#; 082 goes into the existing 082 (its item number $b kept, a source's $2 dropped)
 * and into 942 $h. Returns {ok, message}.
 */
function addAiSuggestion(record, tagKey, text, settings = {}) {
  let marcTag = tagKey;
  let ind1 = ' ';
  let ind2 = ' ';
  if (tagKey === '650_lcsh') { marcTag = '650'; ind2 = '0'; }
  else if (tagKey === '650_sears') { marcTag = '650'; ind2 = '8'; }
  else if (tagKey === '246') ind1 = '3';   // 246 3#: no note, added entry (transliterated title)
  const subfields = aiSubfields(text, marcTag, settings.ruleEndingPunctuation === 'keep');
  if (!subfields.length) return {ok: false, message: 'Nothing to add – the suggestion is empty.'};
  const classNumber = subfields.find(sf => sf.a);
  const existing082 = marcTag === '082' ? record.fields.find(f => f.tag === '082') : null;
  if (existing082 && classNumber) {
    existing082.subfields = [{a: classNumber.a}, ...(existing082.subfields || []).filter(sf => !('a' in sf) && !('2' in sf))];
    setKoha942ClassNumber(record, classNumber.a, settings.itemType);
    return {ok: true, message: `Updated 082 $a and 942 $h to ${classNumber.a} (item number kept).`};
  }
  record.fields.push({tag: marcTag, indicators: [ind1, ind2], subfields});
  if (marcTag === '082' && classNumber) {
    setKoha942ClassNumber(record, classNumber.a, settings.itemType);
    return {ok: true, message: `Added 082 and set 942 $h to ${classNumber.a}.`};
  }
  return {ok: true, message: `Added field ${marcTag} to record.`};
}

// --- Batch cataloguing: shared by the extension (Batch tab) and the Koha plugin (batch page) ---

/**
 * An ISBN (10 or 13 characters) or an ISSN (8, written "0028-0836" or "00280836") in a line of
 * a batch list: {type: 'isbn' | 'issn', value, valid} or null. A wrong check digit is kept
 * (valid false): it is still searched, and a record found is marked for checking.
 */
function standardNumber(text) {
  const raw = String(text || '').trim().replace(/^(isbn|issn)\s*:?\s*/i, '');
  const isbn = isbnDigits(raw);
  if (/^(97[89]\d{9}[\dX]|\d{9}[\dX])$/.test(isbn)) {   // "9780262033848 (pbk.)" too
    return {type: 'isbn', value: isbn, valid: isbnValid(isbn)};
  }
  if (/^\d{4}[\s-]?\d{3}[\dXx]$/.test(raw)) {
    const value = formatIssn(raw);
    return {type: 'issn', value, valid: issnValid(value)};
  }
  return null;
}

// Does this search result carry the ISBN (either form)? Checked in its own ISBN and in
// the 020s of a harvested catalogue record.
function bookHasIsbn(book, isbn) {
  const wanted = toIsbn13(isbn);
  const candidates = [book.isbn, ...((book.marcFields || []).filter(f => f.tag === '020')
    .flatMap(f => (f.subfields || []).map(sf => sf.a).filter(Boolean)))];
  return candidates.some(value => toIsbn13(value) === wanted);
}

// A print serial with this ISSN
function bookHasIssn(book, issn) {
  return !!book.serial && !book.online && (book.issns || [book.issn]).includes(formatIssn(issn));
}

// The highest-priority source's record for this exact ISBN or ISSN (results arrive in priority order)
function pickExactRecord(results, number) {
  const n = standardNumber(number);
  if (!n) return null;
  return (results || []).find(book => (n.type === 'issn' ? bookHasIssn(book, n.value) : bookHasIsbn(book, n.value))) || null;
}
