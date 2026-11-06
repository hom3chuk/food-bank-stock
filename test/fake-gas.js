'use strict';
// An in-memory stand-in for the Google services Code.gs uses. It copies the Sheets
// behaviours most likely to cause bugs: numeric-looking text becomes a number unless
// the cell is plain text, and ranges must match the size of the data written to them.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CODE_PATH = path.join(__dirname, '..', 'apps-script', 'Code.gs');

function coerce(value, format) {
  if (typeof value !== 'string') return value;
  const text = value.startsWith("'") ? value.slice(1) : value;
  if (format === '@') return text;
  if (value.startsWith("'")) return text;
  if (text.startsWith('=')) return { formula: text };
  if (text !== '' && !Number.isNaN(Number(text))) return Number(text);
  return text;
}

class FakeRange {
  constructor(sheet, row, col, rows, cols) {
    if (row < 1 || col < 1 || rows < 1 || cols < 1) throw new Error(`Bad range ${row},${col},${rows},${cols}`);
    if (row + rows - 1 > sheet.maxRows) throw new Error(`Range past the last row (${row + rows - 1} > ${sheet.maxRows})`);
    Object.assign(this, { sheet, row, col, rows, cols });
  }
  each(fn) {
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) fn(r, c, this.row + r - 1, this.col + c - 1);
  }
  getValues() {
    const out = Array.from({ length: this.rows }, () => Array(this.cols).fill(''));
    this.each((r, c, sr, sc) => { const v = this.sheet.cell(sr, sc).value; out[r][c] = v === undefined ? '' : v; });
    return out;
  }
  setValues(values) {
    if (values.length !== this.rows || values.some((v) => v.length !== this.cols)) throw new Error('setValues: size mismatch');
    this.each((r, c, sr, sc) => { const cell = this.sheet.cell(sr, sc); cell.value = coerce(values[r][c], cell.format); });
    return this;
  }
  setNumberFormats(formats) {
    if (formats.length !== this.rows || formats.some((v) => v.length !== this.cols)) throw new Error('setNumberFormats: size mismatch');
    this.each((r, c, sr, sc) => { this.sheet.cell(sr, sc).format = formats[r][c]; });
    return this;
  }
  setNumberFormat(format) {
    this.each((r, c, sr, sc) => { this.sheet.cell(sr, sc).format = format; });
    return this;
  }
  clearContent() {
    this.each((r, c, sr, sc) => { this.sheet.cell(sr, sc).value = ''; });
    return this;
  }
  setFontWeight() { return this; }
  getSheet() { return this.sheet; }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.maxRows = 1000;
    this.cells = new Map();
  }
  cell(r, c) {
    const key = `${r},${c}`;
    if (!this.cells.has(key)) this.cells.set(key, { value: '', format: null });
    return this.cells.get(key);
  }
  getName() { return this.name; }
  getMaxRows() { return this.maxRows; }
  getLastRow() {
    let last = 0;
    for (const [key, cell] of this.cells) {
      if (cell.value !== '' && cell.value !== undefined) last = Math.max(last, Number(key.split(',')[0]) + 1);
    }
    return last;
  }
  getRange(row, col, rows = 1, cols = 1) { return new FakeRange(this, row, col, rows, cols); }
  insertRowsAfter(_after, n) { this.maxRows += n; }
  setFrozenRows() {}
  /** Test helper: the tab as objects keyed by header. */
  rows() {
    const last = this.getLastRow();
    let width = 0;
    while (this.cell(0, width).value !== '') width++;
    const header = Array.from({ length: width }, (_, c) => this.cell(0, c).value);
    const out = [];
    for (let r = 1; r < last; r++) {
      out.push(Object.fromEntries(header.map((name, c) => [name, this.cell(r, c).value])));
    }
    return out;
  }
}

function createBackend({ passcode = 'test-passcode', date = () => new Date(), blankName = 'Sheet1' } = {}) {
  const sheets = new Map([[blankName, new FakeSheet(blankName)]]);
  const props = new Map(passcode ? [['PASSCODE', passcode]] : []);
  const spreadsheet = {
    getSheetByName: (n) => sheets.get(n) || null,
    insertSheet: (n) => { const s = new FakeSheet(n); sheets.set(n, s); return s; },
    getSheets: () => [...sheets.values()],
    deleteSheet: (s) => sheets.delete(s.getName()),
    getUrl: () => 'https://docs.google.com/spreadsheets/d/fake',
    getSpreadsheetTimeZone: () => 'UTC',
    toast: () => {},
  };
  const uiMenu = { addItem() { return uiMenu; }, addToUi() {} };
  const context = {
    console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      getUi: () => ({
        createMenu: () => uiMenu,
        alert() {},
        ButtonSet: { OK_CANCEL: 1 },
        Button: { OK: 1 },
        prompt: () => ({ getSelectedButton: () => 1, getResponseText: () => 'test-passcode' }),
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => props.get(k) || null, setProperty: (k, v) => props.set(k, v) }),
    },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (text) => ({ setMimeType: () => ({ text }) }),
    },
    Utilities: {
      formatDate(d, _tz, pattern) {
        const iso = new Date(d).toISOString();
        return pattern === 'yyyy-MM-dd' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
      },
    },
  };
  // Lets tests set the date without changing how Code.gs asks for it.
  const RealDate = Date;
  context.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [date()])); }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(CODE_PATH, 'utf8'), context, { filename: 'Code.gs' });
  context.onOpen();
  context.setupSheet();

  return {
    tab: (name) => sheets.get(name),
    tabs: () => [...sheets.keys()],
    context,
    call(action, payload = {}, pass = passcode) {
      const output = context.doPost({ postData: { contents: JSON.stringify({ volunteer: 'Sam', ...payload, action, passcode: pass }) } });
      return JSON.parse(output.text);
    },
  };
}

module.exports = { createBackend };
