# Changelog

Koha MARC Helper – Koha plugin (`Koha::Plugin::MarcHelper`). GNU GPL v3 or later.

## 1.0.1 — 2026-11-18

- **Login on the plugin's own pages:** when a session had run out and staff logged in again on *Batch cataloguing* or the settings page, the new login was lost (the page said the panel could not start, and asked for the login again). The pages now keep Koha's login cookie.
- **Check headings:** a Library of Congress heading that LC lists with one of its *see from* forms (for example *Computer programming*) was reported as not found; it is now recognised as authorised.
- **Subject headings:** terms that some catalogues code as LCSH in their own language (650 second indicator 0, e.g. *algoritmer*) are no longer copied into the record as LCSH.
- **Search:** the source count no longer counts a source that failed (down, timed out, quota used) as answered.
- **README:** installing from Koha's Plugins page through `<plugin_repos>`, which works when uploads are restricted (`plugins_restricted`, the default), and uploading the `.kpz` where allowed.

## 1.0.0 — 2026-11-18

First public release. Everything below, tested on Koha 26.05.

- **Panel on Add MARC record** (button after *Z39.50/SRU search*, or Alt+M): Search, Record, Fill and Export tabs; docked on the right and resizable.
- **Search** by ISBN, ISSN, title or title and author: about 20 library catalogues and open sources worldwide at once, each shown as it answers; results merged by ISBN (or ISSN), the source higher in the list winning.
- **Records** following AACR2 and your local rules (ending punctuation, statement of responsibility, rule of three, item numbers, 260 or 264, local fields); nothing guessed.
- **Journals and other serials by ISSN:** the print serial's catalogue record kept as it is, with your 040, local fields and 942 (*Koha item type for serials*).
- **Other libraries' Koha OPACs** as sources, by their OPAC pages, their SRU server (`sru=`) or Koha's public REST API (`api`).
- **Check record** (required fields, ISBN and ISSN check digits, indicators, 008, DDC, 942, repeats, MARC length limits) and **Check headings** (Library of Congress authorities and your own Koha authority file, with *Link* writing `$9`).
- **AI Helper** (optional, off by default): 082, 500, 650 (LCSH or Sears) and 246 suggestions for review, through OpenAI, Gemini, DeepSeek, Perplexity, Ollama or Azure OpenAI; keys kept on the server.
- **Fill** the Koha form with a preview of what changes; **Export** as `.mrc` or MARCXML.
- **Batch cataloguing** (*Tools › Tool plugins*): a list of ISBNs and ISSNs searched one at a time, each record checked in the same panel, then staged in Koha with a matching rule (records already in the catalogue are not overlaid) or downloaded.
- **Settings page** with Library, Cataloguing rules, Sources (on/off, order, *Test sources*), Keys (*Test key*), AI Helper and About tabs.
- **Relay** (the Koha server fetches for the panel): approved sources only, https on port 443, redirects re-checked, each key sent only to its own source; grouped requests for Kohas with few Plack workers.

## Development versions (not released)

- 0.7.0 — ISSN search; batch cataloguing page with staging.
- 0.6.0 — AI Helper.
- 0.5.0 — Check headings with the library's own authority file.
- 0.4.x — Other libraries' Koha OPACs as sources (OPAC pages, SRU, public REST API); record quality fixes from large ISBN test runs.
- 0.3.x — International catalogues; grouped relay requests for few Plack workers.
- 0.2.0 — Redesigned panel and tabbed settings page.
- 0.1.0 — First panel: search, record, fill.
