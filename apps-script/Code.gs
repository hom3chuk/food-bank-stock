/**
 * Limits this script's Google permission to the one spreadsheet it is attached to.
 * @OnlyCurrentDoc
 */

/**
 * Food bank stock tracker: Google Sheets backend.
 *
 * Everything people see in the sheet is in Russian. The app gets fixed codes instead (see
 * apiStatus_ and ApiError) and shows them in each volunteer's own language.
 *
 * The log tab (TABS.LOG) is the source of truth. Every stock movement is one row, and
 * the stock and daily tabs are rebuilt from it after each change.
 *
 * What each action does to the three statuses:
 *   RECEIVED              available +qty
 *   PACKED                available -qty, packed +qty
 *   UNPACKED              packed -qty, available +qty
 *   GIVEN_OUT (packet)    packed -qty, given out +qty
 *   GIVEN_OUT (no packet) available -qty, given out +qty
 * An item handed back from a packet during a handout is an UNPACKED row for just that item.
 * Editing a packet on the shelf is PACKED rows for what went in and UNPACKED rows for what came out.
 * Undo appends the same rows with a negative qty, so history is never erased.
 */

const TABS = {
  STOCK: 'Остатки',
  DAILY: 'По дням',
  DETAIL: 'По дням подробно',
  PACKETS: 'Пакеты',
  PRODUCTS: 'Продукты',
  LOG: 'Журнал',
};

const TEXT = '@';
const NUM = '0';

const COLUMNS = {
  [TABS.STOCK]: [
    ['Штрихкод', 'barcode', TEXT], ['Продукт', 'name', TEXT], ['Категория', 'category', TEXT],
    ['В наличии', 'available', NUM], ['Упаковано', 'packed', NUM], ['Выдано', 'given', NUM],
    ['Всего получено', 'received', NUM],
  ],
  [TABS.DAILY]: [
    ['Дата', 'date', TEXT], ['Получено', 'received', NUM], ['Упаковано', 'packed', NUM],
    ['Выдано', 'given', NUM], ['Пакетов выдано', 'packets', NUM], ['Выдач', 'handouts', NUM],
  ],
  [TABS.DETAIL]: [
    ['Дата', 'date', TEXT], ['Штрихкод', 'barcode', TEXT], ['Продукт', 'name', TEXT],
    ['Получено', 'received', NUM], ['Упаковано', 'packed', NUM], ['Выдано', 'given', NUM],
  ],
  [TABS.PACKETS]: [
    ['Пакет', 'number', NUM], ['Статус', 'status', TEXT], ['Дата упаковки', 'packedOn', TEXT],
    ['Упаковал(а)', 'packedBy', TEXT], ['Дата выдачи', 'givenOn', TEXT], ['Выдал(а)', 'givenBy', TEXT],
    ['Содержимое', 'contents', TEXT], ['Примечание', 'note', TEXT],
  ],
  [TABS.PRODUCTS]: [
    ['Штрихкод', 'barcode', TEXT], ['Название', 'name', TEXT], ['Категория', 'category', TEXT],
    ['Описание', 'description', TEXT], ['Первое поступление', 'firstSeen', TEXT],
  ],
  [TABS.LOG]: [
    ['Время', 'timestamp', TEXT], ['Дата', 'date', TEXT], ['Действие', 'action', TEXT],
    ['Штрихкод', 'barcode', TEXT], ['Продукт', 'name', TEXT], ['Кол-во', 'qty', NUM],
    ['Пакет', 'packet', NUM], ['Волонтёр', 'volunteer', TEXT], ['Примечание', 'note', TEXT],
    ['ID операции', 'op', TEXT],
  ],
};

