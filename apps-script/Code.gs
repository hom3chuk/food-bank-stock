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
 * A correction on the Stock screen is a RECEIVED row for the difference, marked CORRECTION_NOTE.
 * Undo appends the same rows with a negative qty, so history is never erased.
 *
 * Money and people have their own ledgers (TABS.MONEY, TABS.PEOPLE), with no names in them. Their
 * first columns match the old paper-style table, so past data can be pasted straight in. Pasted
 * rows have no time or operation ID, and their dates and numbers may arrive as text, so those
 * tabs are read with parseDate_, parseMoney_ and parseAmount_. A row that can't be read is reported,
 * not guessed. A plain money amount is in RSD. Anything else, like "100 евро", is free text with its
 * own running total, because currencies are never converted.
 */

const TABS = {
  STOCK: 'Остатки',
  DAILY: 'По дням',
  DETAIL: 'По дням подробно',
  PACKETS: 'Пакеты',
  PRODUCTS: 'Продукты',
  LOG: 'Журнал',
  MONEY: 'Деньги',
  MONEY_DAILY: 'Деньги по дням',
  PEOPLE: 'Люди',
  PEOPLE_DAILY: 'Люди по дням',
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
  [TABS.MONEY]: [
    ['Сумма', 'amount', NUM], ['Дата', 'date', TEXT], ['Примечание', 'note', TEXT],
    ['Время записи', 'timestamp', TEXT], ['ID операции', 'op', TEXT],
  ],
  [TABS.MONEY_DAILY]: [
    ['Дата', 'date', TEXT], ['Пришло', 'moneyIn', NUM], ['Ушло', 'moneyOut', NUM],
    ['Итог за день', 'net', NUM], ['Остаток', 'balance', NUM],
  ],
  [TABS.PEOPLE]: [
    ['Принесли', 'brought', NUM], ['Взяли', 'took', NUM], ['Дата', 'date', TEXT],
    ['Время записи', 'timestamp', TEXT], ['ID операции', 'op', TEXT],
  ],
  [TABS.PEOPLE_DAILY]: [
    ['Дата', 'date', TEXT], ['Принесли', 'brought', NUM], ['Взяли', 'took', NUM],
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
const CORRECTION_NOTE = 'Исправление количества';
const UNKNOWN_VOLUNTEER = 'Неизвестно';
const SORT_LOCALE = 'ru';
const BLANK_TAB_NAMES = ['Sheet1', 'Лист1'];
const MAX_QTY = 100000;
const MAX_PACKETS_AT_ONCE = 500;
const MIN_PASSCODE_LENGTH = 6;
const MAX_AMOUNT = 100000000;
const MAX_PEOPLE_CHANGE = 1000;
const RECENT_MONEY_ROWS = 30;
const RSD_NAMES = ['rsd', 'рсд', 'din', 'дин', 'динар', 'динара', 'динаров', 'dinar', 'dinara'];

/*
 * Stock counts. Each count is a pair of tabs: Инвентаризация-N, where every saved scan is a row,
 * and Инвентаризация-N итоги, rebuilt from it. The start time sits in the count tab's header row,
 * to the right of the columns, so it can be corrected by hand.
 *
 * Work goes on during a count, so what a shelf should hold depends on when it was counted.
 * For each product, the expected number is what was available at the start, plus the Журнал
 * movements of available stock from the start until that product's last scan. A product that was
 * never scanned uses the count's last scan. Movements after that happened once the shelf was
 * already counted, so they are left out. Packets aren't counted, and packing, unpacking and
 * handing out only matter here as far as they change what's available.
 */
const COUNT_PREFIX = 'Инвентаризация-';
const RESULTS_SUFFIX = ' итоги';
const COUNT_TAB = /^Инвентаризация-(\d+)$/;
const RESULTS_TAB = /^Инвентаризация-(\d+) итоги$/;
const COUNT_COLUMNS = [
  ['Время подсчёта', 'scanned', TEXT], ['Штрихкод', 'barcode', TEXT], ['Продукт', 'name', TEXT],
  ['Кол-во', 'qty', NUM], ['Волонтёр', 'volunteer', TEXT], ['Время записи', 'timestamp', TEXT],
  ['ID операции', 'op', TEXT],
];
const RESULTS_COLUMNS = [
  ['Штрихкод', 'barcode', TEXT], ['Продукт', 'name', TEXT], ['Итог', 'verdict', TEXT],
  ['Разница', 'diff', NUM], ['Насчитано', 'counted', NUM], ['Ожидалось', 'expected', NUM],
  ['Было на начало', 'before', NUM], ['Изменения после начала', 'during', NUM],
];
const VERDICT = { MISSING: 'Не хватает', OVER: 'Излишек', OK: 'Сходится' };
// Info cells go one empty column to the right of the table, so they never mix with its rows.
const COUNT_START_CELL = COUNT_COLUMNS.length + 2;
const RESULTS_INFO_CELL = RESULTS_COLUMNS.length + 2;
const COUNT_START_LABEL = 'Начало';
// Closing writes these next to the start time: the label, when, and the operation ID for undo.
const COUNT_CLOSED_LABEL = 'Закрыта';
const MAX_COUNT_LINES = 500;
const TIME_FIELDS = ['timestamp', 'scanned'];
const TIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

function columnsFor_(tab) {
  if (COLUMNS[tab]) return COLUMNS[tab];
  if (COUNT_TAB.test(tab)) return COUNT_COLUMNS;
  if (RESULTS_TAB.test(tab)) return RESULTS_COLUMNS;
  throw new Error('No columns for tab ' + tab);
}

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
  const writes = {
    receive: receive_, pack: pack_, editPacket: editPacket_, handout: handout_, unpack: unpack_, undo: undo_,
    money: money_, people: people_, adjust: adjust_, countStart: countStart_, countSave: countSave_, countClose: countClose_,
  };
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
    if (ledgerHasOp_(db, op)) return { ok: true, replayed: true, opId: op, result: { action: 'LEDGER' }, state: state_(db) };

    const result = handler(req, db, { op: op, volunteer: cleanText_(req.volunteer, 60) || UNKNOWN_VOLUNTEER, now: now_() });
    // Counting a person should be quick, and it can't change the stock tabs. Nor can a stock
    // count, which rebuilds its own results.
    const stockCount = req.action === 'countStart' || req.action === 'countSave' || (req.action === 'undo' && isCountUndo_(req));
    if (req.action === 'money' || req.action === 'people') rebuildLedgerViews_(db);
    else if (!stockCount) rebuildViews_(db);
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

/** Sets how many are available. Checks the count the volunteer saw, in case someone else just changed it. */
function adjust_(req, db, ctx) {
  const code = normBarcode_(req.barcode);
  const product = findProduct_(db, code);
  if (!product) throw new ApiError('NOT_FOUND', 'notReceived', { code: code });
  const target = Number(req.available);
  if (!Number.isInteger(target) || target < 0 || target > MAX_QTY) throw new ApiError('BAD_REQUEST', 'badAmountOnHand');
  const current = (computeStock_(db.log)[code] || { available: 0 }).available;
  if (current !== Number(req.expected)) throw new ApiError('CONFLICT', 'stockChanged', { name: product.name, n: current });
  const change = target - current;
  if (change) addLog_(db, ctx, [{ action: ACTION.RECEIVED, barcode: code, name: product.name, qty: change, note: CORRECTION_NOTE }]);
  return { action: 'ADJUST', barcode: code, name: product.name, available: target };
}

function money_(req, db, ctx) {
  const money = parseMoney_(req.amount);
  // The RSD column shows whole numbers. Other currencies are saved as text, so cents are safe there.
  if (!money || money.amount === 0 || Math.abs(money.amount) > MAX_AMOUNT || (!money.currency && !Number.isInteger(money.amount))) {
    throw new ApiError('BAD_REQUEST', 'badAmount');
  }
  const date = entryDate_(req.date, ctx);
  addMoney_(db, ctx, { amount: money.amount, currency: money.currency, date: date, note: cleanText_(req.note, 200) });
  return { action: 'MONEY', amount: money.amount, currency: money.currency, date: date };
}

function people_(req, db, ctx) {
  const delta = Number(req.delta);
  const field = req.field === 'brought' || req.field === 'took' ? req.field : '';
  if (!field || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_PEOPLE_CHANGE) throw new ApiError('BAD_REQUEST', 'generic');
  const date = entryDate_(req.date, ctx);
  const day = peopleDays_(db.people.entries)[date] || { brought: 0, took: 0 };
  if (day[field] + delta < 0) throw new ApiError('CONFLICT', 'peopleBelowZero');

  const row = { brought: field === 'brought' ? delta : '', took: field === 'took' ? delta : '', date: sheetDate_(date), timestamp: ctx.now.timestamp, op: ctx.op };
  appendRows_(TABS.PEOPLE, [row]);
  db.people.entries.push({ brought: field === 'brought' ? delta : 0, took: field === 'took' ? delta : 0, date: date, op: ctx.op });
  return { action: 'PEOPLE', date: date };
}

function addMoney_(db, ctx, entry) {
  // The apostrophe keeps it as text. Sheets could otherwise read "20 $" as the number 20, which counts as RSD.
  const cell = entry.currency ? "'" + cleanText_(entry.amount + ' ' + entry.currency, 80).replace(/^'/, '') : entry.amount;
  appendRows_(TABS.MONEY, [{ amount: cell, date: sheetDate_(entry.date), note: entry.note, timestamp: ctx.now.timestamp, op: ctx.op }]);
  db.money.entries.push({ amount: entry.amount, currency: entry.currency, date: entry.date, note: entry.note, op: ctx.op });
}

function undoMoney_(db, ctx, target, rows) {
  const undoOp = target + ':undo';
  if (db.money.entries.some(function (r) { return r.op === undoOp; })) return { action: 'UNDO', alreadyUndone: true };
  // Keeps the original date, so that day's total comes out right in the report.
  rows.forEach(function (r) {
    addMoney_(db, Object.assign({}, ctx, { op: undoOp }), { amount: -r.amount, currency: r.currency, date: r.date, note: UNDO_NOTE + (r.note ? ': ' + r.note : '') });
  });
  return { action: 'UNDO' };
}

function ledgerHasOp_(db, op) {
  const same = function (r) { return r.op === op; };
  return db.money.entries.some(same) || db.people.entries.some(same);
}

function entryDate_(value, ctx) {
  if (value === undefined || value === null || value === '') return ctx.now.date;
  const date = parseDate_(value);
  // Dates in this format sort correctly as text.
  if (!date || date > ctx.now.date) throw new ApiError('BAD_REQUEST', 'badDate');
  return date;
}

function undo_(req, db, ctx) {
  if (isCountUndo_(req)) return undoCount_(req, db, ctx);
  const closed = countClosedBy_(String(req.targetOp || ''));
  if (closed) return undoCountClose_(db, ctx, closed, String(req.targetOp));
  const target = String(req.targetOp || '');
  const moneyRows = db.money.entries.filter(function (r) { return r.op === target; });
  if (moneyRows.length && target.indexOf(':undo') === -1) return undoMoney_(db, ctx, target, moneyRows);
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

/* ---------- Stock counts ---------- */

/**
 * Starts the next count. `after` is the newest count the phone knew of, so two volunteers
 * pressing Start at once get one new count, not two.
 */
function countStart_(req, db, ctx) {
  const latest = latestCount_();
  if (Number(req.after || 0) !== latest) return { action: 'COUNT_START', number: latest, already: true };
  const number = latest + 1;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ensureTab_(ss, countName_(number));
  sheet.getRange(1, COUNT_START_CELL, 1, 2).setNumberFormat(TEXT).setValues([[COUNT_START_LABEL, ctx.now.timestamp]]);
  ensureTab_(ss, countName_(number) + RESULTS_SUFFIX);
  const summary = rebuildCountResults_(db, number);
  return { action: 'COUNT_START', number: number, summary: brief_(summary) };
}

/** Adds one phone's list to a count. The same product saved again later simply adds up. */
function countSave_(req, db, ctx) {
  const number = requireCount_(req.number);
  const name = countName_(number);
  if (readCount_(number).entries.some(function (e) { return e.op === ctx.op; })) {
    return { action: 'COUNT_SAVE', number: number, replayed: true, summary: brief_(rebuildCountResults_(db, number)) };
  }
  requireOpen_(number);
  const list = Array.isArray(req.items) ? req.items : [];
  if (!list.length || list.length > MAX_COUNT_LINES) throw new ApiError('BAD_REQUEST', 'generic');
  const started = countStarted_(number);
  const merged = {};
  const order = [];
  list.forEach(function (item) {
    const code = normBarcode_(item.barcode);
    const known = findProduct_(db, code);
    if (!merged[code]) {
      // A barcode not in the sheet keeps the name the phone suggested, so the results can show it.
      merged[code] = { barcode: code, name: known ? known.name : cleanText_(item.name, 120), qty: 0, scanned: '' };
      order.push(code);
    }
    merged[code].qty += cleanQty_(item.qty);
    const at = scanTime_(item.at, started, ctx);
    if (at > merged[code].scanned) merged[code].scanned = at;
  });
  appendRows_(name, order.map(function (code) {
    return Object.assign({}, merged[code], { volunteer: ctx.volunteer, timestamp: ctx.now.timestamp, op: ctx.op });
  }));
  const units = order.reduce(function (sum, code) { return sum + merged[code].qty; }, 0);
  return { action: 'COUNT_SAVE', number: number, units: units, summary: brief_(rebuildCountResults_(db, number)) };
}

function isCountUndo_(req) {
  return req.count !== undefined && req.count !== null && req.count !== '';
}

/** Takes back one saved list. The rows keep their scan times, so the results come out as before. */
function undoCount_(req, db, ctx) {
  const number = requireCount_(req.count);
  const target = String(req.targetOp || '');
  const entries = readCount_(number).entries;
  const rows = entries.filter(function (e) { return e.op === target; });
  if (!target || !rows.length || target.indexOf(':undo') !== -1) throw new ApiError('NOT_FOUND', 'undoNotFound');
  const undoOp = target + ':undo';
  if (entries.some(function (e) { return e.op === undoOp; })) return { action: 'UNDO', alreadyUndone: true };
  requireOpen_(number);
  appendRows_(countName_(number), rows.map(function (r) {
    return { scanned: r.scanned, barcode: r.barcode, name: r.name, qty: -r.qty, volunteer: ctx.volunteer, timestamp: ctx.now.timestamp, op: undoOp };
  }));
  return { action: 'UNDO', number: number, summary: brief_(rebuildCountResults_(db, number)) };
}

function countName_(number) {
  return COUNT_PREFIX + number;
}

function countNumbers_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets()
    .map(function (s) { const match = COUNT_TAB.exec(s.getName()); return match ? Number(match[1]) : 0; })
    .filter(Boolean)
    .sort(function (a, b) { return a - b; });
}

function latestCount_() {
  const numbers = countNumbers_();
  return numbers.length ? numbers[numbers.length - 1] : 0;
}

function requireCount_(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || !SpreadsheetApp.getActiveSpreadsheet().getSheetByName(countName_(number))) {
    throw new ApiError('NOT_FOUND', 'countMissing', { n: value });
  }
  return number;
}

/** The start time from the count tab's header row, as yyyy-MM-dd HH:mm, or '' if it can't be read. */
function countStarted_(number) {
  return countInfo_(number).started;
}

/** What the count tab's header row says: when it started, and when it was closed and by which operation. */
function countInfo_(number) {
  const values = sheet_(countName_(number)).getRange(1, COUNT_START_CELL, 1, 5).getValues()[0];
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  const time = function (value) {
    const text = value instanceof Date ? Utilities.formatDate(value, tz, 'yyyy-MM-dd HH:mm') : String(value).trim();
    return TIME_PATTERN.test(text) ? text.slice(0, 16) : '';
  };
  const closed = String(values[2]).trim() === COUNT_CLOSED_LABEL ? time(values[3]) || 'closed' : '';
  return { started: time(values[1]), closed: closed, closeOp: closed ? String(values[4]).trim() : '' };
}

function requireOpen_(number) {
  if (countInfo_(number).closed) throw new ApiError('CONFLICT', 'countClosed', { n: number });
}

/**
 * Closes the newest count and makes stock match it. Overstock goes into Журнал as received and
 * shortages as given out, now, marked with the count's name. Each product moves by the difference
 * the count found, not to the counted number, because anything that moved after its shelf was
 * counted really happened and still counts.
 */
function countClose_(req, db, ctx) {
  const number = requireCount_(req.number);
  if (countInfo_(number).closed) return { action: 'COUNT_CLOSE', number: number, already: true };
  if (number !== latestCount_()) throw new ApiError('CONFLICT', 'countNotLatest', { n: number });

  const results = rebuildCountResults_(db, number);
  const note = countName_(number);
  const rows = [];
  results.rows.forEach(function (r) {
    if (!r.diff) return;
    if (!findProduct_(db, r.barcode)) {
      // Found on the shelf but never received. Stock needs a product to belong to.
      const product = { barcode: r.barcode, name: r.name || r.barcode, category: '', description: 'Найдено при инвентаризации: ' + note, firstSeen: ctx.now.date };
      db.products.push(product);
      appendRows_(TABS.PRODUCTS, [product]);
    }
    const name = findProduct_(db, r.barcode).name;
    rows.push(r.diff > 0
      ? { action: ACTION.RECEIVED, barcode: r.barcode, name: name, qty: r.diff, note: note }
      : { action: ACTION.GIVEN_OUT, barcode: r.barcode, name: name, qty: -r.diff, note: note });
  });
  if (rows.length) addLog_(db, ctx, rows);
  markClosed_(number, [COUNT_CLOSED_LABEL, ctx.now.timestamp, ctx.op]);
  const sum = function (action) {
    return rows.filter(function (r) { return r.action === action; }).reduce(function (n, r) { return n + r.qty; }, 0);
  };
  return { action: 'COUNT_CLOSE', number: number, products: rows.length, received: sum(ACTION.RECEIVED), given: sum(ACTION.GIVEN_OUT) };
}

function markClosed_(number, values) {
  sheet_(countName_(number)).getRange(1, COUNT_START_CELL + 2, 1, 3).setNumberFormat(TEXT).setValues([values]);
  const results = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(countName_(number) + RESULTS_SUFFIX);
  if (results) results.getRange(6, RESULTS_INFO_CELL, 1, 2).setNumberFormat(TEXT).setValues([[values[0] ? COUNT_CLOSED_LABEL : '', values[1]]]);
}

/** The newest count, if `op` is what closed it. Only the newest can be closed, so only it can be reopened. */
function countClosedBy_(op) {
  const number = latestCount_();
  return op && number && countInfo_(number).closeOp === op ? number : 0;
}

/** Takes the stock corrections back out and opens the count again, so more can be scanned. */
function undoCountClose_(db, ctx, number, target) {
  const undoOp = target + ':undo';
  const rows = db.log.filter(function (r) { return r.op === target; });
  if (rows.length && !db.log.some(function (r) { return r.op === undoOp; })) {
    addLog_(db, Object.assign({}, ctx, { op: undoOp }), rows.map(function (r) {
      return { action: r.action, barcode: r.barcode, name: r.name, qty: -Number(r.qty), note: UNDO_NOTE };
    }));
  }
  markClosed_(number, ['', '', '']);
  rebuildCountResults_(db, number);
  return { action: 'UNDO', number: number };
}

/** When the phone saw the item, kept between the count's start and now, in case its clock is off. */
function scanTime_(at, started, ctx) {
  const ms = Number(at);
  let time = ctx.now.timestamp;
  if (Number.isFinite(ms) && ms > 0) {
    time = Utilities.formatDate(new Date(ms), SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm');
  }
  if (time > ctx.now.timestamp) time = ctx.now.timestamp;
  if (started && time < started) time = started;
  return time;
}

/** Rows typed or pasted by hand are read too. Ones that can't be read are reported in the results. */
function readCount_(number) {
  const out = { entries: [], badRows: [] };
  readTable_(countName_(number)).forEach(function (r) {
    if (!r.barcode && r.qty === '') return;
    const qty = parseAmount_(r.qty);
    let code = '';
    try { code = normBarcode_(r.barcode); } catch (err) { code = ''; }
    if (!code || !Number.isInteger(qty)) {
      out.badRows.push(r.row);
      return;
    }
    const scanned = TIME_PATTERN.test(r.scanned) ? r.scanned.slice(0, 16) : TIME_PATTERN.test(r.timestamp) ? r.timestamp.slice(0, 16) : '';
    out.entries.push({ row: r.row, barcode: code, name: r.name, qty: qty, scanned: scanned, op: r.op });
  });
  return out;
}

/** How one Журнал row changes what's on the open shelves. */
function availableChange_(r) {
  const q = Number(r.qty) || 0;
  if (r.action === ACTION.RECEIVED || r.action === ACTION.UNPACKED) return q;
  if (r.action === ACTION.PACKED) return -q;
  if (r.action === ACTION.GIVEN_OUT && !r.packet) return -q;
  return 0;
}

/** Rebuilds a count's results tab and returns how many products are missing or overstocked. */
function rebuildCountResults_(db, number) {
  // A closed count has already changed stock. Its results stay as they were when it closed.
  const info = countInfo_(number);
  if (info.closed) return null;
  const started = info.started;
  const count = readCount_(number);
  const counted = {};
  const lastScan = {};
  const countNames = {};
  let countEnd = started;
  count.entries.forEach(function (e) {
    counted[e.barcode] = (counted[e.barcode] || 0) + e.qty;
    if (e.name) countNames[e.barcode] = e.name;
    const at = e.scanned || started;
    if (!lastScan[e.barcode] || at > lastScan[e.barcode]) lastScan[e.barcode] = at;
    if (at > countEnd) countEnd = at;
  });

  const before = {};
  const during = {};
  const logNames = {};
  db.log.forEach(function (r) {
    if (!r.barcode) return;
    logNames[r.barcode] = r.name;
    const change = availableChange_(r);
    if (!change) return;
    // A row typed into Журнал by hand may have no time. It counts from the start of its date.
    const at = TIME_PATTERN.test(r.timestamp) ? r.timestamp.slice(0, 16) : r.date ? r.date + ' 00:00' : '';
    if (at < started) before[r.barcode] = (before[r.barcode] || 0) + change;
    else if (at <= (lastScan[r.barcode] || countEnd)) during[r.barcode] = (during[r.barcode] || 0) + change;
  });

  const productNames = {};
  db.products.forEach(function (p) { productNames[p.barcode] = p.name; });
  const codes = {};
  [before, during, counted].forEach(function (m) { Object.keys(m).forEach(function (c) { codes[c] = true; }); });
  const rows = Object.keys(codes).map(function (code) {
    const expected = (before[code] || 0) + (during[code] || 0);
    const got = counted[code] || 0;
    const diff = got - expected;
    return {
      barcode: code, name: productNames[code] || countNames[code] || logNames[code] || '',
      verdict: diff < 0 ? VERDICT.MISSING : diff > 0 ? VERDICT.OVER : VERDICT.OK,
      diff: diff, counted: got, expected: expected, before: before[code] || 0, during: during[code] || 0,
    };
  }).filter(function (r) { return r.expected || r.counted; });

  // Biggest problems first: shortages, then overstock, then what matched.
  const rank = {};
  rank[VERDICT.MISSING] = 0; rank[VERDICT.OVER] = 1; rank[VERDICT.OK] = 2;
  rows.sort(function (a, b) {
    return rank[a.verdict] - rank[b.verdict] || Math.abs(b.diff) - Math.abs(a.diff) || String(a.name).localeCompare(String(b.name), SORT_LOCALE);
  });

  const summary = {
    missing: rows.filter(function (r) { return r.verdict === VERDICT.MISSING; }).length,
    over: rows.filter(function (r) { return r.verdict === VERDICT.OVER; }).length,
  };
  const resultsName = countName_(number) + RESULTS_SUFFIX;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(resultsName) || ensureTab_(ss, resultsName);
  replaceTable_(resultsName, rows);
  sheet.getRange(1, RESULTS_INFO_CELL, 5, 2).setNumberFormat(TEXT).setValues([
    ['Начало', started || 'не читается: проверьте ячейку «' + COUNT_START_LABEL + '» во вкладке ' + countName_(number)],
    ['Последний подсчёт', countEnd],
    ['Не хватает, позиций', String(summary.missing)],
    ['Излишек, позиций', String(summary.over)],
    ['Нечитаемые строки', count.badRows.join(', ')],
  ]);
  return { missing: summary.missing, over: summary.over, rows: rows };
}

/** Just the numbers, for the phone. */
function brief_(results) {
  return results ? { missing: results.missing, over: results.over } : null;
}

function latestCountState_() {
  const number = latestCount_();
  if (!number) return null;
  const results = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(countName_(number) + RESULTS_SUFFIX);
  const info = countInfo_(number);
  return { number: number, started: info.started, closed: info.closed, resultsGid: results ? results.getSheetId() : null };
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

/* ---------- Reading pasted data ---------- */

/** Reads a date cell as yyyy-MM-dd, or returns '' if it isn't a real date. Day comes first: 04.11.2026, 2.11.26. */
function parseDate_(value) {
  const text = String(value === undefined || value === null ? '' : value).trim();
  let y, m, d;
  let parts = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (parts) {
    y = Number(parts[1]); m = Number(parts[2]); d = Number(parts[3]);
  } else {
    parts = text.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4}|\d{2})$/);
    if (!parts) return '';
    d = Number(parts[1]); m = Number(parts[2]); y = Number(parts[3]);
    if (parts[3].length === 2) y += 2000;
  }
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return '';
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

/** The form dates take in the sheet, matching the old table. */
function sheetDate_(date) {
  const parts = date.split('-');
  return parts[2] + '.' + parts[1] + '.' + parts[0];
}

/** Reads a number cell, or returns null. A comma before three digits could mean thousands, so it counts as unreadable. */
function parseAmount_(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value === undefined || value === null ? '' : value).replace(/\s/g, '').replace(/\u2212/g, '-');
  if (!/^[+-]?\d+([.,]\d{1,2})?$/.test(text)) return null;
  return Number(text.replace(',', '.'));
}

/**
 * Reads a money cell as { amount, currency }, with currency '' for RSD. Accepts 6000, 100 евро and €100.
 * Returns null if there isn't exactly one clear number, such as "100 евро и 50 долларов" or "5,000".
 */
function parseMoney_(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? { amount: value, currency: '' } : null;
  const text = String(value === undefined || value === null ? '' : value).replace(/\u2212/g, '-').trim();
  const plain = parseAmount_(text);
  if (plain !== null) return { amount: plain, currency: '' };

  const number = '(\\d[\\d\\s]*(?:[.,]\\d{1,2})?)';
  const after = text.match(new RegExp('^([+-]?)\\s*' + number + '\\s*([^\\d]+)$'));
  const before = after ? null : text.match(new RegExp('^([+-]?)\\s*([^\\d+-][^\\d]*?)\\s*' + number + '$'));
  if (!after && !before) return null;
  const digits = after ? after[2] : before[3];
  const label = (after ? after[3] : before[2]).trim();
  if (!/[\p{L}\p{Sc}]/u.test(label)) return null;

  const amount = parseAmount_((after || before)[1] + digits);
  if (amount === null) return null;
  const isRsd = RSD_NAMES.indexOf(label.toLowerCase().replace(/\.$/, '')) !== -1;
  return { amount: amount, currency: isRsd ? '' : label };
}

/** Adds to a running total per currency. "ЕВРО" and "евро" are one currency, shown as first written. */
function addToTotals_(totals, currency, amount) {
  const key = String(currency).toLowerCase();
  const total = totals[key] || (totals[key] = { currency: currency, amount: 0 });
  total.amount = roundMoney_(total.amount + amount);
}

/** The other currencies with money in them, as a list. */
function otherCurrencies_(totals) {
  return Object.keys(totals).filter(function (key) { return key && totals[key].amount; })
    .sort(function (a, b) { return a.localeCompare(b, SORT_LOCALE); })
    .map(function (key) { return totals[key]; });
}

/** How a total reads in the sheet: 10000, or 10000 (100 евро) when other currencies are involved. */
function moneyLine_(totals) {
  const rsd = totals[''] ? totals[''].amount : 0;
  const others = otherCurrencies_(totals).map(function (t) { return t.amount + ' ' + t.currency; });
  return others.length ? cleanText_(rsd + ' (' + others.join(', ') + ')', 200) : rsd;
}

function readMoney_() {
  const out = { entries: [], badRows: [] };
  readTable_(TABS.MONEY).forEach(function (r) {
    if (r.amount === '' && !r.date && !r.note) return;
    const money = parseMoney_(r.amount);
    const date = parseDate_(r.date);
    if (!money || !date) out.badRows.push(r.row);
    else out.entries.push({ row: r.row, amount: money.amount, currency: money.currency, date: date, note: r.note, op: r.op });
  });
  return out;
}

function readPeople_() {
  const out = { entries: [], badRows: [] };
  readTable_(TABS.PEOPLE).forEach(function (r) {
    if (r.brought === '' && r.took === '' && !r.date) return;
    // The old table leaves a count empty when it was zero.
    const brought = r.brought === '' ? 0 : parseAmount_(r.brought);
    const took = r.took === '' ? 0 : parseAmount_(r.took);
    const date = parseDate_(r.date);
    if (!Number.isInteger(brought) || !Number.isInteger(took) || !date) out.badRows.push(r.row);
    else out.entries.push({ row: r.row, brought: brought, took: took, date: date, op: r.op });
  });
  return out;
}

function peopleDays_(entries) {
  const days = {};
  entries.forEach(function (r) {
    const day = days[r.date] || (days[r.date] = { date: r.date, brought: 0, took: 0 });
    day.brought += r.brought;
    day.took += r.took;
  });
  return days;
}

function newestFirst_(a, b) {
  return b.date < a.date ? -1 : b.date > a.date ? 1 : 0;
}

/** Adding cents can leave tiny errors like 0.30000000000000004. */
function roundMoney_(n) {
  return Math.round(n * 100) / 100;
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
  const cols = columnsFor_(tab);
  const last = sheet.getLastRow();
  if (last < 2) return [];
  const tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return sheet.getRange(2, 1, last - 1, cols.length).getValues().map(function (values, i) {
    const row = { row: i + 2 };
    cols.forEach(function (col, c) {
      const v = values[c];
      // A time typed by hand can turn into a real date. Times are compared as text, so keep the minutes.
      if (v instanceof Date) row[col[1]] = Utilities.formatDate(v, tz, TIME_FIELDS.indexOf(col[1]) !== -1 ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
      else row[col[1]] = col[2] === TEXT ? String(v).trim() : v;
    });
    return row;
  });
}

function load_() {
  // A sheet set up before these tabs existed gets them here, so updating the script can't break the app.
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  [TABS.MONEY, TABS.MONEY_DAILY, TABS.PEOPLE, TABS.PEOPLE_DAILY].forEach(function (tab) {
    if (!ss.getSheetByName(tab)) ensureTab_(ss, tab);
  });
  return {
    products: readTable_(TABS.PRODUCTS), log: readTable_(TABS.LOG), packets: readTable_(TABS.PACKETS),
    money: readMoney_(), people: readPeople_(),
  };
}

function toValues_(tab, objects) {
  return objects.map(function (o) {
    return columnsFor_(tab).map(function (col) { return o[col[1]] === undefined || o[col[1]] === null ? '' : o[col[1]]; });
  });
}

function formatsFor_(tab, count) {
  const formats = columnsFor_(tab).map(function (col) { return col[2]; });
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
  const range = sheet.getRange(start, 1, objects.length, columnsFor_(tab).length);
  range.setNumberFormats(formatsFor_(tab, objects.length)); // Keeps leading zeros and text dates intact.
  range.setValues(toValues_(tab, objects));
  return start;
}

function replaceTable_(tab, objects) {
  const sheet = sheet_(tab);
  const width = columnsFor_(tab).length;
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
    // A shortage written off by closing a stock count went to nobody, so it isn't a handout.
    if (r.action === ACTION.GIVEN_OUT && r.op && String(r.note).indexOf(COUNT_PREFIX) !== 0) {
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
  rebuildLedgerViews_(db);
}

function rebuildLedgerViews_(db) {
  const moneyDays = {};
  db.money.entries.forEach(function (r) {
    const day = moneyDays[r.date] || (moneyDays[r.date] = { moneyIn: {}, moneyOut: {}, net: {} });
    addToTotals_(r.amount > 0 ? day.moneyIn : day.moneyOut, r.currency, Math.abs(r.amount));
    addToTotals_(day.net, r.currency, r.amount);
  });
  // The balance builds up from the oldest day, and the newest day is shown first.
  const balance = {};
  const moneyRows = Object.keys(moneyDays).sort().map(function (date) {
    const day = moneyDays[date];
    Object.keys(day.net).forEach(function (key) { addToTotals_(balance, day.net[key].currency, day.net[key].amount); });
    return {
      date: sheetDate_(date), moneyIn: moneyLine_(day.moneyIn), moneyOut: moneyLine_(day.moneyOut),
      net: moneyLine_(day.net), balance: moneyLine_(balance),
    };
  }).reverse();

  const peopleTotals = peopleDays_(db.people.entries);
  const peopleRows = Object.keys(peopleTotals).sort().reverse().map(function (date) {
    const day = peopleTotals[date];
    return { date: sheetDate_(date), brought: day.brought, took: day.took };
  });

  replaceTable_(TABS.MONEY_DAILY, moneyRows);
  replaceTable_(TABS.PEOPLE_DAILY, peopleRows);
}

/** The sheet says a status in Russian. The app gets a fixed code and shows it in the volunteer's language. */
function apiStatus_(status) {
  return STATUS_CODES[status] || status;
}

function moneyState_(money) {
  const undone = {};
  money.entries.forEach(function (r) {
    if (String(r.op).indexOf(':undo') !== -1) {
      undone[r.op] = true;
      undone[String(r.op).replace(/:undo$/, '')] = true;
    }
  });
  // Rows keep the order they were added, so a later row on the same date is the newer one.
  const recent = money.entries.map(function (r, i) { return { amount: r.amount, currency: r.currency, date: r.date, note: r.note, op: r.op, order: i }; })
    .filter(function (r) { return !r.op || !undone[r.op]; })
    .sort(function (a, b) { return newestFirst_(a, b) || b.order - a.order; })
    .slice(0, RECENT_MONEY_ROWS)
    .map(function (r) { return { amount: r.amount, currency: r.currency, date: r.date, note: r.note }; });
  const totals = {};
  money.entries.forEach(function (r) { addToTotals_(totals, r.currency, r.amount); });
  return {
    balance: totals[''] ? totals[''].amount : 0,
    otherBalances: otherCurrencies_(totals),
    recent: recent,
    badRows: money.badRows,
  };
}

function peopleState_(people) {
  const days = peopleDays_(people.entries);
  return {
    days: Object.keys(days).map(function (d) { return days[d]; }).sort(newestFirst_),
    badRows: people.badRows,
  };
}

function state_(db) {
  const stock = computeStock_(db.log);
  const contents = contentsByPacket_(db.log);
  return {
    sheetUrl: SpreadsheetApp.getActiveSpreadsheet().getUrl(),
    today: now_().date,
    count: latestCountState_(),
    money: moneyState_(db.money),
    people: peopleState_(db.people),
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
  const count = COUNT_TAB.exec(tab || '');
  if (tab === TABS.LOG || tab === TABS.PRODUCTS) {
    const db = load_();
    rebuildViews_(db);
    rebuildLatestCount_(db);
  }
  // Pasting old data counts as an edit, so the daily tabs update straight away.
  if (tab === TABS.MONEY || tab === TABS.PEOPLE) rebuildLedgerViews_(load_());
  if (count) rebuildCountResults_(load_(), Number(count[1]));
}

function rebuildNow() {
  const db = load_();
  rebuildViews_(db);
  rebuildLatestCount_(db);
  SpreadsheetApp.getActiveSpreadsheet().toast('Остатки и отчёты по дням обновлены.');
}

/** A fix in Журнал can change what the latest count expected. Older counts are left as they were. */
function rebuildLatestCount_(db) {
  const number = latestCount_();
  if (number) rebuildCountResults_(db, number);
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
  const cols = columnsFor_(tab);
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
