/*
  Helper functions for building MARC 21 JSON records.
  Strictly compliant with AUTHORITYFILES.md rules.
*/

function sanitizeText(value) {
  const text = (value || "").toString().trim();
  return isPlaceholder(text) ? "" : text;
}

// Text some catalogues export in place of leaving a subfield out ("NULL", "N/A")
function isPlaceholder(value) {
  return /^(?:null|n\/a|nil|undefined)[\s.:;,/]*$/i.test(String(value == null ? "" : value).trim());
}

// --- Capitals (AACR2 Appendix A) -----------------------------------------------------
// Some catalogues hold records in capital letters ("HUBBARD, L.RON"). Such text is given
// normal capitals: the form another source has for the same words is used first; other-
// wise names and publishers get a capital for each word, titles and notes sentence case
// (with the names found in the record kept capitalised). Check record lists the fields,
// because a program cannot know every proper noun in a title.

// Text in capitals: no small letters, and a word of three or more capitals ("HUBBARD"),
// so abbreviations such as "B.C.", "A.D." or "U.S." alone do not count (scripts without case never match)
function isAllCaps(value) {
  const text = String(value || "");
  return text === text.toUpperCase() && text !== text.toLowerCase() && /\p{Lu}{3,}/u.test(text);
}

const caseKey = value => String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const SMALL_WORDS = new Set(["a", "an", "and", "as", "at", "by", "da", "de", "del", "der", "des", "di", "du", "for", "from",
  "in", "la", "le", "of", "on", "or", "the", "to", "und", "van", "von", "with"]);
const ROLE_WORDS = new Set(["by", "and", "general", "chief", "series", "associate", "consulting", "contributing", "assistant", "managing", "from", "into", "edited", "editor", "editors", "ed.", "eds.", "translated", "translator", "compiled",
  "illustrated", "introduction", "foreword", "preface", "with", "an", "a", "the", "of", "et", "al.", "al", "revised", "written",
  "selected", "notes", "commentary", "assisted"]);
const ROMAN = /^[ivxlcdm]+[.,;:]?$/i;

