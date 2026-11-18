// Koha MARC Helper - Check headings in the panel. GPL v3 or later.
// The rules are shared with the extension (lib/marc-tools.js, fully tested there in
// tests/headings.test.js); this checks the copy the plugin ships and that the panel uses it.
// Run: node t/headings.test.js (the shared files are kept in Koha/Plugin/MarcHelper/static)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const STATIC = path.join(__dirname, '..', 'Koha', 'Plugin', 'MarcHelper', 'static');
const sandbox = {window: {}, document: {}, console, TextEncoder};
vm.createContext(sandbox);
for (const file of ['marc-parser.js', 'marc-tools.js', 'panel.js']) {
  // Top-level const in separate scripts: made globals here, as they are on the Koha page
  vm.runInContext(fs.readFileSync(path.join(STATIC, file), 'utf8').replace(/^(const|let) (\w+) =/gm, 'var $2 ='), sandbox, {filename: file});
}

let failed = 0;
let count = 0;
function check(name, ok, detail = '') {
  count++;
  if (!ok) failed++;
  console.log(`${ok ? 'ok' : 'not ok'} ${count} - ${name}${ok ? '' : `  ${detail}`}`);
}
const field = (tag, ind2, subfields) => ({tag, indicators: [' ', ind2], subfields});
const panelCode = fs.readFileSync(path.join(STATIC, 'panel.js'), 'utf8');

check('the panel uses the shared rules', ['headingForm(', 'headingLcScheme(', 'writeHeadingForm(', 'headingTextToSubfields(', 'headingWire'].every(f => panelCode.includes(f)));
check('the panel has no copy of its own', !/function (punctuate|writeHeading|headingText)\(/.test(panelCode));
check('Use and Link follow the library\'s ending-punctuation rule',
  (panelCode.match(/writeHeadingForm\([^;]*settings\.ruleEndingPunctuation\)/g) || []).length === 2);
const linked = field('650', '0', [{a: 'Computer programming'}]);
sandbox.writeHeadingForm(linked, [{a: 'Computer programming'}], 1694, 'remove');
check('rule "remove": the linked heading has no full stop', JSON.stringify(linked.subfields) === JSON.stringify([{a: 'Computer programming'}, {9: '1694'}]), JSON.stringify(linked.subfields));
check('heading form', sandbox.headingForm(field('700', ' ', [{a: 'Yeats, W. B.'}, {q: '(William Butler),'}, {d: '1865-1939.'}])) === 'Yeats, W. B. (William Butler), 1865-1939');
const name = field('100', ' ', [{a: 'Tagore, R.'}, {e: 'author.'}, {9: '17'}]);
sandbox.writeHeadingForm(name, [{a: 'Tagore, Rabindranath'}, {d: '1861-1941'}], 2235);
check('AACR2 punctuation and $9', JSON.stringify(name.subfields) === JSON.stringify([{a: 'Tagore, Rabindranath,'}, {d: '1861-1941,'}, {e: 'author.'}, {9: '2235'}]), JSON.stringify(name.subfields));
check('heading sent to /authorities', JSON.stringify(sandbox.headingWire(field('650', '0', [{a: 'Hindu philosophy.'}, {9: '3'}]))) === JSON.stringify({tag: '650', ind1: ' ', ind2: '0', subfields: [['a', 'Hindu philosophy.']]}));

console.log(failed ? `${failed} of ${count} failed` : `all ${count} passed`);
process.exit(failed ? 1 : 0);
