'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createBackend } = require('./fake-gas');

let seq = 0;
const op = () => `testop${String(++seq).padStart(6, '0')}`;
const BEANS = '5012345678900';
const RICE = '5098765432109';

function seeded(date) {
  const b = createBackend({ date });
  b.call('receive', { opId: op(), barcode: BEANS, qty: 10, product: { name: 'Beans', category: 'Tinned food' } });
  b.call('receive', { opId: op(), barcode: RICE, qty: 6, product: { name: 'Rice' } });
  return b;
}

const stockOf = (reply, code) => reply.state.products.find((p) => p.barcode === code);

test('creates all tabs and removes the blank one', () => {
  const b = createBackend();
  assert.deepEqual(b.tabs().sort(), ['Деньги', 'Деньги по дням', 'Журнал', 'Люди', 'Люди по дням', 'Остатки', 'Пакеты', 'По дням', 'По дням подробно', 'Продукты']);
});

test('the sheet is in Russian, and the app still gets fixed status codes', () => {
  const b = seeded();
  const packed = b.call('pack', { opId: op(), items: [{ barcode: BEANS, qty: 1 }] });
  assert.equal(packed.state.packets[0].status, 'On shelf');
  b.call('handout', { opId: op(), packets: [1] });
  const conflict = b.call('handout', { opId: op(), packets: [1] });
  assert.equal(conflict.params.status, 'Given out');
  assert.equal(b.call('bootstrap').state.packets[0].status, 'Given out');

  assert.equal(b.tab('Пакеты').rows()[0]['Статус'], 'Выдан');
  assert.deepEqual(
    [...new Set(b.tab('Журнал').rows().map((r) => r['Действие']))].sort(),
    ['Выдано', 'Получено', 'Упаковано'],
  );
  const everything = b.tabs().flatMap((name) => b.tab(name).rows()).map((row) => Object.keys(row).join(' ')).join(' ');
  assert.doesNotMatch(everything.replace(/ID/g, ''), /[A-Za-z]/);
});

test('notes and contents in the sheet are in Russian', () => {
  const b = seeded();
  b.call('pack', { opId: op(), count: 2, items: [{ barcode: BEANS, qty: 2 }, { barcode: RICE, qty: 1 }] });
  const edit = b.call('editPacket', { opId: op(), number: 2, items: [{ barcode: BEANS, qty: 1 }, { barcode: RICE, qty: 1 }] });
  b.call('undo', { opId: op(), targetOp: edit.opId });
  b.call('handout', { opId: op(), packets: [1], removals: [{ packet: 1, barcode: RICE, qty: 1 }] });
  const notes = new Set(b.tab('Журнал').rows().map((r) => r['Примечание']).filter(Boolean));
  assert.deepEqual([...notes].sort(), ['Возвращено', 'Изменено', 'Отмена']);
  assert.equal(b.tab('Пакеты').rows()[0]['Содержимое'], '2 × Beans (возвращено: 1 × Rice)');
  const nameless = b.context.doPost({ postData: { contents: JSON.stringify({ action: 'receive', passcode: 'test-passcode', opId: op(), barcode: BEANS, qty: 1 }) } });
  assert.equal(JSON.parse(nameless.text).ok, true);
  assert.equal(b.tab('Журнал').rows().at(-1)['Волонтёр'], 'Неизвестно');
});

test('setup removes the blank first tab on a Russian Google account too', () => {
  const b = createBackend({ blankName: 'Лист1' });
  assert.equal(b.tabs().includes('Лист1'), false);
  assert.equal(b.tabs().length, 10);
});

