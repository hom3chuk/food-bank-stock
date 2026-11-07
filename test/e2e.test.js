'use strict';
// Drives the real page on a phone-sized screen. Chromium's fake camera plays a video of
// a real EAN-13 barcode, and the phone's built-in barcode API is removed so the scan goes
// through the same library path that iPhones use.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { startServer } = require('./dev-server');

const OUT = path.join(__dirname, '.artifacts');
// Set E2E_CHROMIUM to use a browser you already have instead of Playwright's matching build.
const launchOptions = process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {};
const BARCODE = '5012345678900';

function ean13Bits(code) {
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const G = L.map((p) => [...p].map((b) => (b === '0' ? '1' : '0')).reverse().join(''));
  const R = L.map((p) => [...p].map((b) => (b === '0' ? '1' : '0')).join(''));
  const parity = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'][Number(code[0])];
  let bits = '101';
  for (let i = 0; i < 6; i++) bits += (parity[i] === 'L' ? L : G)[Number(code[i + 1])];
  bits += '01010';
  for (let i = 7; i < 13; i++) bits += R[Number(code[i])];
  return bits + '101';
}

function checkDigitOk(code) {
  const sum = [...code.slice(0, 12)].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === Number(code[12]);
}

async function barcodeImages(browser) {
  const page = await browser.newPage({ viewport: { width: 640, height: 480 } });
  await page.setContent(`<body style="margin:0;background:#fff"><canvas id="c" width="640" height="480"></canvas></body>`);
  await page.evaluate((bits) => {
    const ctx = document.getElementById('c').getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 640, 480);
    ctx.fillStyle = '#000';
    const unit = 5;
    const left = Math.floor((640 - bits.length * unit) / 2);
    [...bits].forEach((b, i) => { if (b === '1') ctx.fillRect(left + i * unit, 90, unit, 300); });
  }, ean13Bits(BARCODE));
  const jpeg = await page.screenshot({ type: 'jpeg', quality: 95 });
  const png = await page.screenshot({ type: 'png' });
  await page.close();
  return { jpeg, png };
}

