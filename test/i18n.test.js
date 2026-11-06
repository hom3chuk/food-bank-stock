'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sandbox = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'docs', 'i18n.js'), 'utf8'), sandbox);
const { languages, strings } = JSON.parse(JSON.stringify(sandbox.window.I18N));
const appCode = fs.readFileSync(path.join(__dirname, '..', 'docs', 'app.js'), 'utf8');
const serverCode = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const forms = (value) => (typeof value === 'string' ? [value] : Object.values(value));

test('every language has exactly the same keys', () => {
  const english = Object.keys(strings.en).sort();
  for (const { id } of languages) assert.deepEqual(Object.keys(strings[id]).sort(), english, id);
});

test('every translation fills in the same values as the English', () => {
  for (const { id } of languages) {
    for (const [key, value] of Object.entries(strings[id])) {
      const expected = new Set(forms(strings.en[key]).flatMap(placeholders));
      for (const form of forms(value)) {
        assert.ok(form.trim(), `${id} ${key} is empty`);
        assert.deepEqual(new Set(placeholders(form)), expected, `${id} ${key}`);
      }
    }
  }
});

test('number-dependent text has every form its language needs', () => {
  for (const { id, htmlLang } of languages) {
    const needed = new Intl.PluralRules(htmlLang).resolvedOptions().pluralCategories;
    for (const [key, value] of Object.entries(strings[id])) {
      if (typeof value === 'string') continue;
      for (const category of needed) assert.ok(value[category], `${id} ${key} is missing "${category}"`);
    }
  }
});

test('Russian and Serbian plural forms read correctly', () => {
  const pick = (lang, tag, key, n) => {
    const value = strings[lang][key];
    return value[new Intl.PluralRules(tag).select(n)].replace('{n}', n);
  };
  const ru = (n) => pick('ru', 'ru', 'count.packets', n);
  assert.deepEqual([1, 2, 5, 11, 21, 22, 25].map(ru),
    ['1 пакет', '2 пакета', '5 пакетов', '11 пакетов', '21 пакет', '22 пакета', '25 пакетов']);
  const sr = (n) => pick('sr', 'sr-Latn', 'count.packets', n);
  assert.deepEqual([1, 2, 5, 11, 21].map(sr), ['1 paket', '2 paketa', '5 paketa', '11 paketa', '21 paket']);
});

test('every text key the app and server use exists', () => {
  const used = [...appCode.matchAll(/\b(?:t|say)\('([\w.]+)'/g)].map((m) => m[1]).filter((key) => !key.endsWith('.'));
  assert.ok(used.length > 100, `found only ${used.length} uses`);
  for (const key of used) assert.ok(key in strings.en, `missing text: ${key}`);

  const fromServer = [...serverCode.matchAll(/new ApiError\('\w+', '(\w+)'/g)].map((m) => m[1]);
  assert.ok(fromServer.length > 15, `found only ${fromServer.length} server errors`);
  for (const key of fromServer) assert.ok(`err.${key}` in strings.en, `missing server text: err.${key}`);
});

test('no key in the table is left unused', () => {
  const dynamic = /^(tab|cat|status)\./;
  const serverKeys = new Set([
    ...[...serverCode.matchAll(/new ApiError\('\w+', '(\w+)'/g)].map((m) => `err.${m[1]}`),
    ...[...serverCode.matchAll(/\bkey: '(\w+)'/g)].map((m) => `err.${m[1]}`),
    ...[...appCode.matchAll(/\bkey: '(\w+)'/g)].map((m) => `err.${m[1]}`),
  ]);
  for (const key of Object.keys(strings.en)) {
    if (dynamic.test(key) || serverKeys.has(key)) continue;
    assert.ok(appCode.includes(`'${key}'`), `unused text: ${key}`);
  }
});

test('Serbian uses Latin script only', () => {
  for (const [key, value] of Object.entries(strings.sr)) {
    // Setup errors quote the sheet's menu by its real name, which is in Russian.
    for (const form of forms(value)) {
      assert.doesNotMatch(form.replace(/Банк еды > (Задать код доступа|Настроить таблицу)/, ''), /[Ѐ-ӿ]/, key);
    }
  }
});