const ACTION = { RECEIVED: 'Получено', PACKED: 'Упаковано', UNPACKED: 'Распаковано', GIVEN_OUT: 'Выдано' };
const PACKET = { ON_SHELF: 'На полке', GIVEN_OUT: 'Выдан', CANCELLED: 'Отменён', UNPACKED: 'Распакован' };
const STATUS_CODES = {};
STATUS_CODES[PACKET.ON_SHELF] = 'On shelf';
STATUS_CODES[PACKET.GIVEN_OUT] = 'Given out';
STATUS_CODES[PACKET.CANCELLED] = 'Cancelled';
STATUS_CODES[PACKET.UNPACKED] = 'Unpacked';
const EDIT_NOTE = 'Изменено';
const HANDED_BACK_NOTE = 'Возвращено';
const UNDO_NOTE = 'Отмена';
const UNKNOWN_VOLUNTEER = 'Неизвестно';
const SORT_LOCALE = 'ru';
const BLANK_TAB_NAMES = ['Sheet1', 'Лист1'];
const MAX_QTY = 100000;
const MAX_PACKETS_AT_ONCE = 500;
const MIN_PASSCODE_LENGTH = 6;

/* ---------- Web API ---------- */

function doGet() {
  return json_({ ok: true, service: 'food-bank-tracker' });
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    checkPasscode_(req.passcode);
    return json_(dispatch_(req));
  } catch (err) {
    if (err instanceof ApiError) return json_(Object.assign({ ok: false, code: err.code, key: err.key, params: err.params }, err.extra));
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, code: 'SERVER', key: 'generic', params: {} });
  }
}