test('a volunteer can receive, pack and give out on a phone', { timeout: 120000 }, async () => {
  assert.ok(checkDigitOk(BARCODE), 'test barcode has a valid check digit');
  fs.mkdirSync(OUT, { recursive: true });

  const helper = await chromium.launch(launchOptions);
  const { jpeg, png } = await barcodeImages(helper);
  await helper.close();
  const videoPath = path.join(OUT, 'barcode.mjpeg');
  const photoPath = path.join(OUT, 'barcode.png');
  fs.writeFileSync(videoPath, Buffer.concat(Array(30).fill(jpeg)));
  fs.writeFileSync(photoPath, png);

  const { server, backend, url } = await startServer({ port: 0 });
  const browser = await chromium.launch({
    ...launchOptions,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${videoPath}`],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ['camera'] });
  await context.addInitScript(() => { delete window.BarcodeDetector; });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());

  const shot = (name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  const noSideScroll = async (where) => {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `${where}: page scrolls sideways by ${over}px`);
  };
  const tab = (name) => page.locator('nav button', { hasText: name }).click();

  try {
    // Sign in.
    await page.goto(url);
    await page.getByLabel('Your name').fill('Sam');
    await page.getByLabel('Passcode').fill('nope');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByText('Wrong passcode.').waitFor();
    await page.getByLabel('Passcode').fill('test-passcode');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Receive a donation' }).waitFor();
    await shot('1-receive');
    await noSideScroll('receive');

    // A new barcode, read by the live camera, opens the new product form.
    await page.getByRole('button', { name: 'Scan barcode' }).click();
    await page.getByRole('heading', { name: 'New product' }).waitFor({ timeout: 30000 });
    await page.getByText(`Barcode ${BARCODE} is not in the sheet yet.`).waitFor();
    await page.getByLabel('Product name').fill('Tinned beans 400g');
    await page.getByLabel('Category').selectOption('Tinned food');
    await page.getByLabel('Quantity').fill('20');
    await shot('2-new-product');
    await noSideScroll('new product');
    await page.getByRole('button', { name: 'Add product and save' }).click();
    await page.getByText('Added 20 × Tinned beans 400g.').waitFor();

    // The camera turns back on, and the same barcode is now recognised.
    await page.getByRole('heading', { name: 'Tinned beans 400g' }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: '+5', exact: true }).click();
    await shot('3-known-product');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Added 6 × Tinned beans 400g.').waitFor();

    // Undo takes those 6 back off.
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByText('Undone.').waitFor();
    assert.equal(backend.tab('Остатки').rows()[0]['В наличии'], 20);

    // A photo works when the live camera is not available.
    await page.locator('input[type=file]').setInputFiles(photoPath);
    await page.getByRole('heading', { name: 'Tinned beans 400g' }).waitFor({ timeout: 30000 });
    await page.getByRole('button', { name: 'Cancel' }).click();

    // An item with no barcode.
    await page.getByRole('button', { name: 'Item with no barcode' }).click();
    await page.getByRole('button', { name: 'Add a new item' }).click();
    await page.getByLabel('Product name').fill('Apples');
    await page.getByLabel('Quantity').fill('8');
    await page.getByRole('button', { name: 'Add product and save' }).click();
    await page.getByText('Added 8 × Apples.').waitFor();

    // Make 3 identical packets, each with 2 tins and 1 apple.
    await tab('Pack');
    const typed = page.getByLabel('Barcode number');
    await typed.fill(BARCODE);
    await page.getByRole('button', { name: 'Go' }).click();
    await page.getByText('20 available').waitFor();
    await typed.fill(BARCODE);
    await page.getByRole('button', { name: 'Go' }).click();
    await page.getByText('2 items in each packet').waitFor();
    await page.getByRole('button', { name: 'Add an item with no barcode' }).click();
    await page.locator('dialog').getByRole('button', { name: /Apples/ }).click();
    await page.getByText('3 items in each packet').waitFor();
    await page.getByLabel('How many identical packets?').fill('3');
    await shot('4-pack');
    await noSideScroll('pack');
    await page.getByRole('button', { name: 'Create 3 packets' }).click();
    await page.getByText('1 to 3', { exact: true }).waitFor();
    await shot('5-packet-numbers');

    // One person: packet 2 by its pen number, then a tin scanned off the shelf.
    await page.getByRole('button', { name: 'Make another packet' }).click();
    await tab('Give out');
    await page.getByLabel('Packet number').fill('2');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('Basket: 1 packet').waitFor();
    await page.getByRole('button', { name: 'Scan barcode' }).click();
    await page.getByText('Basket: 1 packet, 1 item').waitFor({ timeout: 30000 });
    // Holding the camera on the same tin must not keep adding it.
    await page.waitForTimeout(3000);
    assert.equal(await page.locator('.basket-bar span').textContent(), 'Basket: 1 packet, 1 item');
    await shot('6-basket');
    await noSideScroll('basket');

    // Nothing is marked yet, and the basket survives a reload.
    let stock = backend.tab('Остатки').rows().find((r) => r['Штрихкод'] === BARCODE);
    assert.deepEqual([stock['В наличии'], stock['Упаковано'], stock['Выдано']], [14, 6, 0]);
    await page.reload();
    await page.getByRole('heading', { name: 'Receive a donation' }).waitFor();
    await tab('Give out');
    await page.getByText('Basket: 1 packet, 1 item').waitFor();

    // Finish marks the packet and the extra as one handout.
    await page.getByRole('button', { name: 'Finish: mark all as given out' }).click();
    await page.getByText('Given out: packet 2 and 1 item.').waitFor();
    await page.getByText('On the shelf (2)').waitFor();
    stock = backend.tab('Остатки').rows().find((r) => r['Штрихкод'] === BARCODE);
    assert.deepEqual([stock['В наличии'], stock['Упаковано'], stock['Выдано']], [13, 4, 3]);
    assert.equal(backend.tab('По дням').rows()[0]['Выдач'], 1);

    // The same number again says when it went out.
    await page.getByLabel('Packet number').fill('2');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText(/Packet 2 was given out on \d{4}-\d{2}-\d{2} by Sam\./).waitFor();

    // A packet number that does not exist.
    await page.getByLabel('Packet number').fill('999');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('There is no packet 999.').waitFor();

    // Unpack returns a packet's items to Available.
    await page.getByRole('button', { name: /^Packet 3/ }).click();
    await page.getByRole('button', { name: /Unpack/ }).click();
    await page.getByText('Packet 3 unpacked.').waitFor();

    // Only shelf items this time, asking for more than the sheet shows.
    await page.getByRole('button', { name: 'Add an item with no barcode' }).click();
    await page.locator('dialog').getByRole('button', { name: /^Apples/ }).click();
    await page.getByText('Basket: 1 item').waitFor();
    const more = page.locator('#basket').getByRole('button', { name: 'One more' });
    for (let i = 0; i < 49; i++) await more.click();
    await page.getByText('Basket: 50 items').waitFor();
    await page.getByRole('button', { name: 'Finish: mark all as given out' }).click();
    await page.getByText('Given out: 50 items.').waitFor();
    await shot('7-given');

    // Taking an apple out of packet 1, which holds 2 tins and 1 apple.
    await page.getByLabel('Packet number').fill('1');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.getByText('Basket: 1 packet').waitFor();
    const fewerApples = page.getByRole('button', { name: 'One fewer Apples in packet 1' });
    const fewerTins = page.getByRole('button', { name: 'One fewer Tinned beans 400g in packet 1' });
    await fewerApples.click();
    await page.getByText('1 back to the shelf').waitFor();
    assert.equal(await fewerApples.isDisabled(), true);
    await shot('7b-remove-from-packet');
    await noSideScroll('remove from packet');

    // The last item can't be removed, because an empty packet can't go out.
    await fewerTins.click();
    assert.equal(await fewerTins.isDisabled(), true);
    await page.getByRole('button', { name: 'One more Tinned beans 400g in packet 1' }).click();

    // The removal survives a reload, and Finish tells the volunteer what to put back.
    await page.reload();
    await page.getByRole('heading', { name: 'Receive a donation' }).waitFor();
    await tab('Give out');
    await page.getByText('1 back to the shelf').waitFor();
    const applesBefore = backend.tab('Остатки').rows().find((r) => r['Продукт'] === 'Apples')['В наличии'];
    await page.getByRole('button', { name: 'Finish: mark all as given out' }).click();
    await page.getByText('Given out: packet 1. Put back on the shelf: 1 × Apples.').waitFor();
    assert.equal(backend.tab('Остатки').rows().find((r) => r['Продукт'] === 'Apples')['В наличии'], applesBefore + 1);
    stock = backend.tab('Остатки').rows().find((r) => r['Штрихкод'] === BARCODE);
    assert.deepEqual([stock['Упаковано'], stock['Выдано']], [0, 5]);
    assert.equal(backend.tab('Пакеты').rows()[0]['Содержимое'], '2 × Tinned beans 400g (возвращено: 1 × Apples)');

    // Stock screen.
    await tab('Stock');
    await page.getByRole('heading', { name: 'All stock' }).waitFor();
    await page.getByRole('searchbox').fill('tinned');
    await page.locator('.row-title', { hasText: 'Tinned beans' }).waitFor();
    await shot('8-stock');
    await noSideScroll('stock');

    // Reloading keeps the volunteer signed in.
    await page.reload();
    await page.getByRole('heading', { name: 'Receive a donation' }).waitFor();

    // Product names are shown as plain text, never run as code.
    await page.getByLabel('Barcode number').fill('12345670');
    await page.getByRole('button', { name: 'Go' }).click();
    await page.getByLabel('Product name').fill('<img src=x onerror="window.hacked=1">');
    await page.getByRole('button', { name: 'Add product and save' }).click();
    await page.getByText(/Added 1 ×/).waitFor();
    await tab('Stock');
    await page.waitForTimeout(300);
    assert.equal(await page.evaluate(() => window.hacked), undefined);

    // Leaving a screen while the camera starts must not break scanning afterwards.
    await tab('Pack');
    await page.getByRole('button', { name: 'Scan barcode' }).click();
    await tab('Stock');
    await tab('Pack');
    await page.getByRole('button', { name: 'Scan barcode' }).click();
    await page.getByText(/1 item in each packet/).waitFor({ timeout: 30000 });

    // Chromium reports this when a video is removed while starting, which that step does on purpose.
    const expected = /play\(\) request was interrupted/;
    assert.deepEqual(errors.filter((e) => !expected.test(e)), []);

    const daily = backend.tab('По дням').rows();
    assert.equal(daily.length, 1);
    assert.equal(daily[0]['Получено'], 29);
    console.log('Daily tab:', daily);
    console.log('Packets tab:', backend.tab('Пакеты').rows());
  } catch (err) {
    await shot('failure').catch(() => {});
    throw err;
  } finally {
    await browser.close();
    server.close();
  }
});

// Walks every main screen in Russian and Serbian on the narrowest common phone width.
for (const { locale, lang, labels } of [
  {
    locale: 'ru-RU',
    lang: 'ru',
    labels: {
      name: 'Ваше имя', pass: 'Код доступа', signIn: 'Вход', badPass: 'Неверный код доступа.', receiveTitle: 'Приём пожертвований',
      typeCode: 'Номер штрихкода', go: 'ОК', newProduct: 'Новый продукт', productName: 'Название продукта', category: 'Категория',
      categoryValue: 'Консервы', save: 'Добавить продукт и сохранить', added: 'Добавлено: 5 × Фасоль.', pack: 'Упаковка', perPacket: 'В каждом пакете: 1 шт.',
      howMany: 'Сколько одинаковых пакетов?', create: 'Создать 5 пакетов', created: 'Создано пакетов: 5', range: 'с 1 по 5', another: 'Собрать ещё один пакет',
      give: 'Выдача', packetNumber: 'Номер пакета', add: 'Добавить', bar: 'Корзина: 2 пакета', finish: 'Завершить: отметить всё как выданное',
      conflict: 'Статус пакета 2: «Выдан».', stock: 'Склад', stockTitle: 'Все остатки', remove: 'Убрать пакет 2', given: 'Выдано: пакет 1.', noPacket: 'Пакета 999 нет.',
    },
  },
  {
    locale: 'sr-RS',
    lang: 'sr',
    labels: {
      name: 'Vaše ime', pass: 'Pristupni kod', signIn: 'Prijava', badPass: 'Pogrešan pristupni kod.', receiveTitle: 'Prijem donacije',
      typeCode: 'Broj bar-koda', go: 'U redu', newProduct: 'Novi proizvod', productName: 'Naziv proizvoda', category: 'Kategorija',
      categoryValue: 'Konzervirana hrana', save: 'Dodaj proizvod i sačuvaj', added: 'Dodato: 5 × Фасоль.', pack: 'Pakovanje', perPacket: 'U svakom paketu: 1 kom.',
      howMany: 'Koliko istih paketa?', create: 'Napravi 5 paketa', created: 'Napravljeno paketa: 5', range: 'od 1 do 5', another: 'Sastavi još jedan paket',
      give: 'Izdavanje', packetNumber: 'Broj paketa', add: 'Dodaj', bar: 'Korpa: 2 paketa', finish: 'Završi: označi sve kao izdato',
      conflict: 'Status paketa 2: „Izdat”.', stock: 'Zalihe', stockTitle: 'Sve zalihe', remove: 'Ukloni paket 2', given: 'Izdato: paket 1.', noPacket: 'Paket 999 ne postoji.',
    },
  },
]) {
  test(`the app works in ${locale}`, { timeout: 90000 }, async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const { server, backend, url } = await startServer({ port: 0 });
    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({ viewport: { width: 320, height: 640 }, hasTouch: true, isMobile: true, locale });
    const page = await context.newPage();
    const errors = [];
    const dialogs = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });

    const english = await (async () => {
      await page.goto(url);
      return page.evaluate((id) => {
        const { en } = window.I18N.strings;
        const target = window.I18N.strings[id];
        return Object.entries(en)
          .filter(([key, value]) => typeof value === 'string' && !value.includes('{') && value !== target[key])
          .map(([, value]) => value);
      }, lang);
    })();

    // Text on screen, in placeholders, and read out by screen readers. Must not still be in English.
    const checkScreen = async (where) => {
      const text = await page.evaluate(() => [
        document.body.innerText,
        ...[...document.querySelectorAll('[placeholder]')].map((e) => e.getAttribute('placeholder')),
        ...[...document.querySelectorAll('[aria-label]')].map((e) => e.getAttribute('aria-label')),
      ].join('\n'));
      const lines = text.split('\n').map((l) => l.trim());
      for (const phrase of english) assert.ok(!lines.includes(phrase), `${where}: still in English: "${phrase}"`);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 0, `${where}: page scrolls sideways by ${over}px`);
      await page.screenshot({ path: path.join(OUT, `${lang}-${where}.png`), fullPage: true });
    };
    const tab = (name) => page.locator('nav button', { hasText: name }).click();

    try {
      // The phone's language is picked up automatically.
      assert.equal(await page.locator('html').getAttribute('lang'), lang === 'sr' ? 'sr-Latn' : 'ru');
      await page.getByRole('heading', { name: labels.signIn }).waitFor();
      await checkScreen('login');

      await page.getByLabel(labels.name).fill('Анна');
      await page.getByLabel(labels.pass).fill('wrong');
      await page.locator('form button[type=submit]').click();
      await page.getByText(labels.badPass).waitFor();
      await page.getByLabel(labels.pass).fill('test-passcode');
      await page.locator('form button[type=submit]').click();
      await page.getByRole('heading', { name: labels.receiveTitle }).waitFor();
      await checkScreen('receive');

      // A new product, with the category shown translated but saved in one language.
      await page.getByLabel(labels.typeCode).fill('12345670');
      await page.getByRole('button', { name: labels.go, exact: true }).click();
      await page.getByRole('heading', { name: labels.newProduct }).waitFor();
      await page.getByLabel(labels.productName).fill('Фасоль');
      await page.getByLabel(labels.category).selectOption({ label: labels.categoryValue });
      await page.locator('input[type=number]').fill('5');
      await checkScreen('new-product');
      await page.getByRole('button', { name: labels.save }).click();
      await page.getByText(labels.added).waitFor();
      assert.equal(backend.tab('Продукты').rows()[0]['Категория'], 'Консервы');

      // Five packets, one item each.
      await tab(labels.pack);
      await page.getByLabel(labels.typeCode).fill('12345670');
      await page.getByRole('button', { name: labels.go, exact: true }).click();
      await page.getByText(labels.perPacket).waitFor();
      await page.getByLabel(labels.howMany).fill('5');
      await checkScreen('pack');
      await page.getByRole('button', { name: labels.create }).click();
      await page.getByRole('heading', { name: labels.created }).waitFor();
      await page.getByText(labels.range, { exact: true }).waitFor();
      await checkScreen('packet-numbers');
      await page.getByRole('button', { name: labels.another }).click();

      // A basket, and an error from the server shown in this language.
      await tab(labels.give);
      for (const n of ['1', '2']) {
        await page.getByLabel(labels.packetNumber).fill(n);
        await page.getByRole('button', { name: labels.add, exact: true }).click();
        await page.locator('.basket-bar').waitFor();
      }
      await page.getByText(labels.bar).waitFor();
      await checkScreen('basket');
      const other = backend.call('handout', { opId: 'someoneelse01', packets: [2] });
      assert.equal(other.ok, true);
      await page.getByRole('button', { name: labels.finish }).click();
      await page.getByText(labels.conflict).waitFor();
      await page.getByRole('button', { name: labels.remove }).click();
      await page.getByRole('button', { name: labels.finish }).click();
      await page.getByText(labels.given).waitFor();

      await page.getByLabel(labels.packetNumber).fill('999');
      await page.getByRole('button', { name: labels.add, exact: true }).click();
      await page.getByText(labels.noPacket).waitFor();

      // Stock shows the translated category, and the choice survives a reload.
      await tab(labels.stock);
      await page.getByRole('heading', { name: labels.stockTitle }).waitFor();
      await page.getByText(labels.categoryValue).waitFor();
      await checkScreen('stock');
      await page.reload();
      await page.getByRole('heading', { name: labels.receiveTitle }).waitFor();

      // The switcher takes effect right away, keeps a basket, and wins over the phone's language.
      await tab(labels.give);
      await page.getByLabel(labels.packetNumber).fill('3');
      await page.getByRole('button', { name: labels.add, exact: true }).click();
      await page.locator('.basket-bar').waitFor();
      await page.locator('.lang-select').selectOption('en');
      await page.getByRole('heading', { name: 'Give out to one person' }).waitFor();
      await page.getByText('Basket: 1 packet').waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'), 'en');
      await page.reload();
      await page.getByRole('heading', { name: 'Receive a donation' }).waitFor();

      assert.deepEqual(errors, []);
    } catch (err) {
      await page.screenshot({ path: path.join(OUT, `${lang}-failure.png`), fullPage: true }).catch(() => {});
      throw err;
    } finally {
      await browser.close();
      server.close();
    }
  });
}

test('a packet on the shelf can be edited', { timeout: 60000 }, async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { server, backend, url } = await startServer({ port: 0 });
  const seed = (name, barcode, qty) => backend.call('receive', { opId: `seed${barcode}`, barcode, qty, product: { name } });
  seed('Beans', '12345670', 10);
  seed('Rice', '96385074', 10);
  seed('Oil', '40170725', 1);
  backend.call('pack', { opId: 'seedpacks01', count: 2, items: [{ barcode: '12345670', qty: 2 }, { barcode: '96385074', qty: 1 }] });

  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  const dialogs = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  const stockOf = (name) => backend.tab('Остатки').rows().find((r) => r['Продукт'] === name);
  const packet = (n) => backend.tab('Пакеты').rows()[n - 1];
  const rowFor = (name) => page.locator('.row', { hasText: name });

  try {
    await page.goto(url);
    await page.getByLabel('Your name').fill('Sam');
    await page.getByLabel('Passcode').fill('test-passcode');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // A number that doesn't exist, then a real one, from the Pack tab.
    await page.locator('nav button', { hasText: 'Pack' }).click();
    await page.getByLabel('Packet to edit').fill('999');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByText('There is no packet 999.').waitFor();
    await page.getByLabel('Packet to edit').fill('1');
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.getByRole('heading', { name: 'Edit packet 1' }).waitFor();

    // Nothing changed yet, so there is nothing to save.
    const save = page.getByRole('button', { name: 'Save changes' });
    assert.equal(await save.isDisabled(), true);

    // Take out the rice, keep the beans, add oil.
    await rowFor('Rice').getByRole('button', { name: 'One fewer' }).click();
    await page.getByLabel('Barcode number').fill('40170725');
    await page.getByRole('button', { name: 'Go' }).click();
    await rowFor('Oil').waitFor();
    await page.screenshot({ path: path.join(OUT, 'edit-packet.png'), fullPage: true });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `edit screen scrolls sideways by ${over}px`);
    await save.click();
    await page.getByText('Packet 1 updated. Put back on the shelf: 1 × Rice.').waitFor();

    assert.equal(packet(1)['Статус'], 'На полке');
    assert.equal(packet(1)['Содержимое'], '2 × Beans; 1 × Oil');
    assert.equal(packet(2)['Содержимое'], '2 × Beans; 1 × Rice');
    assert.equal(stockOf('Rice')['Упаковано'], 1);
    assert.equal(stockOf('Rice')['В наличии'], 9);
    assert.equal(stockOf('Oil')['В наличии'], 0);
    assert.equal(stockOf('Oil')['Упаковано'], 1);

    // Undo puts it all back.
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByText('Undone.').waitFor();
    assert.equal(packet(1)['Содержимое'], '2 × Beans; 1 × Rice');
    assert.equal(stockOf('Oil')['В наличии'], 1);
    assert.equal(stockOf('Rice')['Упаковано'], 2);

    // From the shelf list on Give out, asking for more than is available warns first.
    await page.locator('nav button', { hasText: 'Give out' }).click();
    await page.getByRole('button', { name: /^Packet 2/ }).click();
    await page.getByRole('button', { name: 'Edit contents' }).click();
    await page.getByRole('heading', { name: 'Edit packet 2' }).waitFor();
    const beansMore = rowFor('Beans').getByRole('button', { name: 'One more' });
    for (let i = 0; i < 7; i++) await beansMore.click();
    await save.click();
    await page.getByText('Packet 2 updated.').waitFor();
    assert.match(dialogs[0], /Beans: need 7, 6 on record/);
    assert.equal(packet(2)['Содержимое'], '9 × Beans; 1 × Rice');

    // Removing everything is refused, with a pointer to Unpack.
    await page.getByRole('button', { name: /^Packet 2/ }).click();
    await page.getByRole('button', { name: 'Edit contents' }).click();
    await rowFor('Rice').getByRole('button', { name: 'One fewer' }).click();
    const beansFewer = rowFor('Beans').getByRole('button', { name: 'One fewer' });
    for (let i = 0; i < 9; i++) await beansFewer.click();
    await page.getByText('A packet needs at least one item.').waitFor();
    assert.equal(await save.isDisabled(), true);
    await page.getByRole('button', { name: 'Cancel' }).click();

    // An edited packet goes out with its new contents.
    await page.getByRole('button', { name: /^Packet 2/ }).click();
    await page.getByRole('button', { name: 'Add to this basket' }).click();
    await page.getByRole('button', { name: 'Finish: mark all as given out' }).click();
    await page.getByText('Given out: packet 2.').waitFor();
    assert.equal(stockOf('Beans')['В наличии'], -1);
    assert.equal(stockOf('Beans')['Выдано'], 9);
    assert.equal(stockOf('Beans')['Упаковано'], 2);

    assert.deepEqual(errors, []);
  } catch (err) {
    await page.screenshot({ path: path.join(OUT, 'edit-failure.png'), fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
    server.close();
  }
});

test('with no working camera, every scanning screen works by typing the number', { timeout: 120000 }, async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { server, backend, url } = await startServer({ port: 0 });
  // No fake camera and no camera permission, so starting the camera fails.
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const dialogs = [];
  let acceptDialogs = false;
  page.on('dialog', (d) => { dialogs.push(d.message()); return acceptDialogs ? d.accept() : d.dismiss(); });
  const typeCode = async (value) => {
    await page.getByLabel('Barcode number').fill(value);
    await page.getByRole('button', { name: 'Go', exact: true }).click();
  };
  const tab = (name) => page.locator('nav button', { hasText: name }).click();

  try {
    await page.goto(url);
    await page.getByLabel('Your name').fill('Sam');
    await page.getByLabel('Passcode').fill('test-passcode');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Receive a donation' }).waitFor();

    await page.getByRole('button', { name: 'Scan barcode' }).click();
    await page.getByText('The camera could not start').waitFor({ timeout: 15000 });

    // Which numbers pass the check, including short UPC-E labels that EAN-8 maths would refuse.
    const verdicts = await page.evaluate(() => ['5012345678900', '5012345678901', '036000291452', '96385074', '04252614', '04252615', '12345', 'ABC123', '00012345678905'].map(barcodeLooksRight));
    assert.deepEqual(verdicts, [true, false, true, true, true, false, false, true, true]);

    await typeCode('abc def!');
    await page.getByText('Please type the numbers under the barcode').waitFor();

    // A mistyped digit asks first. Saying no leaves the number there to correct.
    await typeCode('5012345678901');
    assert.match(dialogs[0], /5012345678901/);
    assert.equal(await page.getByLabel('Barcode number').inputValue(), '5012345678901');
    await page.getByRole('heading', { name: 'Receive a donation' }).waitFor();

    // A label that really does fail the check can still be used, and only asks the first time.
    acceptDialogs = true;
    await typeCode('12345');
    assert.equal(dialogs.length, 2);
    await page.getByRole('heading', { name: 'New product' }).waitFor();
    await page.getByLabel('Product name').fill('Shop label rice');
    await page.getByRole('button', { name: 'Add product and save' }).click();
    await page.getByText('Added 1 × Shop label rice.').waitFor();
    await typeCode('12345');
    await page.getByRole('heading', { name: 'Shop label rice' }).waitFor();
    assert.equal(dialogs.length, 2);
    await page.getByRole('button', { name: 'Cancel' }).click();
    acceptDialogs = false;

    // Receive: gaps from the printed label are ignored, a new number opens the form,
    // and saving keeps the confirmation on screen.
    await typeCode('5 012345 678900');
    await page.getByText(`Barcode ${BARCODE} is not in the sheet yet.`).waitFor();
    await page.getByRole('heading', { name: 'New product' }).waitFor();
    await page.getByLabel('Product name').fill('Tinned beans');
    await page.getByLabel('Quantity').fill('20');
    await page.getByRole('button', { name: 'Add product and save' }).click();
    await page.getByText('Added 20 × Tinned beans.').waitFor();
    await page.waitForTimeout(1500);
    await page.getByText('Added 20 × Tinned beans.').waitFor({ timeout: 1000 });
    assert.equal(await page.getByRole('button', { name: 'Undo' }).count(), 1);
    assert.equal(await page.getByText('The camera could not start').count(), 0);

    // Receive: a known number is recognised.
    await typeCode(BARCODE);
    await page.getByRole('heading', { name: 'Tinned beans' }).waitFor();
    await page.getByRole('button', { name: 'Cancel' }).click();

    // Pack.
    await tab('Pack');
    await typeCode(BARCODE);
    await page.getByText('1 item in each packet').waitFor();
    await page.getByLabel('How many identical packets?').fill('1');
    await page.getByRole('button', { name: /^Create/ }).click();
    await page.getByRole('heading', { name: 'Packet created' }).waitFor();

    // Give out.
    await tab('Give out');
    await typeCode(BARCODE);
    await page.getByText(/^Basket: /).waitFor();

    // Editing a packet on the shelf.
    await page.getByRole('button', { name: /^Packet 1/ }).click();
    await page.getByRole('button', { name: 'Edit contents' }).click();
    await page.getByRole('heading', { name: 'Edit packet 1' }).waitFor();
    await typeCode(BARCODE);
    await page.getByRole('button', { name: /^Save/ }).click();
    await page.getByText('Packet 1 updated.').waitFor();
    assert.equal(backend.tab('Пакеты').rows()[0]['Содержимое'], '2 × Tinned beans');

    assert.deepEqual(errors, []);
  } catch (err) {
    await page.screenshot({ path: path.join(OUT, 'typed-failure.png'), fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
    server.close();
  }
});

test('a barcode can be read from further away, small in the frame', { timeout: 120000 }, async () => {
  fs.mkdirSync(OUT, { recursive: true });
  // A portrait frame, like a phone's, with the barcode at about a quarter of its width.
  const helper = await chromium.launch(launchOptions);
  const framePage = await helper.newPage({ viewport: { width: 1440, height: 1920 } });
  await framePage.setContent('<body style="margin:0;background:#fff"><canvas id="c" width="1440" height="1920" style="filter:blur(1px)"></canvas></body>');
  await framePage.evaluate((bits) => {
    const ctx = document.getElementById('c').getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 1440, 1920);
    ctx.fillStyle = '#000';
    const unit = 4;
    const left = Math.floor((1440 - bits.length * unit) / 2);
    [...bits].forEach((b, i) => { if (b === '1') ctx.fillRect(left + i * unit, 840, unit, 240); });
  }, ean13Bits(BARCODE));
  const videoPath = path.join(OUT, 'small-barcode.mjpeg');
  fs.writeFileSync(videoPath, Buffer.concat(Array(10).fill(await framePage.screenshot({ type: 'jpeg', quality: 90 }))));
  await helper.close();

  const { server, url } = await startServer({ port: 0 });
  const browser = await chromium.launch({
    ...launchOptions,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${videoPath}`],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ['camera'] });
  await context.addInitScript(() => { delete window.BarcodeDetector; });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  try {
    await page.goto(url);
    await page.getByLabel('Your name').fill('Sam');
    await page.getByLabel('Passcode').fill('test-passcode');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Receive a donation' }).waitFor();
    await page.getByRole('button', { name: 'Scan barcode' }).click();
    await page.getByText(`Barcode ${BARCODE} is not in the sheet yet.`).waitFor({ timeout: 15000 });
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `page scrolls sideways by ${over}px`);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

test('a scan flashes, beeps and puts the item at the top of the list', { timeout: 120000 }, async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const helper = await chromium.launch(launchOptions);
  const { jpeg } = await barcodeImages(helper);
  await helper.close();
  const videoPath = path.join(OUT, 'flash-barcode.mjpeg');
  fs.writeFileSync(videoPath, Buffer.concat(Array(30).fill(jpeg)));

  const { server, url } = await startServer({ port: 0 });
  const browser = await chromium.launch({
    ...launchOptions,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${videoPath}`],
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, permissions: ['camera'] });
  await context.addInitScript(() => {
    delete window.BarcodeDetector;
    window.beeps = 0;
    const start = OscillatorNode.prototype.start;
    OscillatorNode.prototype.start = function (...args) { window.beeps += 1; return start.apply(this, args); };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  const beeps = () => page.evaluate(() => window.beeps);
  const flash = page.locator('.scan-flash');
  const tab = (name) => page.locator('nav button', { hasText: name }).click();
  const typeCode = async (value) => {
    await page.getByLabel('Barcode number').fill(value);
    await page.getByRole('button', { name: 'Go', exact: true }).click();
  };
  const receiveTyped = async (code, name) => {
    await typeCode(code);
    await page.getByLabel('Product name').fill(name);
    await page.getByRole('button', { name: 'Add product and save' }).click();
    await page.getByText(`Added 1 × ${name}.`).waitFor();
  };
  const firstRow = (scope) => page.locator(`${scope} .row`).first();

  try {
    await page.goto(url);
    await page.getByLabel('Your name').fill('Sam');
    await page.getByLabel('Passcode').fill('test-passcode');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Receive a donation' }).waitFor();

    // A barcode nobody has received gets the warning, with no flash or beep.
    await tab('Pack');
    await page.getByRole('button', { name: 'Scan barcode' }).click();
    await page.getByText(`Barcode ${BARCODE} has not been received yet.`).waitFor({ timeout: 30000 });
    assert.equal(await beeps(), 0);
    assert.equal(await flash.isVisible(), false);
    await page.getByRole('button', { name: 'Stop camera' }).click();

    // On Receive, nothing is saved at the scan, so it says "scanned" and only then opens the form.
    await tab('Receive');
    await page.getByRole('button', { name: 'Scan barcode' }).click();
    await page.getByText(`${BARCODE} scanned`).waitFor({ timeout: 30000 });
    assert.equal(await beeps(), 1);
    await page.getByRole('heading', { name: 'New product' }).waitFor();
    await page.getByLabel('Product name').fill('Beans');
    await page.getByRole('button', { name: 'Add product and save' }).click();
    await page.getByText('Added 1 × Beans.').waitFor();
    assert.equal(await beeps(), 2);
    await page.getByRole('button', { name: 'Stop camera' }).click({ timeout: 15000 });
    await receiveTyped('96385074', 'Rice');
    await receiveTyped('036000291452', 'Oil');

    // Pack: typed items stack newest first, and a camera scan flashes and goes on top.
    await tab('Pack');
    await typeCode('96385074');
    await page.getByText('1 item in each packet').waitFor();
    await typeCode('036000291452');
    await page.getByText('2 items in each packet').waitFor();
    assert.match(await firstRow('.card').innerText(), /Oil/);
    const before = await beeps();
    await page.getByRole('button', { name: 'Scan barcode' }).click();
    await page.getByText('Beans added').waitFor({ timeout: 30000 });
    await page.screenshot({ path: path.join(OUT, '5-scan-flash.png') });
    assert.equal(await beeps(), before + 1);
    assert.match(await firstRow('.card').innerText(), /Beans/);
    await flash.waitFor({ state: 'hidden', timeout: 5000 });
    await page.getByRole('button', { name: 'Stop camera' }).click();

    // Scanning an item already on the list moves it back to the top.
    await typeCode('96385074');
    await page.getByText('4 items in each packet').waitFor();
    assert.match(await firstRow('.card').innerText(), /Rice/);
    await page.getByLabel('How many identical packets?').fill('1');
    await page.getByRole('button', { name: /^Create/ }).click();
    await page.getByRole('heading', { name: 'Packet created' }).waitFor();

    // Give out: a new item appears above the packet already in the basket.
    await tab('Give out');
    await page.getByLabel('Packet number').fill('1');
    await page.getByRole('button', { name: 'Add', exact: true }).click();
    await page.locator('#basket').getByText('Packet 1').waitFor();
    await typeCode('036000291452');
    await page.getByText(/^Basket: .*item/).waitFor();
    assert.match(await firstRow('#basket').innerText(), /Oil/);

    assert.deepEqual(errors, []);
  } catch (err) {
    await page.screenshot({ path: path.join(OUT, 'flash-failure.png'), fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
    server.close();
  }
});

test('people, money and correcting a count work on a phone', { timeout: 120000 }, async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { server, backend, url } = await startServer({ port: 0 });
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'en-US' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const tab = (name) => page.locator('nav button', { hasText: name }).click();
  const noSideScroll = async (where) => {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `${where}: page scrolls sideways by ${over}px`);
  };

  try {
    await page.goto(url);
    await page.getByLabel('Your name').fill('Sam');
    await page.getByLabel('Passcode').fill('test-passcode');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByRole('heading', { name: 'Receive a donation' }).waitFor();

    // People: quick taps show at once and are saved together, as one row.
    await tab('People');
    const more = page.getByRole('button', { name: 'Took food: One more' });
    await more.click();
    await more.click();
    await more.click();
    await page.getByRole('button', { name: 'Took food: One fewer' }).click();
    assert.equal(await page.locator('.people-number').nth(1).innerText(), '2');
    await page.getByRole('button', { name: 'Donated: One more' }).click();
    assert.equal(await page.locator('.people-number').nth(0).innerText(), '1');
    await page.locator('.day-row:not(.day-head)').first().waitFor({ timeout: 5000 });
    await page.waitForFunction(() => document.querySelector('.day-row:not(.day-head)').innerText.replace(/\s+/g, ' ').endsWith('1 2'), null, { timeout: 5000 });
    assert.equal(backend.tab('Люди').rows().length, 2);
    await page.screenshot({ path: path.join(OUT, '6-people.png') });
    await noSideScroll('people');

    // The count can't go below zero, and the button says so by doing nothing.
    await page.getByLabel('Date').fill('2020-01-01');
    const fewer = page.getByRole('button', { name: 'Took food: One fewer' });
    await fewer.click();
    assert.equal(await page.locator('.people-number').nth(1).innerText(), '0');
    assert.equal(backend.tab('Люди').rows().length, 2);

    // Money in and out, then undo.
    await tab('Money');
    await page.getByRole('button', { name: '+ Money in' }).click();
    await page.getByText('Please enter the amount').waitFor();
    await page.getByLabel('Amount').fill('5000');
    await page.getByRole('button', { name: '+ Money in' }).click();
    await page.getByText('Saved: +5,000.').waitFor();
    await page.getByLabel('Amount').fill('1666');
    await page.getByLabel('Note').fill('закуп');
    await page.getByRole('button', { name: '− Money out' }).click();
    await page.getByText('Saved: -1,666.').waitFor();
    await page.locator('.balance').getByText('3,334').waitFor();
    await page.screenshot({ path: path.join(OUT, '7-money.png'), fullPage: true });
    await noSideScroll('money');
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByText('Undone. The entry has been reversed.').waitFor();
    await page.locator('.balance').getByText('5,000').waitFor();
    assert.equal(backend.tab('Деньги').rows().length, 3);

    // Two equal gifts in a row are two entries.
    await page.getByLabel('Amount').fill('5000');
    await page.getByRole('button', { name: '+ Money in' }).click();
    await page.locator('.balance').getByText('10,000').waitFor();

    // A row pasted into the sheet that can't be read gets a warning.
    backend.tab('Деньги').getRange(10, 1, 1, 3).setValues([[100, 'вчера', '']]);
    await tab('Stock');
    await tab('Money');
    await page.getByText('Деньги tab of the sheet could not be read').waitFor();
    assert.match(await page.locator('.notice.warn').innerText(), /row 10/);

    // Correcting a count opens a popup first, and Cancel changes nothing.
    backend.call('receive', { opId: 'e2eseed0001', barcode: BARCODE, qty: 6, product: { name: 'Canned beans' } });
    await tab('Stock');
    const row = page.locator('.row', { hasText: 'Canned beans' });
    await row.getByRole('button', { name: 'Edit amount' }).click();
    const popup = page.locator('dialog');
    await popup.getByText('Available now: 6').waitFor();
    await page.screenshot({ path: path.join(OUT, '8-edit-amount.png') });
    await popup.getByRole('button', { name: 'Cancel' }).click();
    await popup.waitFor({ state: 'detached' });
    assert.equal(backend.tab('Журнал').rows().length, 1);

    await row.getByRole('button', { name: 'Edit amount' }).click();
    await popup.getByLabel('Quantity').fill('5');
    await popup.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Canned beans: 5 available now.').waitFor();
    assert.equal(backend.tab('Журнал').rows().at(-1)['Кол-во'], -1);
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByText('Undone. The stock is back as it was.').waitFor();
    await row.locator('.count.available b').getByText('6').waitFor();

    // Zero is allowed, and a count someone else just changed is refused.
    await row.getByRole('button', { name: 'Edit amount' }).click();
    backend.call('receive', { opId: 'e2eseed0002', barcode: BARCODE, qty: 1 });
    await popup.getByLabel('Quantity').fill('0');
    await popup.getByRole('button', { name: 'Save' }).click();
    await page.getByText('Someone just changed Canned beans: 7 are available now.').waitFor();
    assert.equal(backend.tab('Журнал').rows().at(-1)['Кол-во'], 1);

    // All six tab names fit, in every language, on a small phone.
    await page.setViewportSize({ width: 320, height: 640 });
    for (const language of ['ru', 'sr', 'en']) {
      await page.locator('.lang-select').selectOption(language);
      const clipped = await page.locator('nav button').evaluateAll((all) => all.filter((b) => b.scrollWidth > b.clientWidth).map((b) => b.textContent));
      assert.deepEqual(clipped, [], `${language}: tab names cut off`);
      await noSideScroll(`nav in ${language}`);
    }
    await page.locator('.lang-select').selectOption('ru');
    await tab('Деньги');
    await page.screenshot({ path: path.join(OUT, '9-money-ru-320.png') });
    await tab('Люди');
    await page.getByRole('heading', { name: 'Счётчик людей' }).waitFor();
    await noSideScroll('people in ru');

    assert.deepEqual(errors, []);
  } catch (err) {
    await page.screenshot({ path: path.join(OUT, 'ledger-failure.png'), fullPage: true }).catch(() => {});
    throw err;
  } finally {
    await browser.close();
    server.close();
  }
});