function capitalFirst(word) {
  // Only a word that begins with a letter ("1st" stays "1st")
  return word.replace(/^([^\p{L}\p{N}]*)(\p{L})/u, (m, before, letter) => before + letter.toUpperCase())
    .replace(/^(\p{L}')(\p{L})/u, (m, start, letter) => start + letter.toUpperCase());  // O'Neil
}

// Each word capitalised; small linking words lower case except at the start
function wordCase(value, lowerWords = SMALL_WORDS, lowerAtStart = false) {
  return String(value).toLowerCase().split(/(\s+)/).map((part, i) => {
    if (/^\s+$/.test(part) || !part) return part;
    if (ROMAN.test(part) && part.length > 1 && !/^(mix|mid|dim|did|mild|vivid|civil|liv)$/i.test(part.replace(/[.,;:]$/, ""))) return part.toUpperCase();
    if ((i > 0 || lowerAtStart) && (lowerWords.has(part) || lowerWords.has(part.replace(/[.,;:]+$/, "")))) return part;
    return part.split("-").map(capitalFirst).join("-");
  }).join("");
}

// Personal and corporate names: "HUBBARD, L.RON" -> "Hubbard, L. Ron"
const nameCase = value => wordCase(String(value).replace(/\.(?=\p{L})/gu, ". "));

// Sentence case: the first word capitalised, and words known as names in this record
function sentenceCase(value, keep, capitaliseFirst = true) {
  // In text that is not all capitals, a word in capitals is an acronym and stays ("CA IPCC")
  const acronyms = isAllCaps(value) ? [] : (String(value).match(/\b\p{Lu}{2,}\b/gu) || []);
  const text = String(value).toLowerCase().replace(/(^|\s)i(?=\s|$)/g, "$1I")
    .replace(/[\p{L}'’-]+/gu, word => acronyms.find(a => a.toLowerCase() === word) || word);
  const kept = text.replace(/[\p{L}'’-]+/gu, word => keep.get(word) || word);
  return capitaliseFirst ? capitalFirst(kept) : kept;
}

const NAME_TAGS = new Set(["100", "110", "111", "600", "610", "611", "700", "710", "711", "800", "810", "811"]);
const CASE_TAG = /^(?:1[01][01]|130|24[0-6]|250|26[04]|300|4[49]0|5\d\d|6[0-5]\d|7[0-4]\d|8[0-3]\d)$/;
const TEXT_CODES = /^[a-z]$/;

// A title with a capital for every word ("Introduction To International Relations"):
// at least three words, and a small linking word capitalised, which sentence case never does
function isTitleCase(value, minimum = 3) {
  const words = String(value || "").match(/\p{L}[\p{L}'’-]*/gu) || [];
  const main = words.filter(w => !SMALL_WORDS.has(w.toLowerCase()));
  // Acronyms ("CA", "IPCC") do not count as capitalised words
  const capitalised = main.filter(w => /^\p{Lu}\p{Ll}/u.test(w));
  return capitalised.length >= minimum && main.every(w => /^\p{Lu}/u.test(w)) && !isAllCaps(value);
}

// Words written with a capital in this record or in other sources: proper nouns to keep
// (firstWords: also a capitalised first word, as in a heading "Scientology")
function properWords(values, firstWords = true) {
  const words = new Map();
  values.filter(v => typeof v === "string" && v && !isAllCaps(v) && !isTitleCase(v)).forEach(v => {
    (v.match(/[\p{L}'’-]+/gu) || []).forEach((word, i) => {
      if (/^\p{Lu}/u.test(word) && (i > 0 || (firstWords && /^\p{Lu}\p{Ll}+$/u.test(word))) && word.length > 1 && !SMALL_WORDS.has(word.toLowerCase())) {
        words.set(word.toLowerCase(), word);
      }
    });
  });
  return words;
}

function fixCapitals(record, book = {}) {
  const others = Array.isArray(book.caseForms) ? book.caseForms : [];
  const known = new Map();
  others.filter(v => typeof v === "string" && v && !isAllCaps(v)).forEach(v => { if (!known.has(caseKey(v))) known.set(caseKey(v), v); });
  const recordValues = record.fields.flatMap(f => (f.subfields || []).map(sf => Object.values(sf)[0]));
  const keep = properWords([...recordValues, ...others]);
  // Surnames and forenames from the record's own names count as proper nouns too
  record.fields.filter(f => NAME_TAGS.has(f.tag)).forEach(f => (f.subfields || []).forEach(sf => {
    if (Object.keys(sf)[0] !== "a") return;
    (nameCase(sf.a).match(/[\p{L}'’-]+/gu) || []).forEach(word => { if (word.length > 1) keep.set(word.toLowerCase(), word); });
  }));
  // For titles in Title Case only real proper nouns count: the names of people, organisations
  // and places in the record (other text, such as a summary, also capitalises subject terms)
  const titleKeep = new Map();
  record.fields.filter(f => NAME_TAGS.has(f.tag) || /^651$/.test(f.tag)).forEach(f => (f.subfields || []).forEach(sf => {
    const code = Object.keys(sf)[0];
    if (!(code === "a" || (f.tag === "651" && code === "z"))) return;
    (nameCase(sf[code]).match(/[\p{L}'’-]+/gu) || []).forEach(word => { if (word.length > 1 && !SMALL_WORDS.has(word.toLowerCase())) titleKeep.set(word.toLowerCase(), word); });
  }));
  record.fields.filter(f => /^65[01]$/.test(f.tag)).forEach(f => (f.subfields || []).forEach(sf => {
    if (Object.keys(sf)[0] === "z") (String(sf.z).match(/[\p{L}'’-]+/gu) || []).forEach(word => titleKeep.set(word.toLowerCase(), word));
  }));
  const changed = [];
  record.fields.forEach(field => {
    if (!CASE_TAG.test(field.tag) || !field.subfields) return;
    if (field.tag === "245") field.subfields.forEach((sf, i) => {
      const code = Object.keys(sf)[0];
      // a subtitle needs two capitalised words ("the Fundamentals of Thought"), a title three
      if (!"ab".includes(code) || !isTitleCase(sf[code], code === "b" ? 2 : 3)) return;
      // Another source with the same title in sentence case gives its form
      const other = known.get(caseKey(sf[code]));
      const trail = (String(sf[code]).match(/[\s.,:;/=]+$/) || [""])[0];
      const sameShape = other && (other.match(/[:;=/]/g) || []).length === (String(sf[code]).match(/[:;=/]/g) || []).length;
      const result = sameShape && !isTitleCase(other) ? other.replace(/[\s.,:;/=]+$/, "") + trail
        : sentenceCase(sf[code], titleKeep, code === "a" || i === 0);
      if (result !== sf[code]) { sf[code] = result; if (!changed.includes("245")) changed.push("245"); }
    });
    let fixed = false;
    field.subfields.forEach((sf, i) => {
      const code = Object.keys(sf)[0];
      const value = sf[code];
      // In 245 $c the words "by", "edited by" … may be lower case around names in capitals
      const caps = field.tag === "245" && code === "c"
        ? isAllCaps(String(value).split(/\s+/).filter(w => !ROLE_WORDS.has(w)).join(" "))
        : field.tag === "300" ? /\p{Lu}/u.test(String(value)) && String(value) === String(value).toUpperCase()
          : isAllCaps(value);
      if (!TEXT_CODES.test(code) || !caps) return;
      if (/^[17]1[01]$|^61[01]$/.test(field.tag) && !/\s/.test(String(value).trim())) return;
      const trail = (String(value).match(/[\s.,:;/=]+$/) || [""])[0];
      const other = known.get(caseKey(value));
      let result;
      if (other) result = other.replace(/[\s.,:;/=]+$/, "") + trail;
      else if (NAME_TAGS.has(field.tag) && "abcdq".includes(code)) result = nameCase(value);
      else if (field.tag === "245" && code === "c") result = wordCase(String(value).replace(/\.(?=\p{L})/gu, ". "), ROLE_WORDS, true);
      else if (/^26[04]$/.test(field.tag) && "ab".includes(code)) result = wordCase(value);
      else if (field.tag === "300") result = String(value).toLowerCase();
      else if (field.tag === "651" || (field.tag === "650" && code === "z")) result = wordCase(value);
      else result = sentenceCase(value, keep, !(field.tag === "245" && code === "b") || i === 0);
      if (result !== value) { sf[code] = result; fixed = true; }
    });
    if (fixed && !changed.includes(field.tag)) changed.push(field.tag);
  });
  if (changed.length) record.caseChanged = changed;
  return record;
}

// Edition statement with AACR2 abbreviations (Appendix B): "2nd edition" -> "2nd ed.",
// "Second Edition" -> "2nd ed.", "New Ed edition" -> "New ed.", "Revised edition" -> "Rev. ed."
const EDITION_ORDINALS = {first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9,
  tenth: 10, eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20};
function aacr2EditionStatement(value) {
  let text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  if (/^n\.?\s?a\.?$/i.test(text)) return "";                     // "Na", "N.A." (not applicable)
  // A statement of responsibility is not an edition ("With an introduction by …")
  if (/^(?:with|introduction|introduced|edited|translated|foreword|preface)\b/i.test(text)) return "";
  if (/^\d{1,2}$/.test(text)) text = `${text} ed.`;                // "7" -> "7th ed."
  if (text === text.toUpperCase()) text = text.toLowerCase();   // "1ST ED." -> "1st ed."
  // An impression or reprint is not an edition (AACR2 1.2B): no 250
  if (/^(?:[\p{L}\d]+\s+)?(?:impr(?:ession)?|print(?:ing)?|repr(?:int)?|reprinted)\b\.?(?:\s+\d{4})?$/iu.test(text)) return "";
  // Reissues, reprints and printings (also "Druck", "Nachdruck", "Reprint der Ausgabe"):
  // only an edition statement in them is kept
  if (/\b(?:reissued?|reprint(?:ed)?|nachdruck|druck|impr(?:ession)?|printing)\b/i.test(text)) {
    const kept = text.match(/^[^,;]*\bed\.?(?=[,;]|$)/i);
    if (!kept) return "";
    text = kept[0].trim();
  }
  // "Ed edition", "edn. edition": one word for edition is enough
  text = text.replace(/\b(ed|edn)\.?\s+edition\b\.?/i, "ed.");
  text = text.replace(/\bedition\b\.?/gi, "ed.").replace(/\bedn\b\.?/gi, "ed.").replace(/\bed\b\.?/gi, "ed.");
  text = text.replace(/\brevised\b/gi, "rev.").replace(/\benlarged\b/gi, "enl.");
  // Ordinals: "Second ed." / "2 ed." / "2nd. ed." -> "2nd ed."
  text = text.replace(/^(\p{L}+|\d+)(?:st|nd|rd|th)?\.?(?=\s+(?:rev\.\s+)?ed\.)/iu, word => {
    const n = EDITION_ORDINALS[word.toLowerCase()] || parseInt(word, 10);
    if (!(n > 0)) return word;
    const suffix = (n % 100 >= 11 && n % 100 <= 13) ? "th" : ({1: "st", 2: "nd", 3: "rd"}[n % 10] || "th");
    return `${n}${suffix}`;
  });
  text = text.replace(/\s+ed\.\s+ed\./i, " ed.");
  return /^\p{Ll}/u.test(text) ? text[0].toUpperCase() + text.slice(1) : text;
}

// Small fixes on the finished record, for data some catalogues write loosely
function tidyRecord(record) {
  // Unicode NFC (one character for "ë", not "e" + combining mark), as Koha stores text:
  // catalogues often send the decomposed form, which would not match in searches and duplicates
  record.fields.forEach(field => {
    if (typeof field.value === "string") field.value = field.value.normalize("NFC");
    (field.subfields || []).forEach(sf => { const code = Object.keys(sf)[0]; sf[code] = String(sf[code]).normalize("NFC"); });
  });
  // 041: language names ("English") become MARC codes ("eng"); anything else is dropped
  record.fields.filter(f => f.tag === "041").forEach(f => {
    f.subfields = (f.subfields || []).map(sf => {
      const code = Object.keys(sf)[0], value = String(sf[code]).trim().toLowerCase().replace(/[.,;]+$/, "");
      if (code === "2" || /^[a-z]{3}$/.test(value)) return sf;
      const named = MARC_LANGUAGE_NAMES[value];
      return named ? {[code]: named} : null;
    }).filter(Boolean);
  });
  record.fields = record.fields.filter(f => f.tag !== "041" || (f.subfields || []).length);
  const lang041 = record.fields.filter(f => f.tag === "041").flatMap(f => (f.subfields || []).filter(sf => sf.a).map(sf => sf.a));
  record.fields.forEach(field => {
    // Titles of address out of personal names
    if (/^(100|600|700|800)$/.test(field.tag)) (field.subfields || []).forEach(sf => {
      if (sf.a) sf.a = dropTitlesOfAddress(sf.a).replace(/,\s*,/g, ",");
    });
    // Personal name written "Surname, Forename" needs first indicator 1 (0 for a forename only)
    if (/^(100|600|700|800)$/.test(field.tag) && field.indicators) {
      const name = String(subfieldValue(field, "a"));
      if (name && (field.indicators[0] === " " || (field.indicators[0] === "0" && /^[^,]+,\s*\p{L}/u.test(name)))) {
        field.indicators[0] = name.includes(",") ? "1" : "0";
      }
    }
    // Spaces inside brackets: "( jrf & lecturership)" -> "(jrf & lecturership)"
    if (!/^00/.test(field.tag)) (field.subfields || []).forEach(sf => {
      const code = Object.keys(sf)[0];
      sf[code] = String(sf[code]).replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
      // A capitalised word joined to a normal one: "McGraw-HILL" -> "McGraw-Hill"
      if (/^26[04]$/.test(field.tag)) sf[code] = sf[code].replace(/(\p{Ll}-)(\p{Lu})(\p{Lu}+)\b/gu, (m, a, b, c) => a + b + c.toLowerCase());
    });
    // Relator terms in lower case ("Author" -> "author")
    if (/^(1|6|7|8)[01]0$/.test(field.tag)) (field.subfields || []).forEach(sf => {
      if (sf.e && /^\p{Lu}\p{Ll}+\.?$/u.test(sf.e)) sf.e = sf.e.toLowerCase();
    });
  });
  // 008 language "und" or blank while 041 gives one language: take it from 041
  const f008 = record.fields.find(f => f.tag === "008");
  if (f008 && f008.value && f008.value.length === 40 && lang041.length === 1 && /^[a-z]{3}$/.test(lang041[0])) {
    const lang = f008.value.slice(35, 38);
    if (lang === "und" || lang.trim() === "" || lang === "|||") f008.value = f008.value.slice(0, 35) + lang041[0] + f008.value.slice(38);
  }
  return record;
}

// AACR2 1.1F7: qualifications (degrees, memberships) are left out of the statement of responsibility
const QUALIFICATIONS = /,\s*(?:B\.?A|M\.?A|B\.?Sc|M\.?Sc|Ph\.?\s?D|D\.?Phil|M\.?Phil|M\.?D|M\.?B\.?B\.?S|M\.?S|B\.?Ed|M\.?Ed|LL\.?B|LL\.?M|D\.?Sc|D\.?Litt|B\.?Tech|M\.?Tech|B\.?E|M\.?E|BAI|BEng|MEng|MBA|CertEd|SRN|RGN|RNT|RN|PFHEA|FHEA|FRCP|FRCS|MRCP|FRS|FBA|FRSA|FCA)\.?(?:\s*\([^)]*\))?(?=\s*(?:,|;|$|\.$))/g;
function dropQualifications(statement) {
  let text = String(statement || "");
  let before;
  do { before = text; text = text.replace(QUALIFICATIONS, ""); } while (text !== before);
  return text;
}

// Titles of address are not part of a name heading or the statement of responsibility
// (AACR2 1.1F7, 22.15): "Singh, Dr. Savindra" -> "Singh, Savindra"; "by Dr. S. Singh" -> "by S. Singh"
const ADDRESS_TITLES = /(^|[\s,(])(?:Dr|Prof|Professor|Mr|Mrs|Ms|Shri|Sri|Smt|Kumari)(?:\.\s*|\s+)(?=\p{L})/gu;
function dropTitlesOfAddress(text) {
  return String(text || "").replace(ADDRESS_TITLES, "$1").replace(/\s{2,}/g, " ").trim();
}

// ISBN-10 check digit X is written in capitals
function normaliseIsbnSubfields(record) {
  record.fields.filter(f => f.tag === "020").forEach(f => (f.subfields || []).forEach(sf => {
    const code = Object.keys(sf)[0];
    if (code === "a" || code === "z") sf[code] = String(sf[code]).replace(/^([0-9-]{9,12})x\b/, "$1X");
  }));
}

// --- AACR2 forms for data that sources write loosely ------------------------------------

// 300 $a: "347p", "347 pages", "347 pp" -> "347 p."
function aacr2Extent(value) {
  let text = String(value || "").trim()
    // Digits in Indian scripts (Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam)
    .replace(/[०-९০-৯੦-੯૦-૯୦-୯௦-௯౦-౯೦-೯൦-൯]/g,
      d => String((d.charCodeAt(0) - 6) & 0xF))   // each block starts at ...66
    .replace(/(\d)\s*(?:পৃ|পৃষ্ঠা|पृ|पृष्ठ)\.?/g, "$1 p.")
    .replace(/^various\s*(?:p|pages|pagings?)\.?$/i, "1 v. (various pagings)")
    .replace(/^([ivxlcdm]+)\s*\+\s*(\d+)/i, "$1, $2")                 // "xxv+532" -> "xxv, 532"
    .replace(/^([ivxlcdm]+)(\d+)/i, "$1, $2")                         // "xvi307p" -> "xvi, 307p"
    .replace(/\b(\d+)\s*(?:pp|pgs?|pages?|p|Seiten|S|sivua|sidor|sider|pagine|páginas)\b\.?/gi, "$1 p.")
    .replace(/\b(\d+)\s*(?:volumes?|vols?|Bände|Bd)\b\.?/gi, "$1 v.")
    .replace(/\s*,\s*/g, ", ");
  // Roman numerals in small letters ("XVII, 981 p." -> "xvii, 981 p.")
  text = text.replace(/^[IVXLCDM]+(?=,)/, m => m.toLowerCase());
  // A last number without a unit is a page count ("ix, 230" -> "ix, 230 p.")
  if (/(?:^|,\s*)\d+$/.test(text) && !/\b(?:p|v|leaves)\./.test(text)) text += " p.";
  return text;
}

// 300 $b: "Ills", "illus.", "illustrations" -> "ill."; "ill.(some col.)" -> "ill. (some col.)"
function aacr2Illustrations(value) {
  return String(value || "").trim()
    .replace(/\b(?:illustrations?|illus|ills?|Illustrationen|kuvitettu)\b\.?/gi, "ill.")
    .replace(/\bcolou?r(?:ed)?\b\.?/gi, "col.")
    .replace(/\s*\(\s*/g, " (")
    .replace(/\s*;?\s*\d+(?:\.\d+)?\s*(?:x\s*\d+(?:\.\d+)?\s*)?cms?\.?$/i, "").trim();
}

// 300 $c (AACR2 2.5D1): height in whole centimetres; the width only when it is less than
// half the height or more than the height. "25cm" -> "25 cm."; "21*14 cm" -> "21 cm."
function aacr2Size(value) {
  const text = String(value || "").trim().replace(/[\s.+;]+$/, "");
  const both = text.match(/^(\d+(?:\.\d+)?)\s*(?:cms?)?\.?\s*(?:x|\*|×)\s*(\d+(?:\.\d+)?)\s*(?:cms?)?$/i);
  if (both) {
    const height = Math.ceil(parseFloat(both[1]));
    const width = Math.ceil(parseFloat(both[2]));
    return width < height / 2 || width > height ? `${height} x ${width} cm.` : `${height} cm.`;
  }
  const one = text.match(/^(\d+(?:\.\d+)?)\s*cms?$/i);
  return one ? `${Math.ceil(parseFloat(one[1]))} cm.` : text;
}

// 650/651 headings written in one $a with dashes ("Prisoners - India - history - 20th century"):
// split into subdivisions. Centuries and dates are chronological ($y), standard form words
// form ($v), country names geographic ($z), the rest topical ($x).
const FORM_SUBDIVISIONS = new Set(["periodicals", "dictionaries", "encyclopedias", "handbooks, manuals, etc.", "handbooks, manuals, etc",
  "bibliography", "congresses", "textbooks", "juvenile literature", "biography", "case studies", "statistics", "maps", "atlases",
  "indexes", "directories", "fiction", "poetry", "drama", "examinations", "examinations, questions, etc.", "problems, exercises, etc.",
  "outlines, syllabi, etc.", "sources", "pictorial works", "translations into english", "early works to 1800", "charts, diagrams, etc.",
  "guidebooks", "catalogs", "glossaries, vocabularies, etc.", "abstracts", "anecdotes", "quotations, maxims, etc."]);
let regionNames = null;
function isRegionName(text) {
  if (!regionNames) {
    regionNames = new Set();
    try {
      const names = new Intl.DisplayNames(["en"], {type: "region"});
      for (let i = 65; i < 91; i++) for (let j = 65; j < 91; j++) {
        const code = String.fromCharCode(i, j);
        try { const name = names.of(code); if (name && name !== code) regionNames.add(name.toLowerCase()); } catch (error) { /* not a region */ }
      }
    } catch (error) { /* no Intl.DisplayNames: nothing is treated as a place */ }
  }
  return regionNames.has(String(text).toLowerCase());
}
function splitDashedHeading(field) {
  const subs = field.subfields || [];
  if (!/^65[01]$/.test(field.tag) || subs.length < 1 || Object.keys(subs[0])[0] !== "a") return field;
  if (subs.some(sf => "xyzv".includes(Object.keys(sf)[0]))) return field;
  const parts = String(subs[0].a).split(/\s+-{1,2}\s+|\s*--\s*/).map(p => p.trim()).filter(Boolean);
  if (parts.length < 2) return field;
  const cap = text => text.charAt(0).toUpperCase() + text.slice(1);
  const split = [{a: cap(parts[0])}, ...parts.slice(1).map(part => {
    const lower = part.toLowerCase();
    if (/\b\d{1,2}(?:st|nd|rd|th) century\b|^\d{3,4}(?:-\d{0,4})?$|^(?:to|ca\.) \d+/i.test(part)) return {y: part};
    if (FORM_SUBDIVISIONS.has(lower)) return {v: cap(part)};
    if (isRegionName(part)) return {z: cap(part)};
    return {x: cap(part)};
  }), ...subs.slice(1)];
  return {...field, subfields: split};
}

// Text values of a book, for fixCapitals in a record merged with it
function caseFormsOf(book = {}) {
  const values = [book.title, book.subtitle, book.publisher, book.publicationPlace, book.edition, book.seriesTitle,
    book.statementOfResponsibility, ...(book.authors || []), ...(book.authorHeadings || []),
    ...(Array.isArray(book.subjects) ? book.subjects : [])];
  (book.marcFields || []).forEach(f => {
    if (CASE_TAG.test(f.tag || "")) (f.subfields || []).forEach(sf => values.push(Object.values(sf)[0]));
  });
  return values.filter(v => typeof v === "string" && v.trim() && !isAllCaps(v));
}

function parseYear(value) {
  if (!value) return "";
  const match = value.toString().match(/(\d{4})/);
  return match ? match[1] : "";
}

/**
 * Append ISBD punctuation to a subfield value unless it already ends with
 * terminal punctuation.
 */
function withPunctuation(value, punct) {
  const text = sanitizeText(value);
  if (!text) return text;
  if (punct === ".") return /[.?!]$/.test(text) ? text : `${text}.`;
  return `${text.replace(/[\s:;,/]+$/, "")}${punct}`;
}

/**
 * Invert name from "Forename Surname" to "Surname, Forename".
 * If comma already exists, assume it's already inverted.
 */
function invertName(name) {
  if (!name || name.includes(',')) return name;
  const parts = name.trim().split(/\s+/);
  if (parts.length <= 1) return name;
  const surname = parts.pop();
  return `${surname}, ${parts.join(' ')}`;
}

/**
 * Item Number ($b) Generation Rules:
 * First three letters from author surname (or main entry) + '/' + first letter of title.
 * Use UPPERCASE.
 */
function computeItemNumber(title, mainEntry) {
  const normalizedTitle = sanitizeText(title).replace(/^(a|an|the)\s+/i, "");
  let entryPart = "";

  if (mainEntry) {
    // Take first 3 letters of the main entry (usually Surname, Forename)
    const cleanEntry = sanitizeText(mainEntry).replace(/[^A-Za-z]/g, "");
    entryPart = cleanEntry.slice(0, 3).toUpperCase().padEnd(3, "X");
  } else {
    // If no main entry, use first 3 letters of title
    entryPart = normalizedTitle.replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase().padEnd(3, "T");
  }

  const titleInitial = normalizedTitle.replace(/[^A-Za-z]/g, "").charAt(0).toUpperCase() || "X";
  return `${entryPart}/${titleInitial}`;
}

// Language names some catalogues type into 041 instead of the code
const MARC_LANGUAGE_NAMES = {english: "eng", hindi: "hin", bengali: "ben", bangla: "ben", sanskrit: "san", urdu: "urd",
  assamese: "asm", oriya: "ori", odia: "ori", tamil: "tam", telugu: "tel", marathi: "mar", gujarati: "guj", punjabi: "pan",
  malayalam: "mal", kannada: "kan", nepali: "nep", french: "fre", german: "ger", spanish: "spa", italian: "ita",
  portuguese: "por", russian: "rus", japanese: "jpn", chinese: "chi", korean: "kor", arabic: "ara", latin: "lat"};

// ISO 639-1 (as returned by Google Books etc.) → MARC language codes
const MARC_LANGUAGE_CODES = {
  en: "eng", bn: "ben", hi: "hin", sa: "san", ur: "urd", as: "asm", or: "ori",
  ta: "tam", te: "tel", mr: "mar", gu: "guj", pa: "pan", ml: "mal", kn: "kan",
  ne: "nep", fr: "fre", de: "ger", es: "spa", it: "ita", pt: "por", ru: "rus",
  ja: "jpn", zh: "chi", ko: "kor", ar: "ara", la: "lat", nl: "dut", el: "gre"
};

function toMarcLanguage(value) {
  const code = sanitizeText(value).toLowerCase();
  if (/^[a-z]{3}$/.test(code)) return code;
  return MARC_LANGUAGE_CODES[code.slice(0, 2)] || "und";  // unknown → undetermined, never assumed
}

function buildField(tag, indicators, subfields) {
  return {
    tag: tag.toString().padStart(3, "0"),
    indicators: indicators || [" ", " "],
    subfields: subfields || []
  };
}

/**
 * MARC country code (008/15-17) guessed from a place of publication.
 * Checked in order: US state abbreviations first so "Cambridge, Mass." is the
 * US. Ambiguous names (Cambridge, Birmingham, Perth, Hyderabad …) are not
 * guessed. Returns "xx" (unknown) when nothing matches.
 */
const MARC_COUNTRY_RULES = [
  [/,\s*(mass|ma|n\.?\s?y|n\.?\s?j|calif|ca|fla|fl|ill|il|conn|ct|pa|tex|tx|mich|mi|md|va|wash|wa|d\.?\s?c|ohio|oh|ga|colo|co|minn|mn|wis|wi|n\.?\s?c|mo|ind|tenn|tn|ariz|az|ore|or|utah|ut|n\.?\s?h|r\.?\s?i|vt|me|ky|la|okla|kan|neb|iowa|nev|n\.?\s?m)\.?\b/i, "xxu"],
  [/united states|\bu\.?s\.?a?\.?\b|new york|boston|chicago|san francisco|los angeles|philadelphia|hoboken|upper saddle river|englewood cliffs|boca raton|princeton|new haven|washington, d\.?\s?c|baltimore|berkeley|thousand oaks|reading, mass|indianapolis|st\.? louis|minneapolis|austin|seattle|atlanta|houston/i, "xxu"],
  [/canada|toronto|montr[eé]al|vancouver|ottawa|\bont\.|qu[eé]bec|calgary|winnipeg/i, "xxc"],
  [/united kingdom|\bu\.?k\.?\b|england|scotland|wales|great britain|london|oxford|cambridge, (eng|uk)|edinburgh|glasgow|manchester|abingdon|harlow|chichester|basingstoke|cheltenham|bristol|leeds|cardiff|oxon|milton keynes|harmondsworth|bingley/i, "xxk"],
  [/australia|sydney|melbourne|brisbane|adelaide|canberra|n\.?s\.?w\.?|vic\./i, "at"],
  [/new zealand|auckland|wellington|christchurch/i, "nz"],
  [/ireland|dublin|cork/i, "ie"],
  [/india|delhi|kolkata|calcutta|mumbai|bombay|chennai|madras|bengaluru|bangalore|pune|noida|gurgaon|gurugram|ahmedabad|lucknow|jaipur|bhopal|patna|bhubaneswar|guwahati|kochi|thiruvananthapuram|varanasi|allahabad|prayagraj|meerut|agra|chandigarh/i, "ii"],
  [/bangladesh|dhaka/i, "bg"], [/pakistan|karachi|lahore|islamabad/i, "pk"],
  [/sri lanka|colombo/i, "ce"], [/nepal|kathmandu/i, "np"],
  [/singapore/i, "si"], [/malaysia|kuala lumpur/i, "my"], [/indonesia|jakarta/i, "io"],
  [/philippines|manila/i, "ph"], [/thailand|bangkok/i, "th"],
  [/japan|tokyo|osaka|kyoto/i, "ja"], [/korea|seoul/i, "ko"],
  [/china|beijing|shanghai|hong kong/i, "cc"], [/taiwan|taipei/i, "ch"],
  [/germany|deutschland|berlin|m[uü]nchen|munich|heidelberg|stuttgart|frankfurt|hamburg|leipzig|weinheim|k[oö]ln|cologne/i, "gw"],
  [/france|paris|lyon/i, "fr"], [/netherlands|amsterdam|dordrecht|leiden|utrecht|rotterdam/i, "ne"],
  [/switzerland|z[uü]rich|basel|geneva|gen[eè]ve|bern|cham\b/i, "sz"], [/austria|vienna|wien/i, "au"],
  [/belgium|brussels|bruxelles/i, "be"], [/denmark|copenhagen/i, "dk"], [/sweden|stockholm/i, "sw"],
  [/norway|oslo/i, "no"], [/finland|helsinki/i, "fi"], [/italy|roma|rome|milan|milano|firenze|florence/i, "it"],
  [/spain|madrid|barcelona/i, "sp"], [/portugal|lisbon|lisboa/i, "po"], [/poland|warsaw|warszawa/i, "pl"],
  [/russia|moscow|moskva/i, "ru"], [/israel|jerusalem|tel aviv/i, "is"], [/egypt|cairo/i, "ua"],
  [/south africa|cape town|johannesburg|pretoria/i, "sa"], [/nigeria|lagos|ibadan/i, "nr"], [/kenya|nairobi/i, "ke"],
  [/brazil|s[aã]o paulo|rio de janeiro/i, "bl"], [/mexico|m[eé]xico/i, "mx"], [/argentina|buenos aires/i, "ag"]
];

function guessCountryCode(place) {
  const text = sanitizeText(place);
  if (!text) return "xx";
  const rule = MARC_COUNTRY_RULES.find(([pattern]) => pattern.test(text));
  return rule ? rule[1] : "xx";
}

/**
 * 008 - Fixed-Length Data Elements (books), 40 positions.
 */
function build008(year, place, lang, hasIllustrations, hasIndex, countryCode = "") {
  const now = new Date();
  const dateEntered = now.toISOString().slice(2, 10).replace(/-/g, '');  // 00-05
  const dateType = year ? "s" : "n";                                      // 06
  const date1 = year || "uuuu";                                           // 07-10
  const date2 = "    ";                                                   // 11-14
  // 15-17: MARC country code from the source, else guessed from the place name
  const pubPlace = (countryCode || guessCountryCode(place)).padEnd(3, " ").slice(0, 3);
  const illus = (hasIllustrations ? "a" : " ").padEnd(4, " ");            // 18-21
  const middle = " " + " " + "    " + " " + "0" + "0" + (hasIndex ? "1" : "0") + " " + "0" + " "; // 22-34
  const f008 = `${dateEntered}${dateType}${date1}${date2}${pubPlace}${illus}${middle}${lang} d`; // 35-39
  return f008.padEnd(40, " ").slice(0, 40);
}

/**
 * Field 245 Rules:
 * - Indicator 1: 0 (no author), 1 (author present)
 * - Indicator 2: Non-filing characters
 * - Subtitle ($b): lowercase
 * - Statement of responsibility ($c): begins with "by"
 * - Multi-author formatting
 * - ISBD punctuation: "$a Title : $b subtitle. $n Part 2, $p Part name / $c by Name."
 */
function buildTitleField(title, subtitle, authors, hasMainEntry, options = {}) {
  let ind2 = 0;
  const upperTitle = title.toUpperCase();
  if (upperTitle.startsWith("THE ")) ind2 = 4;
  else if (upperTitle.startsWith("A ")) ind2 = 2;
  else if (upperTitle.startsWith("AN ")) ind2 = 3;
  // A catalogue-supplied non-filing count is authoritative, except a 0 for an English
  // title that begins with "The", "A" or "An" (some catalogues leave it at 0)
  if (/^[0-9]$/.test(options.nonfilingChars || "")) {
    const given = parseInt(options.nonfilingChars, 10);
    // For English titles the article decides ("The" 4, "A" 2, "An" 3, otherwise 0)
    if (options.language !== "eng") ind2 = given;
  }

  // $b repeated at the end of $a ("The insects: structure and function" + $b "structure
  // and function"): split $a at the colon, or, without one, keep the title whole in $a
  if (subtitle) {
    const tail = subtitle.toLowerCase().replace(/[\s.]+$/, "");
    const lowerTitle = title.toLowerCase().replace(/[\s.]+$/, "");
    if (tail && lowerTitle === tail) {
      subtitle = "";
    } else if (tail && lowerTitle.startsWith(`${tail} `)) {
      // "Physical Chemistry thermodynamics, …" + $b "physical chemistry": $a is the $b words,
      // and the rest is the real other title information (when it has at least two words)
      const rest = title.slice(tail.length).trim().replace(/^[\s:;,.-]+/, "");
      // (the capitals of $a are taken from $b, which shows the words in their normal form)
      if (rest.split(/\s+/).length >= 2) {
        const words = subtitle.trim().replace(/[\s.]+$/, "");
        title = words.charAt(0).toUpperCase() + words.slice(1);
        subtitle = rest;
      }
      else subtitle = "";
    } else if (tail && lowerTitle.length > tail.length && lowerTitle.endsWith(tail)) {
      const head = title.slice(0, lowerTitle.length - tail.length);
      if (/:\s*$/.test(head) && head.replace(/[\s:]+$/, "")) title = head.replace(/[\s:]+$/, "");
      else subtitle = "";
    }
  }

  // statementMode (setting): "by" = local rule (begin with "by", [etal.], built from the
  // author list when no transcription exists); "transcribed" = the source's own
  // transcription only, never composed
  const transcribedOnly = options.statementMode === "transcribed";
  let sor = "";
  if (options.statementOfResponsibility) {
    sor = transcribedOnly
      ? sanitizeText(options.statementOfResponsibility).replace(/[\s.]+$/, "")
      : normalizeStatement(options.statementOfResponsibility);
  }
  if (!sor && !transcribedOnly && authors && authors.length > 0) {
    sor = "by ";
    if (authors.length === 1) {
      sor += authors[0];
    } else if (authors.length === 2) {
      sor += `${authors[0]} and ${authors[1]}`;
    } else if (authors.length === 3) {
      sor += `${authors[0]}, ${authors[1]} and ${authors[2]}`;
    } else {
      sor += `${authors[0]} ... [etal.]`;
    }
  }

  // Subtitle must always start in lowercase
  const loweredSubtitle = subtitle ? (isAllCaps(subtitle) || /^\p{Lu}{2}/u.test(subtitle) ? subtitle : subtitle.charAt(0).toLowerCase() + subtitle.slice(1)) : "";

  // Title elements in MARC order; each takes the punctuation that precedes the next one
  const parts = [];
  if (title) parts.push(["a", title]);
  if (loweredSubtitle) parts.push(["b", loweredSubtitle]);
  if (options.partNumber) parts.push(["n", sanitizeText(options.partNumber)]);
  if (options.partName) parts.push(["p", sanitizeText(options.partName)]);

  const subfields = parts.map(([code, value], i) => {
    const next = parts[i + 1];
    let punct;
    if (!next) punct = sor ? " /" : ".";
    else if (next[0] === "b") punct = " :";
    else if (next[0] === "p" && code === "n") punct = ",";
    else punct = ".";
    return {[code]: withPunctuation(value, punct)};
  });
  if (sor) {
    subfields.push({c: sor.endsWith("[etal.]") ? sor : withPunctuation(sor, ".")});
  }

  return buildField("245", [hasMainEntry ? "1" : "0", ind2.toString()], subfields);
}

/**
 * Statement of responsibility transcribed by a source catalogue, adjusted to
 * the local rules: begins with "by" and uses "[etal.]".
 */
function normalizeStatement(statement) {
  let text = sanitizeText(statement).replace(/[\s.]+$/, "").replace(/\[\s*et\s*al\.?\s*\]/i, "[etal.]");
  if (!text) return "";
  text = text.replace(/^by\s*[.,:]?\s*/i, "by ");
  text = dropTitlesOfAddress(text);
  text = dropQualifications(text);
  // "EDITED BY isher judge ahluwalia & i.m.d. little": role words small, names capitalised
  // (only when no name in it is written normally)
  const bare = w => w.toLowerCase().replace(/[.,;:]+$/, "");
  const linking = new Set([...ROLE_WORDS, ...SMALL_WORDS]);
  const words = text.split(/\s+/);
  const plainNames = words.filter(w => /^\p{Ll}/u.test(w) && !linking.has(bare(w)));
  const normalNames = words.filter(w => /^\p{Lu}\p{Ll}/u.test(w) && !linking.has(bare(w)));
  if ((plainNames.length >= 2 && !normalNames.length) || /^(EDITED|COMPILED|TRANSLATED|BY)\b/.test(text)) {
    text = wordCase(text.replace(/\.(?=\p{L})/gu, ". "), linking, true);
  }
  // Keep role phrases such as "edited by …" as transcribed; otherwise begin with "by"
  if (!/^(by|edited|compiled|translated|selected|written|illustrated|introduced|revised)\b/i.test(text) && !/^\p{Ll}/u.test(text)) {
    text = `by ${text}`;
  }
  return text;
}

/**
 * Local policy: no ending (ISBD) punctuation in subfields, so stored values such
 * as biblio.title stay clean for later data work ("Gitanjali", not "Gitanjali /").
 * A final period is kept when it belongs to an abbreviation or initial
 * ("3rd ed.", "24 cm.", "Mass.", "N.Y.", "Thomas H.").
 */
const KEEP_PERIOD_ABBREVIATIONS = new Set([
  "ed", "eds", "rev", "enl", "p", "pp", "v", "vol", "vols", "ill", "illus", "col", "port", "ports",
  "facsim", "facsims", "geneal", "cm", "mm", "no", "nos", "pt", "pts", "ser", "suppl", "comp", "comps",
  "trans", "tr", "jr", "sr", "dr", "st", "mr", "mrs", "ms", "prof", "co", "corp", "inc", "ltd", "bros",
  "dept", "univ", "assoc", "govt", "etc", "pbk", "hbk", "alk", "abr", "approx", "ca", "cf", "ont", "que", "eng",
  "mass", "calif", "conn", "fla", "ind", "kan", "mich", "minn", "mo", "neb", "nev", "okla", "ore", "pa",
  "tenn", "tex", "va", "vt", "wash", "wis", "wyo", "ariz", "colo", "del", "ga", "ky", "la", "md", "me", "miss", "mont"
]);

function stripEndingPunctuation(value) {
  let text = sanitizeText(value);
  let previous;
  do {
    previous = text;
    // " /", " :", " ;", " =", " +", "," at the end
    text = text.replace(/\s*[/:;=+,]\s*$/, "");
    const lastWord = (text.match(/(\S+)\.$/) || [])[1];
    if (lastWord !== undefined) {
      const bare = lastWord.replace(/^[("'[]+/, "");
      const isAbbreviation = bare.includes(".")                        // N.Y., U.S.A., T.p.
        || /^[A-Za-z]$/.test(bare)                                     // initial: H.
        || KEEP_PERIOD_ABBREVIATIONS.has(bare.toLowerCase());          // ed., cm., Mass.
      if (!isAbbreviation) text = text.slice(0, -1).trimEnd();
    }
  } while (text !== previous);
  return text;
}

// Subfields that link or identify within the source system rather than describe
const SOURCE_CONTROL_SUBFIELDS = new Set(["0", "1", "5", "6", "8", "9"]);

// Standard fields carried over from a source catalogue record.
// Codes, names, series and subjects are reused from any source; notes and RDA
// terms only from sources that catalogue in English.
// (010 LCCN is not harvested – not required by local policy)
const PASSTHROUGH_ANY_LANGUAGE = ["041", "043", "050", "490", "800", "810", "811", "830"];
const PASSTHROUGH_ENGLISH_ONLY = ["246", "336", "337", "338",
  "500", "501", "502", "504", "505", "508", "511", "518", "520", "521", "525", "530", "533", "534", "538", "546", "550", "586"];
const SUBJECT_TAGS = ["600", "610", "611", "630", "647", "648", "650", "651", "655"];

// MARC relator codes ($4) and terms ($e) for books (from the MARC Code List for Relators)
const RELATORS = {
  aut: "author", edt: "editor", trl: "translator", ill: "illustrator", com: "compiler",
  ctb: "contributor", aui: "author of introduction", aft: "author of afterword",
  win: "writer of introduction", wpr: "writer of preface", wat: "writer of added text",
  ann: "annotator", cmm: "commentator", cwt: "commentator for written text", adp: "adapter",
  abr: "abridger", pht: "photographer", art: "artist", cre: "creator", edc: "editor of compilation",
  isb: "issuing body", spn: "sponsor", org: "originator", dgg: "degree granting institution",
  pbl: "publisher", prf: "performer", ivr: "interviewer", ive: "interviewee", ctg: "cartographer"
};
const RELATOR_CODES = Object.fromEntries(Object.entries(RELATORS).map(([code, term]) => [term, code]));

/**
 * Complete relator information on a name field: a known code ($4) gives the
 * term ($e) and a known term gives the code. Meetings (X11) use $j, not $e.
 */
function completeRelators(field) {
  if (!["100", "110", "700", "710"].includes(field.tag)) return field;
  const subs = field.subfields;
  const codes = subs.filter(sf => Object.keys(sf)[0] === "4").map(sf => sf["4"].trim().toLowerCase());
  const terms = subs.filter(sf => Object.keys(sf)[0] === "e").map(sf => sf.e.replace(/[\s.,]+$/, "").toLowerCase());

  if (terms.length === 0 && codes.length > 0) {
    const newTerms = codes.map(code => RELATORS[code]).filter(Boolean);
    if (newTerms.length) {
      const firstCode = subs.findIndex(sf => Object.keys(sf)[0] === "4");
      // The element before $e ends with a comma: "$d 1865-1939, $e author of introduction."
      const prev = subs[firstCode - 1];
      if (prev) {
        const key = Object.keys(prev)[0];
        prev[key] = prev[key].replace(/[.,]?$/, ",");
      }
      const termFields = newTerms.map((term, i) => ({e: `${term}${i === newTerms.length - 1 ? "." : ","}`}));
      subs.splice(firstCode, 0, ...termFields);
    }
  } else if (codes.length === 0 && terms.length > 0) {
    terms.map(term => RELATOR_CODES[term]).filter(Boolean).forEach(code => subs.push({4: code}));
  }
  return field;
}

function cleanSourceField(field) {
  const subfields = (field.subfields || [])
    .map(sf => {
      const code = Object.keys(sf)[0];
      return [/^[A-Z]$/.test(code) ? code.toLowerCase() : code, sanitizeText(sf[code])];
    })
    .filter(([code, value]) => code && value && !SOURCE_CONTROL_SUBFIELDS.has(code))
    .map(([code, value]) => ({[code]: value}));
  const indicator = value => (/^[0-9]$/.test(value || "") ? value : " ");   // "\" and "#" (MARCMaker) are blank
  return subfields.length ? completeRelators(buildField(field.tag, [indicator(field.ind1), indicator(field.ind2)], subfields)) : null;
}

function subfieldValue(field, code) {
  const found = (field?.subfields || []).find(sf => Object.keys(sf)[0] === code);
  return found ? found[code] : "";
}

// Valid 008 for books from a source catalogue, with today's date entered
function sourceBased008(source008) {
  const value = String(source008 || "");
  if (value.length !== 40 || !/^[0-9]{6}[a-z|][0-9u|]{4}/.test(value) || /[A-Z]/.test(value)) return "";
  const dateEntered = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  return dateEntered + value.slice(6);
}

// Cataloguing-rule settings; the defaults are AACR2 with the developer library's local policy
function cataloguingRules(options = {}) {
  return {
    endingPunctuation: options.endingPunctuation === "keep" ? "keep" : "remove",
    statement: options.statement === "transcribed" ? "transcribed" : "by",
    ruleOfThree: options.ruleOfThree !== "off",
    itemNumber: options.itemNumber !== "off",
    publicationField: options.publicationField === "264" ? "264" : "260",
    itemType: sanitizeText(options.itemType) || "BK"
  };
}

// ISBD punctuation between parts, used only when ending punctuation is kept:
// parts = [[code, value], ...], separators = {nextCode: punctuation}, ending = final mark
function isbdSubfields(parts, separators, ending) {
  return parts.map(([code, value], i) => {
    const next = parts[i + 1];
    const punct = next ? separators[next[0]] : ending;
    return {[code]: punct ? withPunctuation(value, punct) : value};
  });
}

function buildMarcRecord(book = {}, options = {}) {
  const rules = cataloguingRules(options);
  const keepIsbd = rules.endingPunctuation === "keep";
  // Never invented: when no institution is set, 040 has only $b (the sidebar asks for it)
  const institution = sanitizeText(options.institutionName);

  const title = sanitizeText(book.title);
  // An edition statement given as the subtitle ("Indian Edition", "Student edition") belongs in 250
  const givenSubtitle = sanitizeText(book.subtitle);
  const subtitleIsEdition = /^(?:[\p{L}\d]+\s+){0,2}(?:edition|ed\.?)$/iu.test(givenSubtitle);
  const subtitle = subtitleIsEdition ? "" : givenSubtitle;
  const authors = (Array.isArray(book.authors) ? book.authors.map(sanitizeText) : (book.authors ? [sanitizeText(book.authors)] : []))
    .map(name => dropTitlesOfAddress(name)).filter(Boolean);
  const publisher = sanitizeText(book.publisher);
  const place = sanitizeText(book.publicationPlace);
  const year = parseYear(book.publishedDate || book.publicationYear);
  const editionText = [sanitizeText(book.edition), subtitleIsEdition ? givenSubtitle : ""].filter(Boolean)
    .filter((text, i, all) => i === 0 || aacr2EditionStatement(text).toLowerCase() !== aacr2EditionStatement(all[0]).toLowerCase()).join(" / ");
  const [edition, ...editionRest] = aacr2EditionStatement(editionText).split(/\s+\/\s+/);
  const editionB = editionRest.join(" / ");
  const series = sanitizeText(book.seriesTitle || (book.series ? book.series[0] : ""));
  const summary = sanitizeText(Array.isArray(book.description) ? book.description.join(" ") : (book.description || book.notes || ""));
  const subjects = Array.isArray(book.subjects) ? book.subjects.map(sanitizeText).filter(Boolean) : (book.subjects ? [sanitizeText(book.subjects)] : []);
  const pageCount = parseInt(book.pageCount, 10);
  let extent = sanitizeText(book.physicalDescription) || (pageCount > 0 ? `${pageCount} p.` : "");
  let size = sanitizeText(book.size).replace(/\bcm$/, "cm.");  // "24 cm" → "24 cm." (AUTHORITYFILES)
  // Size typed into the extent ("xxxvii, 1155 p.; 18cms"): it belongs in 300 $c
  const sizeInExtent = extent.match(/^(.*?)\s*;\s*(\d+(?:\.\d+)?\s*(?:[x×*]\s*\d+(?:\.\d+)?\s*)?cms?\.?)\s*$/i);
  if (sizeInExtent) { extent = sizeInExtent[1]; if (!size) size = sizeInExtent[2]; }
  const ill = sanitizeText(book.illustrations);

  // Source catalogue record (LC, research libraries, IndCat, K10plus), if any
  const sourceFields = Array.isArray(book.marcFields) ? book.marcFields : [];
  const hasSource = sourceFields.length > 0;
  const sourceEnglish = book.marcSourceEnglish !== false;
  const fromSource = tag => sourceFields.filter(f => f.tag === tag).map(cleanSourceField).filter(Boolean);
  const passThrough = tag => (PASSTHROUGH_ANY_LANGUAGE.includes(tag) || (sourceEnglish && PASSTHROUGH_ENGLISH_ONLY.includes(tag))) ? fromSource(tag) : [];

  // Main entry: a source record's own 1XX decision is standard; otherwise the rule of
  // three (setting), or the first-named creator when the rule of three is switched off
  const sourceMain = hasSource ? [...fromSource("100"), ...fromSource("110"), ...fromSource("111"), ...fromSource("130")][0] || null : null;
  const hasMainEntry = hasSource ? !!sourceMain : (authors.length > 0 && (!rules.ruleOfThree || authors.length <= 3));
  // Library catalogues supply authorised headings (Surname, Forename); use them when they line up
  const invertedAuthors = (Array.isArray(book.authorHeadings) && book.authorHeadings.length === authors.length)
    ? book.authorHeadings.map(heading => invertName(sanitizeText(heading)))  // some catalogues (e.g. IndCat) use direct order
    : authors.map(invertName);
  const mainHeading = sourceMain ? sanitizeText(subfieldValue(sourceMain, "a")).replace(/[,.]+$/, "") : (hasMainEntry ? invertedAuthors[0] : null);
  const itemNumber = computeItemNumber(title, mainHeading);
  // Class number only from harvested data (source catalogue 082, holding library's
  // class number) or the AI helper after review – never guessed from keywords
  const ddc = sanitizeText(book.ddc);

  // Leader as Koha's default for a new book ("     nam a22     7a 4500", "#" = blank).
  // Position 18: "a" AACR2 with ISBD punctuation, "c" ISBD punctuation omitted (local policy)
  const record = {
    leader: `#####nam#a22#####7${keepIsbd ? "a" : "c"}#4500`,
    fields: []
  };
  const add = field => { if (field) record.fields.push(field); };

  // 008 - Fixed-Length Data Elements (source catalogue's coding when valid)
  record.fields.push({
    tag: "008",
    value: sourceBased008(book.source008)
      || build008(year, place, toMarcLanguage(book.language), !!ill, !!book.hasIndex, sanitizeText(book.countryCode))
  });

  // 020 - ISBN(s) with qualifier ($q) and price ($c)
  const cleanIsbn = value => (sanitizeText(value).replace(/-/g, "").match(/[0-9Xx]{13}|[0-9Xx]{10}/) || [""])[0];
  const primaryIsbn = cleanIsbn(Array.isArray(book.isbn) ? book.isbn[0] : book.isbn);
  const isbnFields = [];
  fromSource("020").forEach(f => {
    const isbn = cleanIsbn(subfieldValue(f, "a"));
    if (!isbn || isbnFields.some(x => subfieldValue(x, "a") === isbn)) return;
    // Older records put the qualifier in $a: "0262033844 (hardcover : alk. paper)"
    const qualifier = subfieldValue(f, "q") || ((subfieldValue(f, "a").match(/\(([^)]+)\)/) || [])[1] || "");
    const subfields = [{a: isbn}];
    if (qualifier) subfields.push({q: qualifier.replace(/^\(|\)$/g, "").replace(/[\s:;.]+$/, "")});
    if (book.price && isbn === primaryIsbn) subfields.push({c: sanitizeText(book.price)});
    isbnFields.push(buildField("020", [" ", " "], subfields));
  });
  const otherIsbns = (Array.isArray(book.isbn) ? book.isbn : [book.isbn]).map(cleanIsbn).filter(Boolean);
  otherIsbns.forEach(isbn => {
    if (isbnFields.some(x => subfieldValue(x, "a") === isbn)) return;
    const subfields = [{a: isbn}];
    if (book.price && isbn === primaryIsbn) subfields.push({c: sanitizeText(book.price)});
    isbnFields.push(buildField("020", [" ", " "], subfields));
  });
  // The searched ISBN first
  isbnFields.sort((x, y) => (subfieldValue(y, "a") === primaryIsbn) - (subfieldValue(x, "a") === primaryIsbn)).forEach(add);

  // 040 - Cataloging Source
  add(buildField("040", [" ", " "], institution ? [
    {a: institution},   // $a Original cataloging agency
    {b: "eng"},         // $b Language of cataloging (required by MARC 21)
    {c: institution}    // $c Transcribing agency
  ] : [{b: "eng"}]));

  // 041 language codes, 043 geographic area, 050 LC call number
  passThrough("041").forEach(add);
  passThrough("043").forEach(add);
  passThrough("050").forEach(add);

  // 082 - DDC; $a is left out when no class is known (fill it in or use the AI helper).
  // $b item number per the local rule (setting); no 082 at all when neither is present.
  const source082 = fromSource("082")[0];
  const ddcSubfields = [];
  if (ddc) ddcSubfields.push({a: ddc});
  if (rules.itemNumber) ddcSubfields.push({b: itemNumber});
  const ddcEdition = subfieldValue(source082, "2");
  if (ddc && ddcEdition) ddcSubfields.push({2: ddcEdition});
  if (ddcSubfields.length) {
    add(buildField("082", source082 && ddc === sanitizeText(book.ddc) ? source082.indicators : [" ", " "], ddcSubfields));
  }

  // 1XX - Main entry: every subfield the source knows ($a, $q fuller form,
  // $d dates, $e relator term, $4 relator code). Relators are never assumed.
  if (sourceMain) {
    add(sourceMain);
  } else if (hasMainEntry) {
    const mainSubfields = [{a: invertedAuthors[0]}];
    if (book.authorDates) mainSubfields.push({d: sanitizeText(book.authorDates)});
    if (keepIsbd) {
      const last = mainSubfields[mainSubfields.length - 1];
      const code = Object.keys(last)[0];
      last[code] = withPunctuation(last[code], ".");
    }
    add(buildField("100", ["1", " "], mainSubfields));
  }

  // 240 - Uniform title (e.g. original title of a translation; 130 is handled as a main entry)
  (sourceEnglish ? fromSource("240") : []).forEach(add);

  // 245 - Title statement
  add(buildTitleField(title, subtitle, authors, hasMainEntry, {
    partNumber: book.partNumber,
    partName: book.partName,
    nonfilingChars: book.nonfilingChars,
    language: book.language,
    statementOfResponsibility: sourceEnglish ? book.statementOfResponsibility : "",
    statementMode: rules.statement
  }));

  // 246 - Varying form of title (source variants; transliterated Bengali titles)
  passThrough("246").forEach(add);
  const isBengali = /[ঀ-৿]/.test(title);
  if (isBengali && book.transliteratedTitle) {
    add(buildField("246", ["3", " "], [{a: book.transliteratedTitle}]));
  }

  // 250 - Edition statement (with $b responsibility for the edition, when given)
  if (edition) {
    const editionSubfields = [{a: edition}];
    const editionResponsibility = sourceEnglish ? subfieldValue(fromSource("250")[0], "b") : "";
    // "2nd ed. / Indian Edition", or a source 250 $b "Indian Edition": a further edition
    // statement goes into $a; $b is only for a statement of responsibility
    const isEdition = text => /\bed\.(?:\s+\d{4})?$/i.test(aacr2EditionStatement(text));
    const further = [editionB, editionResponsibility].filter(text => text && isEdition(text));
    if (further.length) editionSubfields[0].a = [edition, ...further.map(aacr2EditionStatement)].join(", ");
    const responsibility = [editionResponsibility, editionB].find(text => text && !isEdition(text));
    if (responsibility) editionSubfields.push({b: responsibility});
    add(buildField("250", [" ", " "], editionSubfields));
  }

  // 260 (or 264 _1, setting) - Publication details (only what the source actually supplied)
  const source264 = rules.publicationField === "264" && sourceEnglish ? fromSource("264") : [];
  if (source264.length) {
    source264.forEach(add);  // the source's own 264 statements (publication, copyright date)
  } else {
    const pubParts = [];
    if (place) pubParts.push(["a", place]);
    if (publisher) pubParts.push(["b", publisher]);
    if (year) pubParts.push(["c", year]);
    if (pubParts.length > 0) {
      const pubSubfields = keepIsbd
        ? isbdSubfields(pubParts, {b: " :", c: ","}, ".")
        : pubParts.map(([code, value]) => ({[code]: value}));
      add(buildField(rules.publicationField, [" ", rules.publicationField === "264" ? "1" : " "], pubSubfields));
    }
  }

  // 300 - Physical description (only what the source actually supplied)
  const physParts = [];
  if (extent) physParts.push(["a", aacr2Extent(extent)]);
  if (ill) physParts.push(["b", aacr2Illustrations(ill)]);
  if (size) physParts.push(["c", aacr2Size(size)]);
  const accompanying = subfieldValue(fromSource("300")[0], "e");
  if (accompanying && sourceEnglish) physParts.push(["e", accompanying.replace(/[\s.]+$/, "")]);
  if (physParts.length > 0) {
    const physSubfields = keepIsbd
      ? isbdSubfields(physParts, {b: " :", c: " ;", e: " +"}, "")
      : physParts.map(([code, value]) => ({[code]: value}));
    add(buildField("300", [" ", " "], physSubfields));
  }

  // 336/337/338 - RDA content/media/carrier, only as recorded by the source
  ["336", "337", "338"].flatMap(passThrough).forEach(add);

  // 490 - Series statement
  const sourceSeries = passThrough("490");
  if (sourceSeries.length) {
    sourceSeries.forEach(add);
  } else if (series) {
    const seriesSubfields = [{a: series}];
    if (book.seriesVolume) seriesSubfields.push({v: sanitizeText(book.seriesVolume)});
    add(buildField("490", ["1", " "], seriesSubfields));
  }

  // 5XX - Notes: source notes, plus derived ones the source lacks
  const notes = PASSTHROUGH_ENGLISH_ONLY.filter(tag => tag.startsWith("5")).flatMap(passThrough);
  const noteText = tag => notes.filter(n => n.tag === tag).map(n => subfieldValue(n, "a")).join(" ");
  notes.forEach(add);
  if (book.hasIndex && !/index/i.test(noteText("500") + noteText("504"))) {
    add(buildField("500", [" ", " "], [{a: "Includes index."}]));
  }
  if (book.hasBibliography && !notes.some(n => n.tag === "504")) {
    add(buildField("504", [" ", " "], [{a: "Includes bibliographical references."}]));
  }
  const notASummary = /^\s*[ivxlc]+,\s*\d+\s*(pages|p\.)|\b\d+\s*pages\s*[:;]|\bIncludes bibliographical references\b.*\s--\s/i.test(summary);
  if (summary && !notASummary && !notes.some(n => n.tag === "520")) {
    add(buildField("520", [" ", " "], [{a: summary}]));
  }

  // 6XX - Subject access: controlled headings from the source catalogue
  // (LCSH, ind2 0; LC genre/form terms, 655 _7 $2 lcgft)
  // A 650/651 "LCSH" heading whose first word has no capital letter is a term some catalogue
  // coded as LCSH in its own language ("algoritmer"), not LCSH ("iPhone (Smartphone)" is kept)
  const notLcsh = f => (f.tag === "650" || f.tag === "651") && /^\p{Ll}[^\s\p{Lu}]*(\s|$)/u.test(String(subfieldValue(f, "a") || "").trim());
  const sourceSubjects = SUBJECT_TAGS.flatMap(tag => fromSource(tag))
    .filter(f => (f.indicators[1] === "0" && !notLcsh(f)) || (f.tag === "655" && f.indicators[1] === "7" && subfieldValue(f, "2") === "lcgft"));
  sourceSubjects.forEach((field, i) => { sourceSubjects[i] = splitDashedHeading(field); add(sourceSubjects[i]); });

  // LCSH headings (indicator 2 "0") from the other sources of the same book (merged
  // results, WorldCat) are added after the source record's own, up to six in all
  const headingKey = subfields => subfields.map(sf => caseKey(Object.values(sf)[0])).join("--");
  const seenHeadings = new Set(sourceSubjects.filter(f => f.tag === "650").map(f => headingKey(f.subfields.filter(sf => "axyzv".includes(Object.keys(sf)[0])))));
  const lcshHeadings = (Array.isArray(book.lcshHeadings) ? book.lcshHeadings : [])
    .filter(h => Array.isArray(h) && h.length && h.every(sf => !isPlaceholder(Object.values(sf)[0]))
      && !notLcsh({tag: "650", subfields: h}));
  let lcshAdded = 0;
  lcshHeadings.forEach(heading => {
    const key = headingKey(heading);
    if (!key || seenHeadings.has(key) || sourceSubjects.length + lcshAdded >= 6) return;
    seenHeadings.add(key);
    const subfields = heading.map(sf => ({...sf}));
    const last = subfields[subfields.length - 1];
    const code = Object.keys(last)[0];
    last[code] = withPunctuation(last[code], ".");
    add(buildField("650", [" ", "0"], subfields));
    lcshAdded++;
  });

  if (!sourceSubjects.length && !lcshAdded) {
    // Subjects from search providers are uncontrolled, so indicator 2 is "4"
    // (source not specified). Use the AI helper for LCSH/Sears headings.
    const seenSubjects = new Set();
    const englishBook = /^eng$/.test(book.language || "") || /^[\x00-\x7F]*$/.test(title);
    subjects.forEach(subject => {
      if (englishBook && /[^\x00-\x7F’–—]/.test(subject)) return;   // e.g. "Umweltökonomie" on an English book
      const key = subject.toLowerCase();
      if (seenSubjects.has(key) || seenSubjects.size >= 5) return;
      seenSubjects.add(key);
      add(buildField("650", [" ", "4"], [{a: withPunctuation(subject, ".")}]));
    });
  }

  // 7XX - Added entries
  const personEntry = name => buildField("700", ["1", " "], [{a: keepIsbd ? withPunctuation(name, ".") : name}]);
  if (hasSource) {
    const added = ["700", "710", "711", "730", "740"].flatMap(tag => (tag === "730" || tag === "740") && !sourceEnglish ? [] : fromSource(tag));
    // Rule of three (setting): more than three personal names → first one only
    const persons = added.filter(f => f.tag === "700" && !subfieldValue(f, "t"));
    const keep = rules.ruleOfThree && persons.length > 3
      ? added.filter(f => f.tag !== "700" || subfieldValue(f, "t") || f === persons[0])
      : added;
    keep.forEach(add);
  } else if (!rules.ruleOfThree) {
    // Rule of three off: an added entry for every creator after the first (the main entry)
    invertedAuthors.slice(1).forEach(author => add(personEntry(author)));
  } else if (authors.length > 3) {
    // Up to 3 authors: added entries for the co-authors.
    // More than 3: added entry for the first-named author only.
    add(personEntry(invertedAuthors[0]));
  } else if (authors.length > 1) {
    invertedAuthors.slice(1).forEach(author => add(personEntry(author)));
  }

  // 800/810/811/830 - Series added entries
  ["800", "810", "811", "830"].flatMap(passThrough).forEach(add);

  // 942 - Koha record-level data: item type (setting) and the call number parts
  // Koha builds the call number from: $2 classification source, $h class part, $i item part
  const kohaSubfields = [];
  if (ddc) kohaSubfields.push({2: "ddc"});
  kohaSubfields.push({c: rules.itemType});
  if (ddc) kohaSubfields.push({h: ddc});
  if (rules.itemNumber && itemNumber) kohaSubfields.push({i: itemNumber});
  add(buildField("942", [" ", " "], kohaSubfields));

  // Local policy (setting): no ending punctuation in any subfield (505 " --" separators
  // between contents titles are kept, as they separate items rather than end an element)
  if (!keepIsbd) {
    record.fields.forEach(field => {
      (field.subfields || []).forEach(sf => {
        const code = Object.keys(sf)[0];
        if (field.tag === "505" && /\s--$/.test(sf[code])) return;
        sf[code] = stripEndingPunctuation(sf[code]);
      });
    });
  }

  // Records held in capital letters get normal capitals (listed by Check record)
  fixCapitals(record, book);
  normaliseIsbnSubfields(record);
  tidyRecord(record);

  // Standard tag order (stable, so repeated fields keep their source order)
  record.fields.sort((x, y) => parseInt(x.tag, 10) - parseInt(y.tag, 10));
  return record;
}

// --- Serials (continuing resources) ---
// A serial's record is taken from the source catalogue as it is (title, ISSN, frequency,
// numbering, earlier and later titles), not rebuilt like a book's. Fields in any language:
// numbers, titles, names, links; in English-language records only: description, notes, subjects.
const SERIAL_ANY_LANGUAGE = ["022", "041", "043", "050", "082", "100", "110", "111", "130", "210", "222", "240", "245", "246", "247",
  "250", "260", "264", "490", "700", "710", "711", "730", "740", "765", "767", "770", "772", "773", "775", "776", "777", "780", "785",
  "787", "800", "810", "811", "830"];
const SERIAL_ENGLISH_ONLY = ["300", "310", "321", "336", "337", "338", "362", "500", "510", "515", "525", "530", "546", "547", "550",
  "555", "580", "588", "600", "610", "611", "630", "648", "650", "651", "655"];
const SERIAL_LINK_TAGS = ["765", "767", "770", "772", "773", "775", "776", "777", "780", "785", "787"];

function buildSerialRecord(book = {}, options = {}) {
  const rules = cataloguingRules(options);
  const keepIsbd = rules.endingPunctuation === "keep";
  const institution = sanitizeText(options.institutionName);
  const english = book.marcSourceEnglish !== false;
  // Leader as Koha's for a new serial; Koha's leader and 008 builders can still be used
  const record = {leader: `#####nas#a22#####7${keepIsbd ? "a" : "c"}#4500`, fields: []};
  const add = field => { if (field) record.fields.push(field); };

  // 008: the source's coding (continuing resources), with today as the date entered
  const source008 = String(book.source008 || "");
  if (source008.length === 40) {
    const now = new Date();
    const entered = [now.getFullYear() % 100, now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, "0")).join("");
    record.fields.push({tag: "008", value: entered + source008.slice(6)});
  }

  const sourceFields = Array.isArray(book.marcFields) ? book.marcFields : [];
  const allowed = field => {
    if (SERIAL_ANY_LANGUAGE.includes(field.tag)) return true;
    if (!english || !SERIAL_ENGLISH_ONLY.includes(field.tag)) return false;
    // Subjects: LCSH (#0) and uncontrolled (# or 4); other thesauri (#7) left out
    return !SUBJECT_TAGS.includes(field.tag) || ["0", "4", " ", "#", "", undefined].includes(field.ind2);
  };
  // Genre headings for the online version (some catalogues describe print and online together)
  const onlineGenre = field => field.tag === "655" && /electronic journals|computer network resources|online/i.test(subfieldValue(field, "a"));
  const carried = sourceFields.filter(allowed).filter(field => !onlineGenre(field)).map(field => {
    // Links to other records keep the title and ISSN ($x), not the source system's record number ($w)
    const kept = SERIAL_LINK_TAGS.includes(field.tag) ? {...field, subfields: (field.subfields || []).filter(sf => Object.keys(sf)[0] !== "w")} : field;
    return cleanSourceField(kept);
  }).filter(Boolean);

  // 022: valid ISSN forms only, each once, the searched ISSN first
  const issnFields = carried.filter(f => f.tag === "022").filter((f, i, all) => {
    const value = formatIssnValue(subfieldValue(f, "a"));
    return !value || all.findIndex(x => formatIssnValue(subfieldValue(x, "a")) === value) === i;
  });
  issnFields.sort((x, y) => (formatIssnValue(subfieldValue(y, "a")) === book.issn) - (formatIssnValue(subfieldValue(x, "a")) === book.issn));
  issnFields.forEach(add);

  // 040 - Cataloging Source (as for books)
  add(buildField("040", [" ", " "], institution ? [{a: institution}, {b: "eng"}, {c: institution}] : [{b: "eng"}]));
  carried.filter(f => f.tag !== "022" && f.tag !== "040").forEach(add);

  // 942 - Koha: the item type for serials (setting; else the usual item type), DDC class part
  const ddc = (sanitizeText(book.ddc).match(/^\d{3}(\.\d+)?/) || [""])[0];
  const kohaSubfields = [];
  if (ddc) kohaSubfields.push({2: "ddc"});
  kohaSubfields.push({c: sanitizeText(options.serialItemType) || rules.itemType});
  if (ddc) kohaSubfields.push({h: ddc});
  add(buildField("942", [" ", " "], kohaSubfields));

  if (!keepIsbd) {
    record.fields.forEach(field => (field.subfields || []).forEach(sf => {
      const code = Object.keys(sf)[0];
      sf[code] = stripEndingPunctuation(sf[code]);
    }));
  }
  tidyRecord(record);
  record.fields.sort((x, y) => parseInt(x.tag, 10) - parseInt(y.tag, 10));
  return record;
}

function formatIssnValue(value) {
  const d = String(value || "").toUpperCase().replace(/[^0-9X]/g, "");
  return /^\d{7}[\dX]$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4)}` : "";
}

/**
 * Output MARC record line by line.
 * Format: TAG IND1 IND2 $a value $b value
 */
function marcToText(record) {
  if (!record || !Array.isArray(record.fields)) return "";

  return record.fields.map(field => {
    if (parseInt(field.tag) < 10) {
      return `${field.tag}    ${field.value || ""}`;
    }

    const ind1 = field.indicators?.[0] || "#";
    const ind2 = field.indicators?.[1] || "#";
    const subfields = (field.subfields || []).map(sf => {
      const code = Object.keys(sf)[0];
      return `$${code} ${sf[code]}`;
    }).join(" ");

    return `${field.tag} ${ind1.replace(" ", "#")}${ind2.replace(" ", "#")} ${subfields}`;
  }).join("\n");
}