test('the script only asks for access to its own spreadsheet', () => {
  const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  assert.match(code, /^\/\*\*[^/]*@OnlyCurrentDoc[^/]*\*\//);
  assert.doesNotMatch(code, /\b(openById|openByUrl|DriveApp|UrlFetchApp|GmailApp|MailApp)\b/);
});

test('rejects a wrong passcode and writes nothing', () => {
  const b = createBackend();
  const reply = b.call('receive', { opId: op(), barcode: BEANS, qty: 1, product: { name: 'x' } }, 'wrong');
  assert.equal(reply.code, 'BAD_PASSCODE');
  assert.equal(b.tab('Журнал').rows().length, 0);
});

test('a new barcode needs a name, then a known barcode only needs a quantity', () => {
  const b = createBackend();
  assert.equal(b.call('receive', { opId: op(), barcode: BEANS, qty: 2 }).code, 'UNKNOWN_PRODUCT');
  b.call('receive', { opId: op(), barcode: BEANS, qty: 2, product: { name: 'Beans' } });
  const reply = b.call('receive', { opId: op(), barcode: BEANS, qty: 3 });
  assert.equal(stockOf(reply, BEANS).available, 5);
  assert.equal(b.tab('Продукты').rows().length, 1);
});

test('items move through available, packed and given out', () => {
  const b = seeded();
  const packed = b.call('pack', { opId: op(), count: 2, items: [{ barcode: BEANS, qty: 2 }, { barcode: RICE, qty: 1 }] });
  assert.deepEqual(packed.result.numbers, [1, 2]);
  assert.deepEqual(
    { a: stockOf(packed, BEANS).available, p: stockOf(packed, BEANS).packed, g: stockOf(packed, BEANS).given },
    { a: 6, p: 4, g: 0 },
  );

  const given = b.call('handout', { opId: op(), packets: [1] });
  assert.deepEqual(
    { a: stockOf(given, BEANS).available, p: stockOf(given, BEANS).packed, g: stockOf(given, BEANS).given },
    { a: 6, p: 2, g: 2 },
  );
  assert.equal(stockOf(given, RICE).given, 1);
  assert.deepEqual(given.state.packetsOnShelf.map((p) => p.number), [2]);

  const row = b.tab('Остатки').rows().find((r) => r['Штрихкод'] === BEANS);
  assert.equal(row['В наличии'], 6);
  assert.equal(row['Упаковано'], 2);
  assert.equal(row['Выдано'], 2);
  assert.equal(row['Всего получено'], 10);
});

test('a packet cannot be given out twice', () => {
  const b = seeded(() => new Date('2026-11-05T10:00:00Z'));
  b.call('pack', { opId: op(), items: [{ barcode: BEANS, qty: 1 }] });
  b.call('handout', { opId: op(), packets: [1] });
  const again = b.call('handout', { opId: op(), packets: [1] });
  assert.equal(again.code, 'CONFLICT');
  assert.equal(again.key, 'packetStatus');
  assert.equal(again.params.givenOn, '2026-11-05');
  assert.equal(again.params.givenBy, 'Sam');
  assert.equal(stockOf(b.call('bootstrap'), BEANS).given, 1);
});

test('asking for more than is available warns, and force overrides', () => {
  const b = seeded();
  const short = b.call('pack', { opId: op(), count: 3, items: [{ barcode: BEANS, qty: 4 }] });
  assert.equal(short.code, 'INSUFFICIENT');
  assert.deepEqual(short.shortages[0], { barcode: BEANS, name: 'Beans', needed: 12, available: 10 });
  assert.equal(b.tab('Пакеты').rows().length, 0);

  const forced = b.call('pack', { opId: op(), count: 3, items: [{ barcode: BEANS, qty: 4 }], force: true });
  assert.equal(stockOf(forced, BEANS).available, -2);
});

test('a retry with the same operation ID does not count twice', () => {
  const b = seeded();
  const id = op();
  b.call('receive', { opId: id, barcode: BEANS, qty: 5 });
  const retry = b.call('receive', { opId: id, barcode: BEANS, qty: 5 });
  assert.equal(retry.replayed, true);
  assert.equal(stockOf(retry, BEANS).available, 15);

  const packId = op();
  const first = b.call('pack', { opId: packId, count: 2, items: [{ barcode: RICE, qty: 1 }] });
  const second = b.call('pack', { opId: packId, count: 2, items: [{ barcode: RICE, qty: 1 }] });
  assert.deepEqual(second.result.numbers, first.result.numbers);
  assert.equal(b.tab('Пакеты').rows().length, 2);
});

test('undo reverses each kind of action and keeps the history', () => {
  const b = seeded();
  const received = b.call('receive', { opId: op(), barcode: BEANS, qty: 4 });
  assert.equal(stockOf(b.call('undo', { opId: op(), targetOp: received.opId }), BEANS).available, 10);

  const packed = b.call('pack', { opId: op(), items: [{ barcode: BEANS, qty: 3 }] });
  const given = b.call('handout', { opId: op(), packets: [1] });
  const undoneGive = b.call('undo', { opId: op(), targetOp: given.opId });
  assert.equal(stockOf(undoneGive, BEANS).packed, 3);
  assert.equal(stockOf(undoneGive, BEANS).given, 0);
  assert.equal(undoneGive.state.packetsOnShelf.length, 1);
  assert.equal(b.tab('Пакеты').rows()[0]['Дата выдачи'], '');

  const undonePack = b.call('undo', { opId: op(), targetOp: packed.opId });
  assert.equal(stockOf(undonePack, BEANS).available, 10);
  assert.equal(b.tab('Пакеты').rows()[0]['Статус'], 'Отменён');
  assert.equal(b.call('pack', { opId: op(), items: [{ barcode: BEANS, qty: 1 }] }).result.numbers[0], 2);

  const before = b.tab('Журнал').rows().length;
  const again = b.call('undo', { opId: op(), targetOp: received.opId });
  assert.equal(again.result.alreadyUndone, true);
  assert.equal(b.tab('Журнал').rows().length, before);
  assert.equal(b.tab('Журнал').rows().some((r) => r['Кол-во'] < 0), true);
});

test('undoing a pack is refused once one of its packets has gone out', () => {
  const b = seeded();
  const packed = b.call('pack', { opId: op(), count: 2, items: [{ barcode: BEANS, qty: 1 }] });
  b.call('handout', { opId: op(), packets: [2] });
  const reply = b.call('undo', { opId: op(), targetOp: packed.opId });
  assert.equal(reply.code, 'CONFLICT');
  assert.equal(b.tab('Пакеты').rows()[0]['Статус'], 'На полке');
});

test('unpack returns items to available', () => {
  const b = seeded();
  b.call('pack', { opId: op(), items: [{ barcode: BEANS, qty: 3 }] });
  const reply = b.call('unpack', { opId: op(), number: 1 });
  assert.equal(stockOf(reply, BEANS).available, 10);
  assert.equal(stockOf(reply, BEANS).packed, 0);
  assert.equal(b.call('handout', { opId: op(), packets: [1] }).code, 'CONFLICT');
});

test('items from the shelves come from available and leave packets alone', () => {
  const b = seeded();
  b.call('pack', { opId: op(), items: [{ barcode: BEANS, qty: 2 }] });
  const reply = b.call('handout', { opId: op(), items: [{ barcode: BEANS, qty: 3 }] });
  assert.deepEqual(
    { a: stockOf(reply, BEANS).available, p: stockOf(reply, BEANS).packed, g: stockOf(reply, BEANS).given },
    { a: 5, p: 2, g: 3 },
  );
});

test('one handout can mix packets and items from the shelves', () => {
  const b = seeded();
  b.call('pack', { opId: op(), count: 2, items: [{ barcode: BEANS, qty: 2 }] });
  const reply = b.call('handout', { opId: op(), packets: [1, 2], items: [{ barcode: BEANS, qty: 1 }, { barcode: RICE, qty: 2 }] });
  assert.deepEqual(
    { a: stockOf(reply, BEANS).available, p: stockOf(reply, BEANS).packed, g: stockOf(reply, BEANS).given },
    { a: 5, p: 0, g: 5 },
  );
  assert.equal(stockOf(reply, RICE).given, 2);
  assert.equal(reply.state.packetsOnShelf.length, 0);
  assert.equal(b.tab('По дням').rows()[0]['Выдач'], 1);
  assert.equal(b.tab('По дням').rows()[0]['Пакетов выдано'], 2);

  const undone = b.call('undo', { opId: op(), targetOp: reply.opId });
  assert.deepEqual(
    { a: stockOf(undone, BEANS).available, p: stockOf(undone, BEANS).packed, g: stockOf(undone, BEANS).given },
    { a: 6, p: 4, g: 0 },
  );
  assert.equal(undone.state.packetsOnShelf.length, 2);
  assert.equal(b.tab('По дням').rows()[0]['Выдач'], 0);
});

test('a handout is all or nothing when a packet has already gone', () => {
  const b = seeded();
  b.call('pack', { opId: op(), count: 2, items: [{ barcode: BEANS, qty: 1 }] });
  b.call('handout', { opId: op(), packets: [2] });
  const logBefore = b.tab('Журнал').rows().length;
  const reply = b.call('handout', { opId: op(), packets: [1, 2], items: [{ barcode: RICE, qty: 1 }] });
  assert.equal(reply.code, 'CONFLICT');
  assert.equal(b.tab('Журнал').rows().length, logBefore);
  assert.equal(b.tab('Пакеты').rows()[0]['Статус'], 'На полке');
});

test('a short shelf item blocks the whole handout until confirmed', () => {
  const b = seeded();
  b.call('pack', { opId: op(), items: [{ barcode: BEANS, qty: 1 }] });
  const id = op();
  const short = b.call('handout', { opId: id, packets: [1], items: [{ barcode: RICE, qty: 7 }] });
  assert.equal(short.code, 'INSUFFICIENT');
  assert.equal(b.tab('Пакеты').rows()[0]['Статус'], 'На полке');
  const forced = b.call('handout', { opId: id, packets: [1], items: [{ barcode: RICE, qty: 7 }], force: true });
  assert.equal(stockOf(forced, RICE).available, -1);
  assert.equal(b.tab('Пакеты').rows()[0]['Статус'], 'Выдан');
});

test('an item taken out of a packet goes back to available', () => {
  const b = seeded();
  b.call('pack', { opId: op(), count: 2, items: [{ barcode: BEANS, qty: 2 }, { barcode: RICE, qty: 1 }] });
  const reply = b.call('handout', { opId: op(), packets: [1], removals: [{ packet: 1, barcode: BEANS, qty: 1 }] });
  assert.deepEqual(
    { a: stockOf(reply, BEANS).available, p: stockOf(reply, BEANS).packed, g: stockOf(reply, BEANS).given },
    { a: 7, p: 2, g: 1 },
  );
  assert.equal(stockOf(reply, RICE).given, 1);
  const packet = b.tab('Пакеты').rows()[0];
  assert.equal(packet['Статус'], 'Выдан');
  assert.equal(packet['Содержимое'], '1 × Beans; 1 × Rice (возвращено: 1 × Beans)');
  assert.equal(b.tab('Пакеты').rows()[1]['Содержимое'], '2 × Beans; 1 × Rice');
  const daily = b.tab('По дням').rows()[0];
  assert.equal(daily['Выдано'], 2);
  assert.equal(daily['Упаковано'], 5);
});

test('undo puts a handed-back item back in its packet', () => {
  const b = seeded();
  b.call('pack', { opId: op(), items: [{ barcode: BEANS, qty: 2 }, { barcode: RICE, qty: 1 }] });
  const given = b.call('handout', { opId: op(), packets: [1], removals: [{ packet: 1, barcode: RICE, qty: 1 }] });
  const undone = b.call('undo', { opId: op(), targetOp: given.opId });
  assert.deepEqual(
    { a: stockOf(undone, RICE).available, p: stockOf(undone, RICE).packed, g: stockOf(undone, RICE).given },
    { a: 5, p: 1, g: 0 },
  );
  const packet = b.tab('Пакеты').rows()[0];
  assert.equal(packet['Статус'], 'На полке');
  assert.equal(packet['Содержимое'], '2 × Beans; 1 × Rice');
  assert.equal(undone.state.packets[0].items.length, 2);

  const again = b.call('handout', { opId: op(), packets: [1] });
  assert.equal(stockOf(again, RICE).given, 1);
  assert.equal(stockOf(again, BEANS).given, 2);
});

test('a retried handout does not hand items back twice', () => {
  const b = seeded();
  b.call('pack', { opId: op(), items: [{ barcode: BEANS, qty: 2 }, { barcode: RICE, qty: 1 }] });
  const id = op();
  const body = { opId: id, packets: [1], removals: [{ packet: 1, barcode: BEANS, qty: 1 }] };
  b.call('handout', body);
  const retry = b.call('handout', body);
  assert.equal(retry.replayed, true);
  assert.equal(stockOf(retry, BEANS).available, 9);
});

test('impossible removals are refused and write nothing', () => {
  const b = seeded();
  b.call('pack', { opId: op(), count: 2, items: [{ barcode: BEANS, qty: 2 }] });
  const before = b.tab('Журнал').rows().length;
  const tryRemove = (packets, removals) => b.call('handout', { opId: op(), packets, removals }).code;
  assert.equal(tryRemove([1], [{ packet: 1, barcode: BEANS, qty: 3 }]), 'BAD_REQUEST');
  assert.equal(tryRemove([1], [{ packet: 1, barcode: BEANS, qty: 2 }]), 'BAD_REQUEST');
  assert.equal(tryRemove([1], [{ packet: 1, barcode: RICE, qty: 1 }]), 'BAD_REQUEST');
  assert.equal(tryRemove([1], [{ packet: 2, barcode: BEANS, qty: 1 }]), 'BAD_REQUEST');
  assert.equal(tryRemove([1], [{ packet: 1, barcode: BEANS, qty: 0 }]), 'BAD_REQUEST');
  assert.equal(b.tab('Журнал').rows().length, before);
  assert.equal(b.tab('Пакеты').rows()[0]['Статус'], 'На полке');
});

test('editing a packet on the shelf moves only the differences', () => {
  const b = seeded();
  b.call('pack', { opId: op(), count: 2, items: [{ barcode: BEANS, qty: 2 }, { barcode: RICE, qty: 1 }] });
  const reply = b.call('editPacket', { opId: op(), number: 1, items: [{ barcode: BEANS, qty: 3 }] });
  assert.equal(reply.ok, true);
  assert.deepEqual(
    { a: stockOf(reply, BEANS).available, p: stockOf(reply, BEANS).packed },
    { a: 5, p: 5 },
  );
  assert.deepEqual(
    { a: stockOf(reply, RICE).available, p: stockOf(reply, RICE).packed },
    { a: 5, p: 1 },
  );
  const rows = b.tab('Пакеты').rows();
  assert.equal(rows[0]['Содержимое'], '3 × Beans');
  assert.equal(rows[0]['Статус'], 'На полке');
  assert.equal(rows[1]['Содержимое'], '2 × Beans; 1 × Rice');
  assert.deepEqual(reply.state.packets[0].items.map((i) => i.qty), [3]);

  // Giving it out uses the new contents.
  const given = b.call('handout', { opId: op(), packets: [1] });
  assert.equal(stockOf(given, BEANS).given, 3);
  assert.equal(stockOf(given, RICE).given, 0);
  assert.equal(stockOf(given, BEANS).packed, 2);
});

test('undoing an edit restores the packet and the stock', () => {
  const b = seeded();
  b.call('pack', { opId: op(), items: [{ barcode: BEANS, qty: 2 }] });
  const edit = b.call('editPacket', { opId: op(), number: 1, items: [{ barcode: RICE, qty: 1 }] });
  const undone = b.call('undo', { opId: op(), targetOp: edit.opId });
  assert.deepEqual(
    { a: stockOf(undone, BEANS).available, p: stockOf(undone, BEANS).packed },
    { a: 8, p: 2 },
  );
  assert.deepEqual(
    { a: stockOf(undone, RICE).available, p: stockOf(undone, RICE).packed },
    { a: 6, p: 0 },
  );
  const row = b.tab('Пакеты').rows()[0];
  assert.equal(row['Статус'], 'На полке');
  assert.equal(row['Содержимое'], '2 × Beans');
});

test('adding to a packet checks availability, but only for the extra', () => {
  const b = seeded();
  b.call('pack', { opId: op(), items: [{ barcode: RICE, qty: 5 }] });
  const id = op();
  const short = b.call('editPacket', { opId: id, number: 1, items: [{ barcode: RICE, qty: 7 }] });
  assert.equal(short.code, 'INSUFFICIENT');
  assert.deepEqual(short.shortages[0], { barcode: RICE, name: 'Rice', needed: 2, available: 1 });
  assert.equal(b.tab('Пакеты').rows()[0]['Содержимое'], '5 × Rice');
  assert.equal(b.call('editPacket', { opId: id, number: 1, items: [{ barcode: RICE, qty: 7 }], force: true }).ok, true);
  assert.equal(b.call('editPacket', { opId: op(), number: 1, items: [{ barcode: RICE, qty: 6 }] }).ok, true);
});

test('only a packet on the shelf can be edited, and never to empty', () => {
  const b = seeded();
  b.call('pack', { opId: op(), count: 2, items: [{ barcode: BEANS, qty: 1 }] });
  b.call('handout', { opId: op(), packets: [1] });
  const before = b.tab('Журнал').rows().length;
  const edit = (number, items) => b.call('editPacket', { opId: op(), number, items });
  assert.equal(edit(1, [{ barcode: BEANS, qty: 2 }]).code, 'CONFLICT');
  assert.equal(edit(99, [{ barcode: BEANS, qty: 2 }]).code, 'NOT_FOUND');
  assert.equal(edit(2, []).key, 'emptyPacket');
  assert.equal(edit(2, [{ barcode: '999', qty: 1 }]).code, 'UNKNOWN_PRODUCT');
  assert.equal(edit(2, [{ barcode: BEANS, qty: 0 }]).code, 'BAD_REQUEST');
  assert.equal(edit(2, [{ barcode: BEANS, qty: 1 }]).result.unchanged, true);
  assert.equal(b.tab('Журнал').rows().length, before);
});

test('a retried edit does not apply twice', () => {
  const b = seeded();
  b.call('pack', { opId: op(), items: [{ barcode: BEANS, qty: 1 }] });
  const body = { opId: op(), number: 1, items: [{ barcode: BEANS, qty: 3 }] };
  b.call('editPacket', body);
  const retry = b.call('editPacket', body);
  assert.equal(retry.replayed, true);
  assert.equal(stockOf(retry, BEANS).packed, 3);
});

test('undo is refused when a later edit would break the counts', () => {
  const b = seeded();
  const packed = b.call('pack', { opId: op(), items: [{ barcode: BEANS, qty: 1 }] });
  const first = b.call('editPacket', { opId: op(), number: 1, items: [{ barcode: BEANS, qty: 1 }, { barcode: RICE, qty: 1 }] });
  b.call('editPacket', { opId: op(), number: 1, items: [{ barcode: BEANS, qty: 1 }] });

  const undoFirst = b.call('undo', { opId: op(), targetOp: first.opId });
  assert.equal(undoFirst.code, 'CONFLICT');
  assert.equal(undoFirst.key, 'undoEdited');

  // Cancelling the packet would strand the rice added to it since.
  b.call('editPacket', { opId: op(), number: 1, items: [{ barcode: BEANS, qty: 1 }, { barcode: RICE, qty: 2 }] });
  const undoPack = b.call('undo', { opId: op(), targetOp: packed.opId });
  assert.equal(undoPack.key, 'undoEdited');

  const row = b.tab('Пакеты').rows()[0];
  assert.equal(row['Статус'], 'На полке');
  assert.equal(row['Содержимое'], '1 × Beans; 2 × Rice');
  assert.equal(stockOf(b.call('bootstrap'), RICE).packed, 2);
});

test('an empty handout is refused', () => {
  assert.equal(seeded().call('handout', { opId: op() }).code, 'BAD_REQUEST');
});

test('daily tabs show what came in and went out on each date', () => {
  let today = '2026-11-03T09:00:00Z';
  const b = createBackend({ date: () => new Date(today) });
  b.call('receive', { opId: op(), barcode: BEANS, qty: 10, product: { name: 'Beans' } });
  b.call('pack', { opId: op(), count: 2, items: [{ barcode: BEANS, qty: 2 }] });
  today = '2026-11-04T09:00:00Z';
  b.call('receive', { opId: op(), barcode: BEANS, qty: 1 });
  b.call('handout', { opId: op(), packets: [1] });
  b.call('handout', { opId: op(), items: [{ barcode: BEANS, qty: 1 }] });

  assert.deepEqual(b.tab('По дням').rows(), [
    { 'Дата': '2026-11-04', 'Получено': 1, 'Упаковано': 0, 'Выдано': 3, 'Пакетов выдано': 1, 'Выдач': 2 },
    { 'Дата': '2026-11-03', 'Получено': 10, 'Упаковано': 4, 'Выдано': 0, 'Пакетов выдано': 0, 'Выдач': 0 },
  ]);
  assert.deepEqual(b.tab('По дням подробно').rows()[0], {
    'Дата': '2026-11-04', 'Штрихкод': BEANS, 'Продукт': 'Beans', 'Получено': 1, 'Упаковано': 0, 'Выдано': 3,
  });
});

test('a day with only an undone action disappears from the daily tabs', () => {
  const b = createBackend();
  const r = b.call('receive', { opId: op(), barcode: BEANS, qty: 2, product: { name: 'Beans' } });
  b.call('undo', { opId: op(), targetOp: r.opId });
  assert.equal(b.tab('По дням').rows().length, 0);
  assert.equal(b.tab('По дням подробно').rows().length, 0);
});

test('leading zeros survive, and 12 and 13 digit forms are one product', () => {
  const b = createBackend();
  b.call('receive', { opId: op(), barcode: '012345678905', qty: 1, product: { name: 'Eight-oh' } });
  b.call('receive', { opId: op(), barcode: '00012345678', qty: 1, product: { name: 'Short' } });
  const reply = b.call('receive', { opId: op(), barcode: '0012345678905', qty: 1 });
  assert.equal(stockOf(reply, '012345678905').available, 2);
  assert.equal(b.tab('Остатки').rows().some((r) => r['Штрихкод'] === '00012345678'), true);
  assert.equal(b.tab('Продукты').rows().length, 2);
});

test('product names cannot run as formulas', () => {
  const b = createBackend();
  b.call('receive', { opId: op(), barcode: BEANS, qty: 1, product: { name: '=IMPORTXML("http://x","//a")' } });
  const name = b.tab('Продукты').rows()[0]['Название'];
  assert.equal(typeof name, 'string');
  assert.equal(name, '=IMPORTXML("http://x","//a")');
  assert.equal(b.tab('Продукты').cell(1, 1).format, '@');
});

test('items with no barcode get their own numbered codes', () => {
  const b = createBackend();
  const one = b.call('receive', { opId: op(), qty: 5, product: { name: 'Apples' } });
  const two = b.call('receive', { opId: op(), qty: 5, product: { name: 'Pears' } });
  assert.equal(one.result.barcode, 'NB-0001');
  assert.equal(two.result.barcode, 'NB-0002');
});

test('bad input is refused', () => {
  const b = seeded();
  for (const qty of [0, -1, 1.5, 'lots', 100001]) {
    assert.equal(b.call('receive', { opId: op(), barcode: BEANS, qty }).code, 'BAD_REQUEST', `qty ${qty}`);
  }
  assert.equal(b.call('receive', { opId: op(), barcode: 'has space', qty: 1 }).code, 'BAD_REQUEST');
  assert.equal(b.call('receive', { barcode: BEANS, qty: 1 }).code, 'BAD_REQUEST');
  assert.equal(b.call('pack', { opId: op(), items: [] }).code, 'BAD_REQUEST');
  assert.equal(b.call('pack', { opId: op(), items: [{ barcode: '999', qty: 1 }] }).code, 'UNKNOWN_PRODUCT');
  assert.equal(b.call('handout', { opId: op(), packets: [99] }).code, 'NOT_FOUND');
  assert.equal(b.call('nonsense', { opId: op() }).code, 'BAD_REQUEST');
});

test('a hand correction in the Log flows through to Stock', () => {
  const b = seeded();
  const log = b.tab('Журнал');
  const row = log.rows().findIndex((r) => r['Штрихкод'] === BEANS);
  log.getRange(row + 2, 6, 1, 1).setValues([[7]]);
  b.context.onEdit({ range: { getSheet: () => log } });
  assert.equal(b.tab('Остатки').rows().find((r) => r['Штрихкод'] === BEANS)['В наличии'], 7);
});

test('writing past the sheet\'s last row adds rows', () => {
  const b = seeded();
  b.tab('Журнал').maxRows = b.tab('Журнал').getLastRow();
  const reply = b.call('receive', { opId: op(), barcode: BEANS, qty: 1 });
  assert.equal(reply.ok, true);
});

/* ---------- Money and people ---------- */

const NOV_7 = () => new Date('2026-11-07T12:00:00Z');

test('the old money table pastes in and adds up', () => {
  const b = createBackend({ date: NOV_7 });
  b.tab('Деньги').getRange(2, 1, 8, 3).setValues([
    [5000, '04.11.2026', ''], [2000, '04.11.2026', ''], [-3200, '04.11.2026', 'лекарства Бабуле'],
    [5000, '04.11.2026', ''], [5000, '04.11.2026', ''], [2000, '05.11.2026', ''],
    [-1666, '05.11.2026', 'закуп'], [-3500, '05.11.2026', 'лекарства андрей лк'],
  ]);
  b.context.onEdit({ range: { getSheet: () => b.tab('Деньги') } });

  assert.deepEqual(b.tab('Деньги по дням').rows(), [
    { 'Дата': '05.11.2026', 'Пришло': 2000, 'Ушло': 5166, 'Итог за день': -3166, 'Остаток': 10634 },
    { 'Дата': '04.11.2026', 'Пришло': 17000, 'Ушло': 3200, 'Итог за день': 13800, 'Остаток': 13800 },
  ]);
  const money = b.call('bootstrap').state.money;
  assert.equal(money.balance, 10634);
  assert.deepEqual(money.badRows, []);
  assert.deepEqual(money.recent[0], { amount: -3500, date: '2026-11-05', note: 'лекарства андрей лк' });
  assert.equal(money.recent.length, 8);
});

test('the old people table pastes in, with empty counts as zero and short dates', () => {
  const b = createBackend({ date: NOV_7 });
  b.tab('Люди').getRange(2, 1, 5, 3).setValues([
    ['', 2, '2.11.26'], ['', 15, '3.11.26'], [4, 3, '4.11.26'], [2, 6, '5.11.26'], [1, 4, '6.11.26'],
  ]);
  b.context.onEdit({ range: { getSheet: () => b.tab('Люди') } });

  assert.deepEqual(b.tab('Люди по дням').rows(), [
    { 'Дата': '06.11.2026', 'Принесли': 1, 'Взяли': 4 },
    { 'Дата': '05.11.2026', 'Принесли': 2, 'Взяли': 6 },
    { 'Дата': '04.11.2026', 'Принесли': 4, 'Взяли': 3 },
    { 'Дата': '03.11.2026', 'Принесли': 0, 'Взяли': 15 },
    { 'Дата': '02.11.2026', 'Принесли': 0, 'Взяли': 2 },
  ]);
  assert.deepEqual(b.call('bootstrap').state.people.days[3], { date: '2026-11-03', brought: 0, took: 15 });
});

test('pasted cells can be real dates or text numbers', () => {
  const b = createBackend({ date: NOV_7 });
  const asDate = new b.context.Date(Date.UTC(2026, 10, 4));
  const sheet = b.tab('Деньги');
  sheet.getRange(2, 1, 3, 3).setValues([[100, asDate, ''], ["'+5 000", '4/11/2026', ''], ["'\u22121200,50", '2026-11-04', '']]);
  const money = b.call('bootstrap').state.money;
  assert.deepEqual(money.badRows, []);
  assert.equal(money.balance, 3900 - 0.5 + 0);
});

test('rows that cannot be read are reported and left out of the totals', () => {
  const b = createBackend({ date: NOV_7 });
  b.tab('Деньги').getRange(2, 1, 6, 3).setValues([
    [100, '04.11.2026', ''],
    ['Сумма', 'Дата', 'Примечание'],
    [100, '32.11.2026', ''],
    [100, '', ''],
    ["'5,000", '04.11.2026', ''],
    ['', '', ''],
  ]);
  b.tab('Люди').getRange(2, 1, 2, 3).setValues([[1.5, 2, '04.11.26'], [1, 2, 'вчера']]);
  const state = b.call('bootstrap').state;
  assert.equal(state.money.balance, 100);
  assert.deepEqual(state.money.badRows, [3, 4, 5, 6]);
  assert.deepEqual(state.people.badRows, [2, 3]);
});

test('money can be added and undone, and a retry does not count twice', () => {
  const b = createBackend({ date: NOV_7 });
  const id = op();
  b.call('money', { opId: id, amount: 5000, note: 'взнос' });
  const retry = b.call('money', { opId: id, amount: 5000, note: 'взнос' });
  assert.equal(retry.replayed, true);
  assert.equal(retry.state.money.balance, 5000);
  b.call('money', { opId: op(), amount: -1200, date: '2026-11-05', note: '=закуп' });

  const rows = b.tab('Деньги').rows();
  assert.equal(rows[0]['Сумма'], 5000);
  assert.equal(rows[0]['Дата'], '07.11.2026');
  assert.equal(rows[1]['Дата'], '05.11.2026');
  assert.equal(rows[1]['Примечание'], '=закуп');
  assert.equal(typeof rows[1]['Примечание'], 'string');
  assert.ok(!Object.keys(rows[0]).some((k) => /волонт/i.test(k)), 'no names in the ledger');
  assert.ok(!JSON.stringify(rows).includes('Sam'), 'no names in the ledger');

  const undone = b.call('undo', { opId: op(), targetOp: id });
  assert.equal(undone.state.money.balance, -1200);
  assert.equal(b.tab('Деньги').rows().length, 3);
  assert.equal(b.tab('Деньги').rows()[2]['Сумма'], -5000);
  assert.equal(b.tab('Деньги').rows()[2]['Примечание'], 'Отмена: взнос');
  assert.deepEqual(undone.state.money.recent.map((r) => r.amount), [-1200]);

  const again = b.call('undo', { opId: op(), targetOp: id });
  assert.equal(again.result.alreadyUndone, true);
  assert.equal(again.state.money.balance, -1200);
  assert.equal(b.tab('Деньги по дням').rows()[0]['Остаток'], -1200);
});

test('money refuses amounts and dates that make no sense', () => {
  const b = createBackend({ date: NOV_7 });
  for (const amount of [0, 1.5, 'abc', '', 1e12]) assert.equal(b.call('money', { opId: op(), amount }).key, 'badAmount', String(amount));
  for (const date of ['2026-11-08', '31.02.2026', 'soon']) assert.equal(b.call('money', { opId: op(), amount: 5, date }).key, 'badDate', date);
  assert.equal(b.tab('Деньги').rows().length, 0);
});

test('people are counted per day and cannot go below zero', () => {
  const b = createBackend({ date: NOV_7 });
  const id = op();
  b.call('people', { opId: id, field: 'took', delta: 3 });
  assert.equal(b.call('people', { opId: id, field: 'took', delta: 3 }).replayed, true);
  b.call('people', { opId: op(), field: 'brought', delta: 1 });
  b.call('people', { opId: op(), field: 'took', delta: -1 });
  const past = b.call('people', { opId: op(), field: 'brought', delta: 2, date: '2026-11-03' });
  assert.deepEqual(past.state.people.days, [
    { date: '2026-11-07', brought: 1, took: 2 },
    { date: '2026-11-03', brought: 2, took: 0 },
  ]);
  assert.equal(b.call('people', { opId: op(), field: 'brought', delta: -2 }).key, 'peopleBelowZero');
  assert.equal(b.call('people', { opId: op(), field: 'nobody', delta: 1 }).ok, false);
  assert.ok(!JSON.stringify(b.tab('Люди').rows()).includes('Sam'), 'no names in the ledger');
  assert.deepEqual(b.tab('Люди по дням').rows()[0], { 'Дата': '07.11.2026', 'Принесли': 1, 'Взяли': 2 });
});

test('a sheet set up before these tabs existed gets them when the app connects', () => {
  const b = createBackend({ date: NOV_7 });
  const ss = b.context.SpreadsheetApp.getActiveSpreadsheet();
  ['Деньги', 'Деньги по дням', 'Люди', 'Люди по дням'].forEach((name) => ss.deleteSheet(b.tab(name)));
  assert.equal(b.call('bootstrap').ok, true);
  assert.ok(b.tabs().includes('Деньги'));
  assert.equal(b.call('money', { opId: op(), amount: 10 }).state.money.balance, 10);
  assert.equal(b.tab('Деньги по дням').rows()[0]['Остаток'], 10);
});

/* ---------- Correcting a count ---------- */

test('a wrong count can be corrected, leaving a record, and undone', () => {
  const b = seeded();
  const id = op();
  const fixed = b.call('adjust', { opId: id, barcode: BEANS, available: 7, expected: 10 });
  assert.equal(stockOf(fixed, BEANS).available, 7);
  const row = b.tab('Журнал').rows().at(-1);
  assert.equal(row['Действие'], 'Получено');
  assert.equal(row['Кол-во'], -3);
  assert.equal(row['Примечание'], 'Исправление количества');
  assert.equal(b.tab('Остатки').rows().find((r) => r['Штрихкод'] === BEANS)['В наличии'], 7);

  assert.equal(b.call('adjust', { opId: id, barcode: BEANS, available: 7, expected: 10 }).replayed, true);
  assert.equal(stockOf(b.call('bootstrap'), BEANS).available, 7);

  assert.equal(stockOf(b.call('undo', { opId: op(), targetOp: id }), BEANS).available, 10);
  assert.equal(stockOf(b.call('adjust', { opId: op(), barcode: BEANS, available: 12, expected: 10 }), BEANS).available, 12);
});

test('a correction is refused if someone else just changed the count, or the number is wrong', () => {
  const b = seeded();
  const stale = b.call('adjust', { opId: op(), barcode: BEANS, available: 5, expected: 9 });
  assert.equal(stale.key, 'stockChanged');
  assert.equal(stale.params.n, 10);
  for (const available of [-1, 1.5, 'x']) assert.equal(b.call('adjust', { opId: op(), barcode: BEANS, available, expected: 10 }).key, 'badAmountOnHand');
  assert.equal(b.call('adjust', { opId: op(), barcode: '123456', available: 1, expected: 0 }).key, 'notReceived');
  assert.equal(stockOf(b.call('adjust', { opId: op(), barcode: BEANS, available: 0, expected: 10 }), BEANS).available, 0);
});