/** `key` names the message in docs/i18n.js (err.<key>), because each phone has its own language. */
class ApiError extends Error {
  constructor(code, key, params, extra) {
    super(key);
    this.code = code;
    this.key = key;
    this.params = params || {};
    this.extra = extra || {};
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function checkPasscode_(given) {
  const expected = PropertiesService.getScriptProperties().getProperty('PASSCODE');
  if (!expected) throw new ApiError('NOT_SET_UP', 'noPasscode');
  if (String(given || '') !== expected) throw new ApiError('BAD_PASSCODE', 'badPasscode');
}

function dispatch_(req) {
  const writes = { receive: receive_, pack: pack_, editPacket: editPacket_, handout: handout_, unpack: unpack_, undo: undo_ };
  if (req.action === 'bootstrap') return { ok: true, state: state_(load_()) };
  const handler = writes[req.action];
  if (!handler) throw new ApiError('BAD_REQUEST', 'generic');

  const op = String(req.opId || '');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(op)) throw new ApiError('BAD_REQUEST', 'generic');

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(25000);
  } catch (err) {
    throw new ApiError('BUSY', 'busy');
  }
  try {
    const db = load_();
    // A retry after a lost connection must not count the same donation twice.
    const prior = db.log.filter(function (r) { return r.op === op; });
    if (prior.length) return { ok: true, replayed: true, opId: op, result: resultFromRows_(prior), state: state_(db) };

    const result = handler(req, db, { op: op, volunteer: cleanText_(req.volunteer, 60) || UNKNOWN_VOLUNTEER, now: now_() });
    rebuildViews_(db);
    return { ok: true, opId: op, result: result, state: state_(db) };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Actions ---------- */

function receive_(req, db, ctx) {
  const qty = cleanQty_(req.qty);
  let code = req.barcode ? normBarcode_(req.barcode) : '';
  let product = code ? findProduct_(db, code) : null;

  if (!product) {
    const info = req.product || {};
    const name = cleanText_(info.name, 120);
    if (!name) throw new ApiError('UNKNOWN_PRODUCT', 'newBarcode', {}, { barcode: code });
    if (!code) code = nextNoBarcodeCode_(db);
    product = {
      barcode: code,
      name: name,
      category: cleanText_(info.category, 60),
      description: cleanText_(info.description, 300),
      firstSeen: ctx.now.date,
    };
    db.products.push(product);
    appendRows_(TABS.PRODUCTS, [product]);
  }

  addLog_(db, ctx, [{ action: ACTION.RECEIVED, barcode: code, name: product.name, qty: qty, note: cleanText_(req.note, 200) }]);
  return { action: ACTION.RECEIVED, barcode: code, name: product.name, qty: qty };
}

function pack_(req, db, ctx) {
  const items = cleanItems_(req.items, db);
  if (!items.length) throw new ApiError('BAD_REQUEST', 'emptyPacket');

  const count = Number(req.count === undefined ? 1 : req.count);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PACKETS_AT_ONCE) {
    throw new ApiError('BAD_REQUEST', 'packetCount', { max: MAX_PACKETS_AT_ONCE });
  }

  checkAvailable_(db, items.map(function (i) { return { barcode: i.barcode, name: i.name, qty: i.qty * count }; }), req.force);

  const first = db.packets.reduce(function (max, p) { return Math.max(max, Number(p.number) || 0); }, 0) + 1;
  const contents = describeItems_(items);
  const note = cleanText_(req.note, 200);
  const numbers = [];
  const packetRows = [];
  const logRows = [];
  for (let n = first; n < first + count; n++) {
    numbers.push(n);
    packetRows.push({
      number: n, status: PACKET.ON_SHELF, packedOn: ctx.now.date, packedBy: ctx.volunteer,
      givenOn: '', givenBy: '', contents: contents, note: note,
    });
    items.forEach(function (i) {
      logRows.push({ action: ACTION.PACKED, barcode: i.barcode, name: i.name, qty: i.qty, packet: n });
    });
  }
  const startRow = appendRows_(TABS.PACKETS, packetRows);
  packetRows.forEach(function (p, idx) { p.row = startRow + idx; db.packets.push(p); });
  addLog_(db, ctx, logRows);
  return { action: ACTION.PACKED, numbers: numbers, contents: contents };
}

/** Everything one person takes: any packets plus items picked straight off the shelves. */
function handout_(req, db, ctx) {
  const numbers = (Array.isArray(req.packets) ? req.packets : []).map(Number)
    .filter(function (n, i, all) { return all.indexOf(n) === i; });
  const packets = numbers.map(function (n) { return requirePacket_(db, n); });
  packets.forEach(requireOnShelf_);
  const plans = planPackets_(db, packets, req.removals);

  const items = cleanItems_(req.items, db);
  if (!packets.length && !items.length) throw new ApiError('BAD_REQUEST', 'emptyBasket');
  checkAvailable_(db, items, req.force);

  const rows = items.map(function (i) {
    return { action: ACTION.GIVEN_OUT, barcode: i.barcode, name: i.name, qty: i.qty };
  });
  plans.forEach(function (plan) {
    plan.given.forEach(function (i) {
      rows.push({ action: ACTION.GIVEN_OUT, barcode: i.barcode, name: i.name, qty: i.qty, packet: plan.packet.number });
    });
  });
  // Handed-back rows go last: undo_ reads the first row to see what kind of action this was.
  plans.forEach(function (plan) {
    plan.handedBack.forEach(function (i) {
      rows.push({ action: ACTION.UNPACKED, barcode: i.barcode, name: i.name, qty: i.qty, packet: plan.packet.number, note: HANDED_BACK_NOTE });
    });
  });
  addLog_(db, ctx, rows);
  plans.forEach(function (plan) {
    const back = plan.handedBack.length ? ' (возвращено: ' + describeItems_(plan.handedBack) + ')' : '';
    updatePacket_(plan.packet, {
      status: PACKET.GIVEN_OUT, givenOn: ctx.now.date, givenBy: ctx.volunteer, contents: describeItems_(plan.given) + back,
    });
  });
  return { action: ACTION.GIVEN_OUT, numbers: numbers, contents: describeItems_(items) };
}

/** Works out what each packet gives and what comes back. Checks everything before anything is written. */
function planPackets_(db, packets, removals) {
  const list = Array.isArray(removals) ? removals : [];
  list.forEach(function (r) {
    if (!packets.some(function (p) { return Number(p.number) === Number(r.packet); })) {
      throw new ApiError('BAD_REQUEST', 'packetNotInBasket', { number: r.packet });
    }
  });
  return packets.map(function (packet) {
    const remove = {};
    list.filter(function (r) { return Number(r.packet) === Number(packet.number); }).forEach(function (r) {
      const code = normBarcode_(r.barcode);
      remove[code] = (remove[code] || 0) + cleanQty_(r.qty);
    });
    const contents = packetContents_(db, packet.number);
    const given = [];
    const handedBack = [];
    contents.forEach(function (i) {
      const back = remove[i.barcode] || 0;
      if (back > i.qty) throw new ApiError('BAD_REQUEST', 'packetOnlyHas', { number: packet.number, qty: i.qty, name: i.name });
      if (back) handedBack.push({ barcode: i.barcode, name: i.name, qty: back });
      if (i.qty > back) given.push({ barcode: i.barcode, name: i.name, qty: i.qty - back });
      delete remove[i.barcode];
    });
    if (Object.keys(remove).length) throw new ApiError('BAD_REQUEST', 'packetLacksItem', { number: packet.number });
    if (!given.length) throw new ApiError('BAD_REQUEST', 'packetWouldBeEmpty', { number: packet.number });
    return { packet: packet, given: given, handedBack: handedBack };
  });
}

/** Changes one packet on the shelf. Its number stays the same, and only the differences move stock. */
function editPacket_(req, db, ctx) {
  const packet = requirePacket_(db, req.number);
  requireOnShelf_(packet);
  const wanted = cleanItems_(req.items, db);
  if (!wanted.length) throw new ApiError('BAD_REQUEST', 'emptyPacket');

  const current = packetContents_(db, packet.number);
  const qtyIn = function (list, code) {
    const found = list.filter(function (i) { return i.barcode === code; })[0];
    return found ? found.qty : 0;
  };
  const added = wanted
    .map(function (i) { return { barcode: i.barcode, name: i.name, qty: i.qty - qtyIn(current, i.barcode) }; })
    .filter(function (i) { return i.qty > 0; });
  const removed = current
    .map(function (i) { return { barcode: i.barcode, name: i.name, qty: i.qty - qtyIn(wanted, i.barcode) }; })
    .filter(function (i) { return i.qty > 0; });
  if (!added.length && !removed.length) return { action: 'EDITED', numbers: [packet.number], unchanged: true };

  checkAvailable_(db, added, req.force);
  const toRow = function (action) {
    return function (i) {
      return { action: action, barcode: i.barcode, name: i.name, qty: i.qty, packet: packet.number, note: EDIT_NOTE };
    };
  };
  addLog_(db, ctx, added.map(toRow(ACTION.PACKED)).concat(removed.map(toRow(ACTION.UNPACKED))));
  updatePacket_(packet, { contents: describeItems_(wanted) });
  return { action: 'EDITED', numbers: [packet.number], contents: describeItems_(wanted) };
}

function unpack_(req, db, ctx) {
  const packet = requirePacket_(db, req.number);
  requireOnShelf_(packet);
  const items = packetContents_(db, packet.number);
  addLog_(db, ctx, items.map(function (i) {
    return { action: ACTION.UNPACKED, barcode: i.barcode, name: i.name, qty: i.qty, packet: packet.number };
  }));
  updatePacket_(packet, { status: PACKET.UNPACKED });
  return { action: ACTION.UNPACKED, numbers: [packet.number], contents: packet.contents };
}

function undo_(req, db, ctx) {
  const target = String(req.targetOp || '');
  const rows = db.log.filter(function (r) { return r.op === target; });
  if (!target || !rows.length) throw new ApiError('NOT_FOUND', 'undoNotFound');
  if (target.indexOf(':undo') !== -1) throw new ApiError('BAD_REQUEST', 'undoNotFound');

  const undoOp = target + ':undo';
  if (db.log.some(function (r) { return r.op === undoOp; })) return { action: 'UNDO', alreadyUndone: true };

  const action = rows[0].action;
  const edited = rows[0].note === EDIT_NOTE;
  const numbers = uniqueNumbers_(rows);
  const change = {};
  change[ACTION.PACKED] = { from: PACKET.ON_SHELF, to: { status: PACKET.CANCELLED } };
  change[ACTION.GIVEN_OUT] = { from: PACKET.GIVEN_OUT, to: { status: PACKET.ON_SHELF, givenOn: '', givenBy: '' } };
  change[ACTION.UNPACKED] = { from: PACKET.UNPACKED, to: { status: PACKET.ON_SHELF } };

  const packets = numbers.map(function (n) { return requirePacket_(db, n); });
  if (packets.length) {
    const from = edited ? PACKET.ON_SHELF : change[action].from;
    packets.forEach(function (p) {
      if (p.status !== from) {
        throw new ApiError('CONFLICT', 'undoConflict', { number: p.number, status: apiStatus_(p.status) });
      }
    });
  }

  const reversal = rows.map(function (r) {
    return { action: r.action, barcode: r.barcode, name: r.name, qty: -Number(r.qty), packet: r.packet, note: UNDO_NOTE };
  });

  // A later edit can make this undo impossible: it could leave a packet holding less than nothing,
  // or cancel a packet that still has items in it. Refuse rather than break the counts.
  const after = netByPacket_(db.log.concat(reversal));
  packets.forEach(function (p) {
    const net = after[p.number] || {};
    Object.keys(net).forEach(function (code) {
      const cancelling = action === ACTION.PACKED && !edited;
      if (net[code].qty < 0 || (cancelling && net[code].qty > 0)) {
        throw new ApiError('CONFLICT', 'undoEdited', { number: p.number });
      }
    });
  });

  addLog_(db, Object.assign({}, ctx, { op: undoOp }), reversal);
  packets.forEach(function (p) {
    const to = edited ? {} : Object.assign({}, change[action].to);
    // Anything handed back or edited is restored, so the description goes back too.
    if (edited || action === ACTION.GIVEN_OUT) to.contents = describeItems_(packetContents_(db, p.number));
    updatePacket_(p, to);
  });
  return { action: 'UNDO', numbers: numbers };
}

/* ---------- Domain helpers ---------- */

function computeStock_(log) {
  const stock = {};
  log.forEach(function (r) {
    if (!r.barcode) return;
    const s = stock[r.barcode] || (stock[r.barcode] = { available: 0, packed: 0, given: 0, received: 0 });
    const q = Number(r.qty) || 0;
    if (r.action === ACTION.RECEIVED) { s.available += q; s.received += q; }
    else if (r.action === ACTION.PACKED) { s.available -= q; s.packed += q; }
    else if (r.action === ACTION.UNPACKED) { s.available += q; s.packed -= q; }
    else if (r.action === ACTION.GIVEN_OUT) {
      if (r.packet) s.packed -= q; else s.available -= q;
      s.given += q;
    }
  });
  return stock;
}

function checkAvailable_(db, needs, force) {
  if (force) return;
  const stock = computeStock_(db.log);
  const shortages = needs
    .map(function (i) {
      return { barcode: i.barcode, name: i.name, needed: i.qty, available: (stock[i.barcode] || {}).available || 0 };
    })
    .filter(function (s) { return s.needed > s.available; });
  if (shortages.length) throw new ApiError('INSUFFICIENT', 'generic', {}, { shortages: shortages });
}

function cleanItems_(items, db) {
  const merged = {};
  const order = [];
  (Array.isArray(items) ? items : []).forEach(function (item) {
    const code = normBarcode_(item.barcode);
    const product = findProduct_(db, code);
    if (!product) throw new ApiError('UNKNOWN_PRODUCT', 'notReceived', { code: code }, { barcode: code });
    if (!merged[code]) {
      merged[code] = { barcode: code, name: product.name, qty: 0 };
      order.push(code);
    }
    merged[code].qty += cleanQty_(item.qty);
  });
  return order.map(function (c) { return merged[c]; });
}

/** What is in each packet now, by packet number: what went in, minus anything taken back out. */
function contentsByPacket_(log) {
  const nets = netByPacket_(log);
  const out = {};
  Object.keys(nets).forEach(function (n) {
    out[n] = Object.keys(nets[n]).map(function (k) { return nets[n][k]; }).filter(function (i) { return i.qty > 0; });
  });
  return out;
}

function netByPacket_(log) {
  const nets = {};
  log.forEach(function (r) {
    if (!r.packet || (r.action !== ACTION.PACKED && r.action !== ACTION.UNPACKED)) return;
    const net = nets[r.packet] || (nets[r.packet] = {});
    const item = net[r.barcode] || (net[r.barcode] = { barcode: r.barcode, name: r.name, qty: 0 });
    item.qty += (r.action === ACTION.PACKED ? 1 : -1) * (Number(r.qty) || 0);
  });
  return nets;
}

function packetContents_(db, number) {
  return contentsByPacket_(db.log)[Number(number)] || [];
}

function requirePacket_(db, number) {
  const n = Number(number);
  const packet = db.packets.filter(function (p) { return Number(p.number) === n; })[0];
  if (!Number.isInteger(n) || !packet) throw new ApiError('NOT_FOUND', 'noSuchPacket', { number: number });
  return packet;
}

function requireOnShelf_(packet) {
  if (packet.status === PACKET.ON_SHELF) return;
  throw new ApiError('CONFLICT', 'packetStatus', { number: packet.number, status: apiStatus_(packet.status), givenOn: packet.givenOn, givenBy: packet.givenBy });
}

function findProduct_(db, code) {
  return db.products.filter(function (p) { return p.barcode === code; })[0] || null;
}

function nextNoBarcodeCode_(db) {
  const max = db.products.reduce(function (m, p) {
    const match = /^NB-(\d+)$/.exec(p.barcode);
    return match ? Math.max(m, Number(match[1])) : m;
  }, 0);
  return 'NB-' + ('000' + (max + 1)).slice(-4);
}

function describeItems_(items) {
  return items.map(function (i) { return i.qty + ' × ' + i.name; }).join('; ');
}

function uniqueNumbers_(rows) {
  const seen = {};
  rows.forEach(function (r) { if (r.packet) seen[r.packet] = true; });
  return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
}

function resultFromRows_(rows) {
  const firstPacket = rows.filter(function (r) { return r.packet === rows[0].packet; });
  return {
    action: rows[0].action,
    contents: describeItems_(firstPacket),
    barcode: rows[0].barcode,
    name: rows[0].name,
    qty: rows[0].qty,
    numbers: uniqueNumbers_(rows),
  };
}

/* ---------- Input cleaning ---------- */

function normBarcode_(value) {
  const code = String(value === undefined || value === null ? '' : value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(code)) throw new ApiError('BAD_REQUEST', 'badBarcode');
  // The same product can read as a 12-digit UPC or a 13-digit EAN with a leading zero.
  return /^0\d{12}$/.test(code) ? code.slice(1) : code;
}

function cleanQty_(value) {
  const q = Number(value);
  if (!Number.isInteger(q) || q < 1 || q > MAX_QTY) throw new ApiError('BAD_REQUEST', 'badQuantity');
  return q;
}

/** Trims free text and stops Sheets from running it as a formula. */
function cleanText_(value, maxLength) {
  const text = String(value === undefined || value === null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim()
    .slice(0, maxLength);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

/* ---------- Sheet access ---------- */

function sheet_(tab) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tab);
  if (!sheet) throw new ApiError('NOT_SET_UP', 'tabMissing', { tab: tab });
  return sheet;
}

function now_() {
  const d = new Date();
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return { date: Utilities.formatDate(d, tz, 'yyyy-MM-dd'), timestamp: Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm') };
}

function readTable_(tab) {
  const sheet = sheet_(tab);
  const cols = COLUMNS[tab];
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return sheet.getRange(2, 1, last - 1, cols.length).getValues().map(function (values, i) {
    const row = { row: i + 2 };
    cols.forEach(function (col, c) {
      const v = values[c];
      if (v instanceof Date) row[col[1]] = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
      else row[col[1]] = col[2] === TEXT ? String(v).trim() : v;
    });
    return row;
  });
}

function load_() {
  return { products: readTable_(TABS.PRODUCTS), log: readTable_(TABS.LOG), packets: readTable_(TABS.PACKETS) };
}

function toValues_(tab, objects) {
  return objects.map(function (o) {
    return COLUMNS[tab].map(function (col) { return o[col[1]] === undefined || o[col[1]] === null ? '' : o[col[1]]; });
  });
}

function formatsFor_(tab, count) {
  const formats = COLUMNS[tab].map(function (col) { return col[2]; });
  const out = [];
  for (let i = 0; i < count; i++) out.push(formats);
  return out;
}

/** Appends rows and returns the first row number written. */
function appendRows_(tab, objects) {
  const sheet = sheet_(tab);
  const start = sheet.getLastRow() + 1;
  const needed = start + objects.length - 1 - sheet.getMaxRows();
  if (needed > 0) sheet.insertRowsAfter(sheet.getMaxRows(), needed);
  const range = sheet.getRange(start, 1, objects.length, COLUMNS[tab].length);
  range.setNumberFormats(formatsFor_(tab, objects.length)); // Keeps leading zeros and text dates intact.
  range.setValues(toValues_(tab, objects));
  return start;
}

function replaceTable_(tab, objects) {
  const sheet = sheet_(tab);
  const width = COLUMNS[tab].length;
  const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, width).clearContent();
  if (objects.length) appendRows_(tab, objects);
}

function addLog_(db, ctx, entries) {
  const rows = entries.map(function (e) {
    return {
      timestamp: ctx.now.timestamp, date: ctx.now.date, action: e.action, barcode: e.barcode, name: e.name,
      qty: e.qty, packet: e.packet || '', volunteer: ctx.volunteer, note: e.note || '', op: ctx.op,
    };
  });
  appendRows_(TABS.LOG, rows);
  rows.forEach(function (r) { db.log.push(r); });
}

function updatePacket_(packet, changes) {
  Object.assign(packet, changes);
  sheet_(TABS.PACKETS).getRange(packet.row, 1, 1, COLUMNS[TABS.PACKETS].length).setValues(toValues_(TABS.PACKETS, [packet]));
}

/* ---------- Derived tabs and app state ---------- */

function rebuildViews_(db) {
  const stock = computeStock_(db.log);
  const names = {};
  db.log.forEach(function (r) { if (r.barcode) names[r.barcode] = r.name; });
  db.products.forEach(function (p) { names[p.barcode] = p.name; });
  const categories = {};
  db.products.forEach(function (p) { categories[p.barcode] = p.category; });

  const stockRows = Object.keys(stock).map(function (code) {
    return Object.assign({ barcode: code, name: names[code], category: categories[code] || '' }, stock[code]);
  }).sort(function (a, b) { return String(a.name).localeCompare(String(b.name), SORT_LOCALE); });

  const days = {};
  const details = {};
  db.log.forEach(function (r) {
    if (!r.date || !r.barcode) return;
    const q = Number(r.qty) || 0;
    const day = days[r.date] || (days[r.date] = { date: r.date, received: 0, packed: 0, given: 0, packetNet: {}, handoutNet: {} });
    const key = r.date + '|' + r.barcode;
    const detail = details[key] || (details[key] = { date: r.date, barcode: r.barcode, name: names[r.barcode], received: 0, packed: 0, given: 0 });
    [day, detail].forEach(function (t) {
      if (r.action === ACTION.RECEIVED) t.received += q;
      else if (r.action === ACTION.PACKED) t.packed += q;
      else if (r.action === ACTION.UNPACKED) t.packed -= q;
      else if (r.action === ACTION.GIVEN_OUT) t.given += q;
    });
    if (r.action === ACTION.GIVEN_OUT && r.packet) day.packetNet[r.packet] = (day.packetNet[r.packet] || 0) + q;
    if (r.action === ACTION.GIVEN_OUT && r.op) {
      const handout = String(r.op).replace(/:undo$/, '');
      day.handoutNet[handout] = (day.handoutNet[handout] || 0) + q;
    }
  });

  const newestFirst = function (a, b) { return b.date < a.date ? -1 : b.date > a.date ? 1 : 0; };
  const dailyRows = Object.keys(days).map(function (d) {
    const day = days[d];
    day.packets = Object.keys(day.packetNet).filter(function (n) { return day.packetNet[n] > 0; }).length;
    day.handouts = Object.keys(day.handoutNet).filter(function (o) { return day.handoutNet[o] > 0; }).length;
    return day;
  }).filter(function (d) { return d.received || d.packed || d.given; }).sort(newestFirst);

  const detailRows = Object.keys(details).map(function (k) { return details[k]; })
    .filter(function (d) { return d.received || d.packed || d.given; })
    .sort(function (a, b) { return newestFirst(a, b) || String(a.name).localeCompare(String(b.name), SORT_LOCALE); });

  replaceTable_(TABS.STOCK, stockRows);
  replaceTable_(TABS.DAILY, dailyRows);
  replaceTable_(TABS.DETAIL, detailRows);
}

/** The sheet says a status in Russian. The app gets a fixed code and shows it in the volunteer's language. */
function apiStatus_(status) {
  return STATUS_CODES[status] || status;
}

function state_(db) {
  const stock = computeStock_(db.log);
  const contents = contentsByPacket_(db.log);
  return {
    sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
    products: db.products.map(function (p) {
      const s = stock[p.barcode] || { available: 0, packed: 0, given: 0 };
      return {
        barcode: p.barcode, name: p.name, category: p.category, description: p.description,
        available: s.available, packed: s.packed, given: s.given,
      };
    }),
    packetsOnShelf: db.packets
      .filter(function (p) { return p.status === PACKET.ON_SHELF; })
      .map(function (p) { return { number: Number(p.number), contents: p.contents, packedOn: p.packedOn }; })
      .sort(function (a, b) { return a.number - b.number; }),
    packets: db.packets.map(function (p) {
      return {
        number: Number(p.number), status: apiStatus_(p.status), contents: p.contents, givenOn: p.givenOn, givenBy: p.givenBy,
        items: p.status === PACKET.ON_SHELF ? contents[Number(p.number)] || [] : [],
      };
    }),
  };
}

/* ---------- Sheet menu and setup ---------- */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Банк еды')
    .addItem('Настроить таблицу', 'setupSheet')
    .addItem('Задать код доступа', 'setPasscode')
    .addItem('Обновить остатки и отчёты по дням', 'rebuildNow')
    .addToUi();
}

