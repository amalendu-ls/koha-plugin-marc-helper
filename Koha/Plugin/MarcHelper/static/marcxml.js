/*
  Minimal MARC readers for harvested catalogue records: MARCXML from SRU
  (Library of Congress, K10plus) and IndCat's HTML "MARC View".
  The MV3 service worker has no DOMParser, so this uses regular expressions
  over the well-defined MARCXML structure.
*/

function decodeXmlEntities(text) {
  return (text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlAttr(attrs, name) {
  const match = attrs.match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? match[1] : '';
}

/**
 * Parse an SRU/MARCXML document into
 * [{control: {'008': '...'}, fields: [{tag, ind1, ind2, subfields: [[code, value], ...]}]}]
 */
function parseMarcXml(xml) {
  const recordBodies = [];
  const recordDataRe = /<(?:\w+:)?recordData>([\s\S]*?)<\/(?:\w+:)?recordData>/g;
  let match;
  while ((match = recordDataRe.exec(xml)) !== null) recordBodies.push(match[1]);
  // Plain MARCXML (a <collection> of <record>s, e.g. LIBRIS): one body per record
  if (recordBodies.length === 0) {
    const plainRe = /<(?:\w+:)?record\b[^>]*>([\s\S]*?)<\/(?:\w+:)?record>/g;
    while ((match = plainRe.exec(xml)) !== null) recordBodies.push(match[1]);
  }
  if (recordBodies.length === 0 && /<(?:\w+:)?datafield\b/.test(xml)) recordBodies.push(xml);

  return recordBodies.map(body => {
    const record = {control: {}, fields: []};
    const leader = body.match(/<(?:\w+:)?leader>([\s\S]*?)<\/(?:\w+:)?leader>/);
    record.leader = leader ? decodeXmlEntities(leader[1]).replace(/\^/g, ' ') : '';

    const controlRe = /<(?:\w+:)?controlfield\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?controlfield>/g;
    while ((match = controlRe.exec(body)) !== null) {
      // Some systems (e.g. Alma) write blanks in fixed fields as "^"
      record.control[xmlAttr(match[1], 'tag')] = decodeXmlEntities(match[2]).replace(/\^/g, ' ');
    }

    const dataRe = /<(?:\w+:)?datafield\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?datafield>/g;
    while ((match = dataRe.exec(body)) !== null) {
      const subfields = [];
      const subRe = /<(?:\w+:)?subfield\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?subfield>/g;
      let sub;
      while ((sub = subRe.exec(match[2])) !== null) {
        let value = decodeXmlEntities(sub[2]).trim();
        // LCCN blanks written as "^" (e.g. "^^2006041982")
        if (xmlAttr(match[1], 'tag') === '010') value = value.replace(/\^/g, ' ').trim();
        subfields.push([xmlAttr(sub[1], 'code'), value]);
      }
      record.fields.push({
        tag: xmlAttr(match[1], 'tag'),
        ind1: xmlAttr(match[1], 'ind1') || ' ',
        ind2: xmlAttr(match[1], 'ind2') || ' ',
        subfields
      });
    }
    return record;
  });
}

/**
 * Parse the "MARC View" table of an IndCat (INFLIBNET) record page into the
 * same structure as parseMarcXml(). Rows look like
 *   <tr><td>245</td><td>__</td><td>|aTitle|cby Name</td></tr>
 * where "_" in the indicator cell means blank.
 */
function parseIndcatMarcView(html) {
  const record = {control: {}, fields: []};
  const rowRe = /<tr\s*>\s*<td[^>]*>(\d{3})<\/td>([\s\S]*?)<\/tr>/g;
  let match;
  while ((match = rowRe.exec(html)) !== null) {
    const tag = match[1];
    const cells = [...match[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => decodeXmlEntities(c[1].replace(/<[^>]*>/g, '')));
    const content = cells[cells.length - 1] || '';
    if (parseInt(tag, 10) < 10) {
      record.control[tag] = content;
      continue;
    }
    const indicators = (cells.length > 1 ? cells[0] : '').replace(/_/g, ' ').padEnd(2, ' ');
    const subfields = content.split('|').slice(1)
      .filter(part => part.length > 0)
      .map(part => [part.charAt(0), part.slice(1).trim()]);
    record.fields.push({tag, ind1: indicators[0], ind2: indicators[1], subfields});
  }
  return record;
}

// Remove trailing ISBD punctuation (" /", " :", " ;", ",", ".", " =")
function trimIsbd(value) {
  return (value || '').replace(/[\s/:;,=.]+$/, '').trim();
}

// "Cormen, Thomas H." → "Thomas H. Cormen"
function directOrderName(heading) {
  const [surname, ...rest] = heading.split(',');
  const forenames = rest.join(',').trim();
  return forenames ? `${forenames} ${surname.trim()}` : surname.trim();
}

// "3. ed." / "3. Aufl." (German practice) → "3rd ed."; keeps the "ed." abbreviation
function normalizeEdition(value) {
  const text = (value || '').replace(/[\s/:;,=]+$/, '');
  const match = text.match(/^(\d+)\.\s*(ed\.?|edition|aufl\.?|auflage)$/i);
  if (!match) return /\bed$/i.test(text) ? `${text}.` : text;
  const n = parseInt(match[1], 10);
  const suffix = (n % 100 >= 11 && n % 100 <= 13) ? 'th' : ({1: 'st', 2: 'nd', 3: 'rd'}[n % 10] || 'th');
  return `${n}${suffix} ed.`;
}

/**
 * Convert a parsed MARC record into the extension's book object.
 * `options.englishCataloguing` — true when the source catalogues in English,
 * so its illustration statements and subject headings can be reused as-is;
 * 'auto' decides per record from 040 $b (language of cataloguing), for catalogues
 * that hold records in several languages: only "eng" counts, nothing is assumed.
 */
function marcRecordToBook(record, source, options = {}) {
  // Placeholder text ("NULL", "N/A") is treated as a missing subfield
  record = {...record, fields: record.fields
    .map(f => ({...f, subfields: (f.subfields || []).filter(([, value]) => !isPlaceholder(value))}))
    .filter(f => f.subfields.length)};
  const fieldsByTag = tag => record.fields.filter(f => f.tag === tag);
  const sub = (field, code) => (field?.subfields.find(([c]) => c === code) || [])[1] || '';
  // 'auto': 040 $b (language of cataloguing) decides; many library catalogues leave it out,
  // and then the record's own language (008/35-37, 041 $a) decides, English only
  const cataloguedIn = fieldsByTag('040').map(f => sub(f, 'b').trim().toLowerCase()).find(Boolean);
  const recordLanguage = [String((record.control || {})['008'] || '').slice(35, 38), ...fieldsByTag('041').map(f => sub(f, 'a'))]
    .map(value => String(value).trim().toLowerCase());
  const english = options.englishCataloguing === 'auto'
    ? (cataloguedIn ? cataloguedIn === 'eng' : recordLanguage.some(value => value === 'eng' || value === 'english'))
    : !!options.englishCataloguing;
  const first = (tags, code) => {
    for (const tag of tags) {
      const field = fieldsByTag(tag).find(f => sub(f, code));
      if (field) return sub(field, code);
    }
    return '';
  };

  // Koha's non-filing markers ("<<A>> critical survey…") are not part of the title
  const nonSort = text => String(text || '').replace(/<<|>>||/g, '');
  let title = trimIsbd(nonSort(first(['245'], 'a')));
  if (!title) return null;
  let subtitle = trimIsbd(nonSort(first(['245'], 'b')));
  // Some catalogues keep "Title : subtitle" together in $a
  if (!subtitle && title.includes(' : ')) {
    subtitle = title.slice(title.indexOf(' : ') + 3).trim();
    title = title.slice(0, title.indexOf(' : ')).trim();
  }

  // Personal names: 100 main entry, then 700 added entries (skip name/title entries)
  const nameFields = [...fieldsByTag('100'), ...fieldsByTag('700').filter(f => !sub(f, 't'))];
  const authorHeadings = nameFields.map(f => trimIsbd(sub(f, 'a'))).filter(Boolean);

  // Publication: prefer 264 _1 (publication), fall back to 260
  const pubField = fieldsByTag('264').find(f => f.ind2 === '1') || fieldsByTag('260')[0];
  // Keep a final period: it usually ends an abbreviation ("Mineola, N.Y.", "Cambridge, Mass.")
  const place = sub(pubField, 'a').replace(/\[(u\.\s?a\.|etc\.?)\]/gi, '').replace(/[[\]]/g, '').replace(/[\s:;,/=]+$/, '').trim();
  const dateMatch = sub(pubField, 'c').match(/\d{4}/);

  // ISBNs: keep the searched one when this record carries it
  const isbns = fieldsByTag('020')
    .map(f => (sub(f, 'a').replace(/-/g, '').match(/[\dX]{13}|[\dX]{10}/i) || [])[0])
    .filter(Boolean);
  const isbn = (options.isbn && isbns.includes(options.isbn)) ? options.isbn : (isbns[0] || '');

  const physical = fieldsByTag('300')[0];
  const extent = sub(physical, 'a').replace(/\s*[:;+]\s*$/, '').replace(/\bS\.?$/, 'p.')
    .replace(/^(\d+)$/, '$1 p.');  // bare page count

  // LCSH headings (650 _0) with subdivisions, in MARC subfield order
  const lcshHeadings = fieldsByTag('650')
    .filter(f => f.ind2 === '0')
    .map(f => f.subfields
      .filter(([code]) => 'axyzv'.includes(code))
      .map(([code, value]) => ({[code]: trimIsbd(value)})))
    .filter(heading => heading.length > 0);

  // Serials (leader/07 "s"): their ISSNs (022 $a), and whether the record is for the online
  // version (008/23 "o" or "s", 338 online resource, 007 "cr"); this extension catalogues print
  const issnOf = value => { const d = String(value || '').toUpperCase().replace(/[^0-9X]/g, ''); return /^\d{7}[\dX]$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4)}` : ''; };
  const issns = fieldsByTag('022').map(f => issnOf(sub(f, 'a'))).filter(Boolean);
  const serial = String(record.leader || '').charAt(7) === 's';
  const online = serial && (/^[os]$/.test(String(record.control['008'] || '').charAt(23))
    || fieldsByTag('338').some(f => /online resource/i.test(sub(f, 'a'))) || /^cr/.test(String(record.control['007'] || '')));

  const notes = fieldsByTag('500').map(f => sub(f, 'a')).join(' ');
  const lang = (record.control['008'] || '').slice(35, 38).trim();
  // 008/15-17 country of publication as coded by the source catalogue
  const country = (record.control['008'] || '').slice(15, 18).trim();

  return {
    title: title.charAt(0).toUpperCase() + title.slice(1),
    subtitle,
    authors: authorHeadings.map(directOrderName),
    authorHeadings,
    authorDates: trimIsbd(sub(fieldsByTag('100')[0], 'd')),
    publisher: trimIsbd(sub(pubField, 'b')),
    publicationPlace: place,
    publishedDate: dateMatch ? dateMatch[0] : '',
    edition: normalizeEdition(first(['250'], 'a')),
    isbn,
    serial,
    online,
    issns,
    issn: (options.issn && issns.includes(options.issn)) ? options.issn : (issns[0] || ''),
    frequency: trimIsbd(first(['310'], 'a')),
    // Keep only the class number (some records append book numbers or a second class)
    ddc: (first(['082'], 'a').replace(/[/']/g, '').match(/^\d{3}(\.\d+)?/) || [''])[0] || options.fallbackDdc || '',
    physicalDescription: extent,
    illustrations: english ? sub(physical, 'b').replace(/[\s:;]+$/, '') : '',
    size: sub(physical, 'c').replace(/\s*;\s*$/, ''),
    seriesTitle: trimIsbd(first(['490'], 'a')),
    seriesVolume: trimIsbd(first(['490'], 'v')),
    hasIndex: /\bindex/i.test(notes),
    hasBibliography: fieldsByTag('504').length > 0,
    description: first(['520'], 'a'),
    // LCSH first; then topical headings with no thesaurus given (2nd indicator blank or 4,
    // common in library catalogues), which the record builder adds as uncontrolled 650 #4
    subjects: english ? [...lcshHeadings.map(h => Object.values(h[0])[0]),
      ...fieldsByTag('650').filter(f => [' ', '4', '#', ''].includes(f.ind2 || ' ')).map(f => trimIsbd(sub(f, 'a'))).filter(Boolean)] : [],
    lcshHeadings,
    language: /^[a-z]{3}$/.test(lang) ? lang : '',
    countryCode: /^[a-z]{2,3}$/.test(country) && country !== 'xx' ? country : '',
    // Full source record, so the builder can carry standard fields through
    marcFields: record.fields.map(f => ({
      tag: f.tag, ind1: f.ind1, ind2: f.ind2,
      subfields: f.subfields.map(([code, value]) => ({[code]: value}))
    })),
    marcSourceEnglish: english,
    source008: record.control['008'] || '',
    statementOfResponsibility: first(['245'], 'c'),
    partNumber: trimIsbd(first(['245'], 'n')),
    partName: trimIsbd(first(['245'], 'p')),
    nonfilingChars: (fieldsByTag('245')[0] || {}).ind2 || '',
    source
  };
}