/** Keeps the Stock and Daily tabs right when someone corrects the Log or Products tab by hand. */
function onEdit(e) {
  const tab = e && e.range && e.range.getSheet().getName();
  if (tab === TABS.LOG || tab === TABS.PRODUCTS) rebuildViews_(load_());
}

function rebuildNow() {
  rebuildViews_(load_());
  SpreadsheetApp.getActiveSpreadsheet().toast('Остатки и отчёты по дням обновлены.');
}

function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(TABS).forEach(function (key) { ensureTab_(ss, TABS[key]); });

  BLANK_TAB_NAMES.forEach(function (name) {
    const blank = ss.getSheetByName(name);
    if (blank && blank.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(blank);
  });

  rebuildViews_(load_());
  if (!PropertiesService.getScriptProperties().getProperty('PASSCODE')) setPasscode();
  ss.toast('Таблица готова.');
}

function ensureTab_(ss, tab) {
  const cols = COLUMNS[tab];
  const sheet = ss.getSheetByName(tab) || ss.insertSheet(tab);
  const header = sheet.getRange(1, 1, 1, cols.length);
  header.setValues([cols.map(function (c) { return c[0]; })]);
  header.setFontWeight('bold');
  sheet.setFrozenRows(1);
  // Protects typed-in barcodes and dates from being turned into numbers.
  cols.forEach(function (col, i) {
    if (col[2] === TEXT) sheet.getRange(2, i + 1, sheet.getMaxRows() - 1, 1).setNumberFormat(TEXT);
  });
  return sheet;
}

function setPasscode() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.prompt('Код доступа', 'Волонтёры вводят его один раз на своём телефоне. Минимальная длина: ' + MIN_PASSCODE_LENGTH + ' символов.', ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return;
  const code = answer.getResponseText().trim();
  if (code.length < MIN_PASSCODE_LENGTH) {
    ui.alert('Код слишком короткий, поэтому ничего не изменилось.');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('PASSCODE', code);
  ui.alert('Код доступа сохранён.');
}
