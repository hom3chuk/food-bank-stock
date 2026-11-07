'use strict';

/* ---------- Small helpers ---------- */

function h(tag, props, ...children) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [key, value] of Object.entries(props || {})) {
    if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'value') el.value = value;
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false && value !== null && value !== undefined) el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) el.append(child);
  }
  return el;
}

const store = {
  get(key) { try { return localStorage.getItem(key) || ''; } catch { return ''; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* Private mode: stays for this visit only. */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* Nothing stored. */ } },
};

function newOpId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function normCode(value) {
  const code = String(value).trim();
  return /^0\d{12}$/.test(code) ? code.slice(1) : code;
}

/** Cleans up a typed code. Labels print digits in groups, like 5 012345 678900. */
function cleanTyped(value) {
  const code = String(value).replace(/\s+/g, '');
  return /^[\d-]+$/.test(code) ? code.replace(/-/g, '') : code;
}

function checkDigitOk(digits) {
  let sum = 0;
  for (let i = digits.length - 2, weight = 3; i >= 0; i--, weight = 4 - weight) sum += Number(digits[i]) * weight;
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

/** Short UPC-E labels get their check digit from the full 12-digit code, not from these 8 digits. */
function expandUpcE(code) {
  const [n, a, b, c, d, e, x, check] = code;
  if (x <= '2') return `${n}${a}${b}${x}0000${c}${d}${e}${check}`;
  if (x === '3') return `${n}${a}${b}${c}00000${d}${e}${check}`;
  if (x === '4') return `${n}${a}${b}${c}${d}00000${e}${check}`;
  return `${n}${a}${b}${c}${d}${e}0000${x}${check}`;
}

/** Whether a number passes the check every shop barcode carries. Codes with letters can't be checked. */
function barcodeLooksRight(code) {
  if (!/^\d+$/.test(code)) return true;
  if (![8, 12, 13, 14].includes(code.length)) return false;
  if (checkDigitOk(code)) return true;
  return code.length === 8 && /^[01]/.test(code) && checkDigitOk(expandUpcE(code));
}

function buzz() {
  if (navigator.vibrate) navigator.vibrate(60);
}

// Phones only allow sound once the person has touched the page, and may suspend it later.
let audio = null;

function wakeAudio() {
  try {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    if (!audio) audio = new Context();
    if (audio.state === 'suspended') audio.resume().catch(() => {});
  } catch { /* The app works without sound. */ }
}

['pointerdown', 'touchend', 'click', 'keydown'].forEach((type) => document.addEventListener(type, wakeAudio, true));

function beep() {
  wakeAudio();
  if (!audio) return;
  try {
    const tone = audio.createOscillator();
    const volume = audio.createGain();
    const now = audio.currentTime;
    tone.frequency.value = 880;
    volume.gain.setValueAtTime(0.0001, now);
    volume.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
    volume.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
    tone.connect(volume).connect(audio.destination);
    tone.start(now);
    tone.stop(now + 0.16);
  } catch { /* The app works without sound. */ }
}

let flashTimer = null;

/** Flashes the camera view green with a short message. Does nothing while the camera is off. */
function flashScan(text) {
  const flash = document.querySelector('.scanner:not(.scanner-idle) .scan-flash');
  if (!flash) return;
  clearTimeout(flashTimer);
  flash.firstChild.textContent = text;
  flash.hidden = true;
  // Showing it again restarts the animation, so scanning quickly flashes every time.
  void flash.offsetWidth;
  flash.hidden = false;
  flashTimer = setTimeout(() => { flash.hidden = true; }, 1500);
}

function confirmAdded(name) {
  beep();
  buzz();
  flashScan(t('scan.added', { name }));
}

/** Counts one more of an item. Lists show the end of the array first, so it appears at the top. */
function addScanned(items, barcode, details) {
  const at = items.findIndex((i) => i.barcode === barcode);
  const item = at >= 0 ? items.splice(at, 1)[0] : { barcode, ...details, qty: 0 };
  item.qty += 1;
  items.push(item);
}

/* ---------- Language ---------- */

const { languages: LANGUAGES, strings: STRINGS } = window.I18N;

function detectLanguage() {
  const saved = store.get('fb_lang');
  if (STRINGS[saved]) return saved;
  for (const tag of navigator.languages || []) {
    const base = tag.toLowerCase().split('-')[0];
    if (STRINGS[base]) return base;
  }
  return 'en';
}

let lang = detectLanguage();

function htmlLang() {
  return LANGUAGES.find((l) => l.id === lang).htmlLang;
}

/** Looks up text in the current language. A value with one/few/many/other is chosen by params.n. */
function t(key, params = {}) {
  let text = STRINGS[lang][key] ?? STRINGS.en[key] ?? key;
  if (typeof text === 'object') {
    text = text[new Intl.PluralRules(htmlLang()).select(params.n)] ?? text.other;
  }
  return text.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : params[name]));
}

/** Text to show later: a notice stays correct if the volunteer switches language while it is up. */
function say(key, params) {
  return () => t(key, params);
}

function applyLanguage() {
  document.documentElement.lang = htmlLang();
  document.title = t('app.title');
}

function setLanguage(id) {
  lang = id;
  store.set('fb_lang', id);
  applyLanguage();
  render();
}

/* The sheet is in Russian, so categories are saved in Russian and shown in the volunteer's language. */
const CATEGORIES = ['Tinned food', 'Dry goods', 'Fresh produce', 'Dairy', 'Bread and bakery', 'Drinks', 'Baby', 'Toiletries', 'Other'];

function categoryLabel(value) {
  const id = CATEGORIES.find((c) => STRINGS.ru['cat.' + c] === value);
  return id ? t('cat.' + id) : value || '';
}

/* A status typed into the sheet by hand has no translation, so it is shown as written. */
function statusLabel(status) {
  return STRINGS.en['status.' + status] ? t('status.' + status) : status;
}

function packetRange(numbers) {
  if (numbers.length === 1) return String(numbers[0]);
  return t('pack.range', { from: numbers[0], to: numbers[numbers.length - 1] });
}

/* ---------- App state ---------- */

const app = {
  root: document.getElementById('app'),
  tab: 'receive',
  passcode: store.get('fb_passcode'),
  volunteer: store.get('fb_volunteer'),
  data: null,
  notice: null, // { kind, text: function returning the text, undoOp }
  busy: false,
  view: {}, // Per-tab screen state, kept when switching tabs.
};

function product(code) {
  return (app.data && app.data.products.find((p) => p.barcode === code)) || null;
}

/* ---------- API ---------- */

class ApiFailure extends Error {
  constructor(body) {
    super(body.key);
    this.code = body.code;
    this.body = body;
    this.say = () => {
      const params = { ...body.params };
      if (params.status) params.status = statusLabel(params.status);
      const key = 'err.' + body.key;
      return STRINGS.en[key] ? t(key, params) : t('err.generic');
    };
  }
}

async function api(action, payload) {
  const url = window.FOOD_BANK_CONFIG && window.FOOD_BANK_CONFIG.apiUrl;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  let response;
  try {
    // text/plain avoids a CORS preflight, which Apps Script cannot answer.
    response = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...payload, action, passcode: app.passcode, volunteer: app.volunteer }),
      signal: controller.signal,
    });
  } catch {
    throw new ApiFailure({ code: 'NETWORK', key: 'network' });
  } finally {
    clearTimeout(timer);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new ApiFailure({ code: 'NETWORK', key: 'badReply' });
  }
  if (!body.ok) throw new ApiFailure(body);
  if (body.state) app.data = body.state;
  return body;
}

/** Runs a request behind the loading overlay. Returns the reply, or null after showing the error. */
async function request(action, payload) {
  setBusy(true);
  try {
    return await api(action, payload);
  } catch (err) {
    if (err.code === 'BAD_PASSCODE') {
      signOut(say('err.passcodeChanged'));
    } else if (err.code !== 'INSUFFICIENT') {
      showNotice('bad', err.say);
    } else {
      throw err;
    }
    return null;
  } finally {
    setBusy(false);
  }
}

function setBusy(on) {
  app.busy = on;
  const existing = document.querySelector('.loading');
  if (on && !existing) document.body.append(h('div.loading', { role: 'status' }, t('app.loading')));
  if (!on && existing) existing.remove();
}

async function refreshInBackground() {
  try {
    await api('bootstrap');
    renderKeepingInputs();
  } catch { /* Old data stays visible, and the next save still checks with the sheet. */ }
}

/* Background refreshes should only redraw the screens that have no half-filled form. */
function renderKeepingInputs() {
  const receiving = app.tab === 'receive' && app.view.receive;
  if (app.tab === 'pack' || receiving || app.view.edit) return;
  if (scanner.isOn() || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
  render();
}

/* ---------- Notices ---------- */

function showNotice(kind, text, undoOp) {
  app.notice = { kind, text, undoOp };
  const slot = document.getElementById('notice-slot');
  if (slot) {
    slot.replaceChildren(noticeEl());
    slot.scrollIntoView({ block: 'nearest' });
  }
}

function noticeEl() {
  if (!app.notice) return '';
  const { kind, text, undoOp } = app.notice;
  return h(`div.notice.${kind}`, { role: kind === 'bad' ? 'alert' : 'status' },
    h('span', null, text()),
    undoOp ? h('button', { onclick: () => undo(undoOp) }, t('common.undo')) : null);
}

async function undo(targetOp) {
  const opId = newOpId();
  const reply = await request('undo', { opId, targetOp });
  if (!reply) return;
  if (app.tab === 'receive') app.view.receive = null;
  app.notice = { kind: 'good', text: say(app.tab === 'money' ? 'money.undone' : 'common.undone') };
  render();
}

/* ---------- Barcode scanner ---------- */

const scanner = (() => {
  let instance = null;
  let running = false;
  let chain = Promise.resolve();
  let lastRead = '';

  function enqueue(task) {
    chain = chain.then(task).catch(() => {});
    return chain;
  }

  function formats() {
    const f = window.Html5QrcodeSupportedFormats;
    return [f.EAN_13, f.EAN_8, f.UPC_A, f.UPC_E, f.CODE_128];
  }

  function make(regionId) {
    return new window.Html5Qrcode(regionId, {
      formatsToSupport: formats(),
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      verbose: false,
    });
  }

  // Phone cameras can't focus up close. Zoom lets the barcode look big from further away.
  // Not every phone offers these, and the scanner still works without them.
  function helpFocus(reader) {
    try {
      const can = reader.getRunningTrackCapabilities();
      const advanced = [];
      if (can.focusMode && can.focusMode.includes('continuous')) advanced.push({ focusMode: 'continuous' });
      if (can.zoom) advanced.push({ zoom: Math.min(2, can.zoom.max) });
      if (advanced.length) reader.applyVideoConstraints({ advanced }).catch(() => {});
    } catch { /* This browser can't report what its camera supports. */ }
  }

  function stop() {
    return enqueue(async () => {
      if (!instance) return;
      const current = instance;
      instance = null;
      running = false;
      try { await current.stop(); } catch { /* Already stopped. */ }
      try { current.clear(); } catch { /* Region already removed. */ }
    });
  }

  function start(regionId, onCode, onError) {
    stop();
    return enqueue(async () => {
      const region = document.getElementById(regionId);
      if (!region) return;
      lastRead = '';
      const reader = make(regionId);
      instance = reader;
      let started;
      try {
        started = reader.start(
          { facingMode: 'environment' },
          {
            fps: 10,
            videoConstraints: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1440 } },
            qrbox: (w, height) => ({ width: Math.max(50, Math.floor(w * 0.8)), height: Math.max(50, Math.floor(Math.min(height * 0.45, w * 0.5))) }),
          },
          (text) => {
            // Two matching reads in a row filters out most misreads of worn labels.
            if (text !== lastRead) { lastRead = text; return; }
            onCode(normCode(text));
          },
          () => {},
        );
        // If the screen changes while the camera is starting, the library may never finish.
        // Stop waiting, or every later scan would queue behind this one forever.
        let poll;
        const screenChanged = new Promise((_, reject) => {
          poll = setInterval(() => { if (!region.isConnected) reject(new Error('Screen changed')); }, 200);
        });
        try {
          await Promise.race([started, screenChanged]);
        } finally {
          clearInterval(poll);
        }
        running = true;
        helpFocus(reader);
      } catch {
        instance = null;
        running = false;
        if (started) started.then(() => reader.stop()).catch(() => {});
        if (region.isConnected) onError();
      }
    });
  }

  async function scanPhoto(file, regionId) {
    await stop();
    const reader = make(regionId);
    try {
      return normCode(await reader.scanFile(file, false));
    } finally {
      try { reader.clear(); } catch { /* Nothing to clear. */ }
    }
  }

  return { start, stop, scanPhoto, isOn: () => running };
})();

/**
 * The three ways to enter a code: live camera, photo, or typing.
 * `continuous` keeps the camera on after each read, for filling a packet.
 */
function codeEntry({ onCode, continuous, autoStart, ignore }) {
  const regionId = 'scan-region';
  // The scanner library shrinks each frame to the on-screen size of its box before reading it,
  // which loses the bars of a barcode that isn't filling the view. So it gets a large surface,
  // scaled down to fit the screen. (A CSS transform doesn't change the size the library sees.)
  const region = h('div.scan-surface', { id: regionId });
  const viewfinder = h('div.scanner.scanner-idle', null, region,
    h('div.scan-flash', { hidden: true, role: 'status' }, h('span')));
  const hint = h('p.muted', { hidden: true }, t('scan.hint'));
  let lastCode = '';
  let lastAt = 0;

  function fitViewfinder() {
    const scale = viewfinder.clientWidth / region.offsetWidth;
    const full = region.offsetHeight * scale;
    // A tall camera picture is cropped evenly, keeping the box in view and the buttons on screen.
    const visible = Math.min(full, window.innerHeight * 0.55);
    viewfinder.style.height = full ? `${visible}px` : '';
    region.style.transform = `translateY(${(visible - full) / 2}px) scale(${scale})`;
  }
  const fitter = new ResizeObserver(fitViewfinder);
  fitter.observe(viewfinder);
  fitter.observe(region);

  const toggle = h('button.btn.primary', { type: 'button', onclick: () => (scanner.isOn() ? turnOff() : turnOn()) }, t('scan.start'));

  function deliver(code) {
    const now = Date.now();
    if (ignore && code === ignore.code && now < ignore.until) return;
    if (continuous) {
      // Every read of the same code restarts the wait, so it must leave view before counting again.
      const repeat = code === lastCode && now - lastAt < 1800;
      lastCode = code;
      lastAt = now;
      if (repeat) return;
      onCode(code);
      return;
    }
    if (lastCode) return;
    lastCode = code;
    // Nothing is saved yet, because the form comes next. Pause so the flash can be seen.
    const known = product(code);
    beep();
    buzz();
    flashScan(t('scan.scanned', { name: known ? known.name : code }));
    setTimeout(() => {
      if (!viewfinder.isConnected) return;
      scanner.stop().then(() => onCode(code, true));
    }, 500);
  }

  function turnOn() {
    viewfinder.classList.remove('scanner-idle');
    toggle.textContent = t('scan.starting');
    toggle.disabled = true;
    lastCode = '';
    scanner.start(regionId, deliver, () => {
      viewfinder.classList.add('scanner-idle');
      showNotice('warn', say('scan.cameraFailed'));
    }).then(() => {
      toggle.disabled = false;
      toggle.textContent = scanner.isOn() ? t('scan.stop') : t('scan.start');
      hint.hidden = !scanner.isOn();
    });
  }

  function turnOff() {
    scanner.stop().then(() => {
      viewfinder.classList.add('scanner-idle');
      toggle.textContent = t('scan.start');
      hint.hidden = true;
    });
  }

  const photoInput = h('input', {
    type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden-region', tabindex: '-1', 'aria-hidden': 'true',
    onchange: async (event) => {
      const file = event.target.files[0];
      event.target.value = '';
      if (!file) return;
      viewfinder.classList.add('scanner-idle');
      toggle.textContent = t('scan.start');
      hint.hidden = true;
      try {
        const code = await scanner.scanPhoto(file, regionId);
        if (!continuous) { beep(); buzz(); }
        onCode(code);
      } catch {
        showNotice('warn', say('scan.noCodeInPhoto'));
      }
    },
  });

  const typed = h('input', { inputmode: 'numeric', autocomplete: 'off', placeholder: t('scan.typePlaceholder'), 'aria-label': t('scan.typeLabel') });
  const typedForm = h('form.inline-form', {
    onsubmit: (event) => {
      event.preventDefault();
      const value = cleanTyped(typed.value);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
        showNotice('warn', say('scan.badTyped'));
        return;
      }
      const code = normCode(value);
      // Some real labels, such as a shop's own, fail this check, so the volunteer can still go ahead.
      if (!product(code) && !barcodeLooksRight(code) && !window.confirm(t('scan.checkTyped', { code }))) return;
      typed.value = '';
      onCode(code);
    },
  }, typed, h('button.btn', { type: 'submit' }, t('scan.go')));

  if (autoStart) setTimeout(turnOn, 0);

  return [
    viewfinder,
    hint,
    toggle,
    h('button.btn', { type: 'button', onclick: () => photoInput.click() }, t('scan.photo')),
    photoInput,
    typedForm,
  ];
}

/* ---------- Shared form parts ---------- */

function qtyInput(initial, min) {
  const input = h('input', { type: 'number', inputmode: 'numeric', min: String(min), step: '1', value: String(initial), 'aria-label': t('common.quantity') });
  const bump = (by) => { input.value = String(Math.max(min, (parseInt(input.value, 10) || 0) + by)); };
  const el = h('div', { style: 'display:grid;gap:8px' },
    h('div.stepper', null,
      h('button', { type: 'button', 'aria-label': t('common.oneFewer'), onclick: () => bump(-1) }, '−'),
      input,
      h('button', { type: 'button', 'aria-label': t('common.oneMore'), onclick: () => bump(1) }, '+')),
    h('div.quick', null, [5, 10, 12, 24].map((n) => h('button', { type: 'button', onclick: () => bump(n) }, '+' + n))));
  return {
    el,
    read() {
      const q = Number(input.value);
      return Number.isInteger(q) && q >= min ? q : null;
    },
  };
}

function countsEl(p) {
  const cell = (cls, label, value) => h(`div.count.${cls}${value < 0 ? '.negative' : ''}`, null, h('b', null, String(value)), label);
  return h('div.counts', null,
    cell('available', t('count.available'), p.available),
    cell('packed', t('count.packed'), p.packed),
    cell('given', t('count.given'), p.given));
}

function searchList({ placeholder, onPick, emptyText }) {
  const results = h('div.list');
  const input = h('input', { type: 'search', placeholder, 'aria-label': placeholder, oninput: draw });
  function draw() {
    const q = input.value.trim().toLowerCase();
    const items = (app.data.products || [])
      .filter((p) => !q || p.name.toLowerCase().includes(q) || p.barcode.toLowerCase().includes(q) || String(p.category || '').toLowerCase().includes(q) || categoryLabel(p.category).toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name, htmlLang()));
    results.replaceChildren(...(items.length
      ? items.map((p) => onPick(p))
      : [h('p.muted', null, emptyText)]));
  }
  draw();
  return [input, results];
}

/* ---------- Receive ---------- */

function resolveProduct(code, then) {
  if (product(code)) { then(); return; }
  // Another volunteer may have just added it, so check the sheet before asking for details.
  request('bootstrap').then(() => then());
}

function receiveScreen() {
  const v = app.view.receive;
  if (v && v.code !== undefined) return product(v.code) ? receiveKnown(v) : receiveNew(v);
  if (v && v.picker) return receivePicker();

  return [
    h('div.card', null,
      h('h2', null, t('receive.title')),
      h('p.muted', null, t('receive.intro')),
      codeEntry({
        autoStart: Boolean(v && v.resume),
        ignore: v && v.ignore,
        onCode: (code, fromCamera) => resolveProduct(code, () => { app.view.receive = { code, opId: newOpId(), fromCamera }; render(); }),
      })),
    h('button.btn', { onclick: () => { app.view.receive = { picker: true }; render(); } }, t('receive.noBarcode')),
  ];
}

function backToScan(resume) {
  app.view.receive = resume ? { resume: true } : null;
  render();
}

function receiveKnown(v) {
  const p = product(v.code);
  const qty = qtyInput(1, 1);
  return h('form.card', {
    onsubmit: async (event) => {
      event.preventDefault();
      const n = qty.read();
      if (!n) { showNotice('warn', say('common.enterQuantity')); return; }
      await saveReceive(v, { barcode: v.code, qty: n });
    },
  },
  h('div', null,
    h('h2', null, p.name),
    h('p.muted.mono', null, [categoryLabel(p.category), v.code.startsWith('NB-') ? t('receive.noBarcodeTag') : v.code].filter(Boolean).join(' · ')),
    p.description ? h('p.muted', null, p.description) : null),
  countsEl(p),
  h('label', null, t('receive.howMany'), qty.el),
  h('button.btn.primary', { type: 'submit' }, t('common.save')),
  h('button.btn', { type: 'button', onclick: () => backToScan(false) }, t('common.cancel')));
}

function receiveNew(v) {
  const name = h('input', { required: true, maxlength: '120', autocomplete: 'off', placeholder: t('receive.namePlaceholder') });
  const category = h('select', null,
    h('option', { value: '' }, t('receive.categoryNone')),
    CATEGORIES.map((c) => h('option', { value: STRINGS.ru['cat.' + c] }, t('cat.' + c))));
  const description = h('textarea', { maxlength: '300', placeholder: t('receive.descriptionPlaceholder') });
  const qty = qtyInput(1, 1);
  return h('form.card', {
    onsubmit: async (event) => {
      event.preventDefault();
      const n = qty.read();
      if (!n) { showNotice('warn', say('common.enterQuantity')); return; }
      await saveReceive(v, {
        barcode: v.code || undefined,
        qty: n,
        product: { name: name.value, category: category.value, description: description.value },
      });
    },
  },
  h('div', null,
    h('h2', null, v.code ? t('receive.newProduct') : t('receive.newNoBarcode')),
    h('p.muted.mono', null, v.code ? t('receive.notInSheet', { code: v.code }) : t('receive.ownCode'))),
  h('label', null, t('receive.name'), name),
  h('label', null, t('receive.category'), category),
  h('label', null, t('receive.description'), description),
  h('label', null, t('receive.howMany'), qty.el),
  h('button.btn.primary', { type: 'submit' }, t('receive.addAndSave')),
  h('button.btn', { type: 'button', onclick: () => backToScan(false) }, t('common.cancel')));
}

async function saveReceive(v, payload) {
  const reply = await request('receive', { ...payload, opId: v.opId });
  if (!reply) return;
  const { name, qty } = reply.result;
  beep();
  app.notice = { kind: 'good', text: say('receive.added', { qty, name }), undoOp: reply.opId };
  // Only a live scan turns the camera back on. If the number was typed, the camera may be broken,
  // and its warning would replace this confirmation and its Undo button.
  // The camera comes back on still pointing at this item, so give the volunteer time to move on.
  app.view.receive = v.fromCamera ? { resume: true, ignore: { code: reply.result.barcode, until: Date.now() + 4000 } } : null;
  render();
}

function receivePicker() {
  return h('div.card', null,
    h('h2', null, t('receive.noBarcode')),
    h('button.btn.primary', { onclick: () => { app.view.receive = { code: '', opId: newOpId() }; render(); } }, t('receive.addNew')),
    h('h3', null, t('receive.orChoose')),
    searchList({
      placeholder: t('common.searchProducts'),
      emptyText: t('common.noProducts'),
      onPick: (p) => h('button.row', { onclick: () => { app.view.receive = { code: p.barcode, opId: newOpId() }; render(); } },
        h('span.row-main', null, h('span.row-title', null, p.name)),
        h('span.muted', null, t('common.availableCount', { n: p.available }))),
    }),
    h('button.btn', { onclick: () => backToScan(false) }, t('common.back')));
}

/* ---------- Pack ---------- */

function shortageLines(err) {
  return err.body.shortages.map((s) => t('shortage.line', s)).join('\n');
}

function packDraft() {
  if (!app.view.pack) app.view.pack = { items: [], count: 1, opId: newOpId() };
  return app.view.pack;
}

function packScreen() {
  const draft = packDraft();
  if (draft.done) return packDone(draft.done);

  const listEl = h('div.list');
  const submit = h('button.btn.primary', { type: 'button', onclick: () => savePack(false) }, '');
  const countInput = h('input', {
    type: 'number', inputmode: 'numeric', min: '1', max: '500', step: '1', value: String(draft.count),
    oninput: () => { draft.count = Number(countInput.value); drawSummary(); },
  });
  const summary = h('p.muted');
  const editNumber = h('input', { type: 'number', inputmode: 'numeric', min: '1', step: '1', placeholder: t('give.packetPlaceholder'), 'aria-label': t('edit.numberLabel') });

  function drawSummary() {
    const units = draft.items.reduce((sum, i) => sum + i.qty, 0);
    const valid = Number.isInteger(draft.count) && draft.count >= 1 && draft.count <= 500;
    submit.disabled = !units || !valid;
    submit.textContent = valid && draft.count > 1 ? t('pack.createMany', { n: draft.count }) : t('pack.createOne');
    summary.textContent = units ? t('pack.perPacket', { n: units }) : t('pack.scanPrompt');
  }

  function drawItems() {
    listEl.replaceChildren(...[...draft.items].reverse().map((item) => {
      const p = product(item.barcode);
      return h('div.row', null,
        h('div.row-main', null,
          h('div.row-title', null, p ? p.name : item.barcode),
          h('div.muted', null, p ? t('common.availableCount', { n: p.available }) : '')),
        h('div.mini-stepper', null,
          h('button', { type: 'button', 'aria-label': t('common.oneFewer'), onclick: () => changeItem(item, -1) }, '−'),
          h('span', null, String(item.qty)),
          h('button', { type: 'button', 'aria-label': t('common.oneMore'), onclick: () => changeItem(item, 1) }, '+')));
    }));
    drawSummary();
  }

  function changeItem(item, by) {
    item.qty += by;
    draft.items = draft.items.filter((i) => i.qty > 0);
    draft.opId = newOpId();
    drawItems();
  }

  function addCode(code) {
    resolveProduct(code, () => {
      if (!product(code)) {
        showNotice('warn', say('common.notReceived', { code }));
        return;
      }
      addScanned(draft.items, code);
      draft.opId = newOpId();
      app.notice = null;
      const slot = document.getElementById('notice-slot');
      if (slot) slot.replaceChildren();
      drawItems();
      confirmAdded(product(code).name);
    });
  }

  async function savePack(force) {
    let reply;
    try {
      reply = await request('pack', { opId: draft.opId, items: draft.items, count: draft.count, force });
    } catch (err) {
      if (window.confirm(t('pack.shortageConfirm', { lines: shortageLines(err) }))) await savePack(true);
      return;
    }
    if (!reply) return;
    draft.done = { numbers: reply.result.numbers, contents: reply.result.contents, opId: reply.opId };
    render();
  }

  drawItems();

  return [
    h('div.card', null,
      h('h2', null, t('pack.title')),
      summary,
      codeEntry({ continuous: true, onCode: addCode }),
      listEl,
      h('button.btn', {
        type: 'button',
        onclick: () => openPackPicker(addCode),
      }, t('common.addNoBarcode'))),
    h('div.card', null,
      h('label', null, t('pack.howManyPackets'), countInput),
      submit),
    h('div.card', null,
      h('h3', null, t('edit.openTitle')),
      h('form.inline-form', {
        onsubmit: (event) => {
          event.preventDefault();
          const n = Number(editNumber.value);
          if (!Number.isInteger(n) || n < 1) { showNotice('warn', say('give.typeNumber')); return; }
          openEditor(n);
        },
      }, editNumber, h('button.btn', { type: 'submit' }, t('edit.open')))),
  ];
}

function openPackPicker(addCode) {
  const dialog = h('dialog', { style: 'width:min(92vw,520px);max-height:80vh;border:0;border-radius:12px;padding:16px' },
    h('div', { style: 'display:grid;gap:12px' },
      h('h2', null, t('pack.chooseItem')),
      searchList({
        placeholder: t('common.searchProducts'),
        emptyText: t('pack.noneToChoose'),
        onPick: (p) => h('button.row', { onclick: () => { dialog.close(); addCode(p.barcode); } },
          h('span.row-main', null, h('span.row-title', null, p.name)),
          h('span.muted', null, t('common.availableCount', { n: p.available }))),
      }),
      h('button.btn', { onclick: () => dialog.close() }, t('common.close'))));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

function packDone({ numbers, contents, opId }) {
  return h('div.card', null,
    h('h2', null, numbers.length === 1 ? t('pack.createdOne') : t('pack.createdMany', { n: numbers.length })),
    h('div.number-callout', null,
      h('span', null, numbers.length === 1 ? t('pack.writeOne') : t('pack.writeMany')),
      h('strong.mono', null, packetRange(numbers))),
    h('p', null, contents),
    h('button.btn.primary', { onclick: () => { app.view.pack = null; app.notice = null; render(); } }, t('pack.another')),
    h('button.btn.danger', {
      onclick: async () => {
        const reply = await request('undo', { opId: newOpId(), targetOp: opId });
        if (!reply) return;
        app.view.pack = null;
        app.notice = { kind: 'good', text: say('pack.cancelled') };
        render();
      },
    }, t('pack.undo')));
}

/* ---------- Give out: one basket per person ---------- */

function giveDraft() {
  if (!app.view.give) {
    let saved = null;
    try { saved = JSON.parse(store.get('fb_handout')); } catch { /* No basket saved. */ }
    app.view.give = saved && Array.isArray(saved.packets) && Array.isArray(saved.items)
      ? { removed: {}, ...saved }
      : { packets: [], items: [], removed: {}, opId: newOpId() };
  }
  return app.view.give;
}

/* The basket is saved on the phone, so a locked screen or reload mid-visit loses nothing. */
function saveDraft(draft, changed) {
  if (changed) draft.opId = newOpId();
  store.set('fb_handout', JSON.stringify({ packets: draft.packets, items: draft.items, removed: draft.removed, opId: draft.opId }));
}

function clearDraft() {
  app.view.give = null;
  store.remove('fb_handout');
}

function giveScreen() {
  const draft = giveDraft();
  if (draft.detail) return packetDetail(draft);

  const packetRows = h('div.list');
  const itemRows = h('div.list');
  const shelfRows = h('div.list');
  const shelfTitle = h('h3');
  const emptyNote = h('p.muted', null, t('give.nothingYet'));
  const finish = h('button.btn.primary', { type: 'button', onclick: () => saveHandout(false) }, t('give.finish'));
  const clear = h('button.btn', {
    type: 'button',
    onclick: () => {
      if (window.confirm(t('give.emptyConfirm'))) {
        clearDraft();
        app.notice = null;
        render();
      }
    },
  }, t('give.emptyBasket'));
  const barText = h('span');
  const basketCard = h('div.card', { id: 'basket' },
    h('h2', null, t('give.basket')), emptyNote, itemRows, packetRows, finish, clear);
  const bar = h('div.basket-bar', null, barText,
    h('button', { type: 'button', onclick: () => basketCard.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, t('give.review')));

  function draw() {
    const units = draft.items.reduce((sum, i) => sum + i.qty, 0);
    const empty = !draft.packets.length && !units;

    packetRows.replaceChildren(...draft.packets.map((n) => {
      const packet = app.data.packets.find((p) => p.number === n);
      const contents = packet ? packet.items : [];
      const removed = draft.removed[n] || {};
      const kept = contents.reduce((sum, i) => sum + i.qty - (removed[i.barcode] || 0), 0);
      return h('div.packet', null,
        h('div.row', null,
          h('div.row-title.row-main', null, t('give.packet', { n })),
          h('button.small', {
            type: 'button',
            'aria-label': t('give.removePacketLabel', { n }),
            onclick: () => {
              draft.packets = draft.packets.filter((x) => x !== n);
              delete draft.removed[n];
              saveDraft(draft, true);
              draw();
            },
          }, t('give.removePacket'))),
        contents.length ? null : h('div.muted', null, packet ? packet.contents : ''),
        contents.map((i) => {
          const back = removed[i.barcode] || 0;
          return h('div.packet-item', null,
            h('div.row-main', null,
              h('div', null, i.name),
              back ? h('div.short', null, t('give.backToShelf', { n: back })) : null),
            h('div.mini-stepper', null,
              h('button', {
                type: 'button',
                'aria-label': t('give.fewerInPacket', { name: i.name, n }),
                // A packet can't go out empty. Removing the packet covers that case.
                disabled: back >= i.qty || kept <= 1,
                onclick: () => changeRemoved(n, i.barcode, 1),
              }, '−'),
              h('span', null, String(Math.max(0, i.qty - back))),
              h('button', {
                type: 'button',
                'aria-label': t('give.moreInPacket', { name: i.name, n }),
                disabled: back === 0,
                onclick: () => changeRemoved(n, i.barcode, -1),
              }, '+')));
        }));
    }));

    itemRows.replaceChildren(...[...draft.items].reverse().map((item) => {
      const p = product(item.barcode);
      const short = p && item.qty > p.available;
      return h('div.row', null,
        h('div.row-main', null,
          h('div.row-title', null, p ? p.name : item.barcode),
          h(short ? 'div.short' : 'div.muted', null, p ? t('common.availableCount', { n: p.available }) : '')),
        h('div.mini-stepper', null,
          h('button', { type: 'button', 'aria-label': t('common.oneFewer'), onclick: () => changeItem(item, -1) }, '−'),
          h('span', null, String(item.qty)),
          h('button', { type: 'button', 'aria-label': t('common.oneMore'), onclick: () => changeItem(item, 1) }, '+')));
    }));

    const shelf = app.data.packetsOnShelf.filter((p) => !draft.packets.includes(p.number));
    shelfTitle.textContent = t('give.onShelf', { n: shelf.length });
    shelfRows.replaceChildren(...(shelf.length
      ? shelf.map((p) => h('button.row', { type: 'button', onclick: () => { draft.detail = p.number; render(); } },
        h('span.row-main', null,
          h('span.row-title', { style: 'display:block' }, t('give.packet', { n: p.number })),
          h('span.muted', null, p.contents))))
      : [h('p.muted', null, t('give.noOtherPackets'))]));

    emptyNote.hidden = !empty;
    finish.disabled = empty;
    clear.hidden = empty;
    bar.hidden = empty;
    const parts = [];
    if (draft.packets.length) parts.push(t('count.packets', { n: draft.packets.length }));
    if (units) parts.push(t('count.items', { n: units }));
    barText.textContent = t('give.bar', { parts: parts.join(', ') });
  }

  function changeItem(item, by) {
    item.qty += by;
    draft.items = draft.items.filter((i) => i.qty > 0);
    saveDraft(draft, true);
    draw();
  }

  function changeRemoved(number, barcode, by) {
    const removed = draft.removed[number] || (draft.removed[number] = {});
    removed[barcode] = (removed[barcode] || 0) + by;
    if (!removed[barcode]) delete removed[barcode];
    if (!Object.keys(removed).length) delete draft.removed[number];
    saveDraft(draft, true);
    draw();
  }

  function addItem(code) {
    resolveProduct(code, () => {
      if (!product(code)) {
        showNotice('warn', say('common.notReceived', { code }));
        return;
      }
      addScanned(draft.items, code);
      saveDraft(draft, true);
      draw();
      confirmAdded(product(code).name);
    });
  }

  const numberInput = h('input', { type: 'number', inputmode: 'numeric', min: '1', step: '1', placeholder: t('give.packetPlaceholder'), 'aria-label': t('give.packetLabel') });

  async function addPacket(event) {
    event.preventDefault();
    const n = Number(numberInput.value);
    if (!Number.isInteger(n) || n < 1) { showNotice('warn', say('give.typeNumber')); return; }
    if (draft.packets.includes(n)) { showNotice('warn', say('give.alreadyInBasket', { n })); return; }
    // Another volunteer may have just made or handed out this packet.
    await request('bootstrap');
    const packet = app.data.packets.find((p) => p.number === n);
    if (!packet) { showNotice('warn', say('give.noSuchPacket', { n })); return; }
    if (packet.status !== 'On shelf') { showNotice('warn', () => packetProblem(packet)); return; }
    draft.packets.push(n);
    saveDraft(draft, true);
    numberInput.value = '';
    app.notice = null;
    document.getElementById('notice-slot').replaceChildren();
    draw();
  }

  async function saveHandout(force) {
    const packets = draft.packets.slice();
    const items = draft.items.map((i) => ({ barcode: i.barcode, qty: i.qty }));
    const removals = packets.flatMap((n) => Object.entries(draft.removed[n] || {})
      .map(([barcode, qty]) => ({ packet: n, barcode, qty })));
    const putBack = removals.map((r) => {
      const item = app.data.packets.find((p) => p.number === r.packet).items.find((i) => i.barcode === r.barcode);
      return { qty: r.qty, name: item ? item.name : r.barcode };
    });
    let reply;
    try {
      reply = await request('handout', { opId: draft.opId, packets, items, removals, force });
    } catch (err) {
      if (window.confirm(t('give.shortageConfirm', { lines: shortageLines(err) }))) await saveHandout(true);
      return;
    }
    if (!reply) {
      // Usually a packet someone else just handed out. The basket stays so it can be fixed.
      refreshInBackground();
      return;
    }
    const units = items.reduce((sum, i) => sum + i.qty, 0);
    clearDraft();
    const text = () => {
      const packetText = packets.length ? t('give.packetList', { n: packets.length, list: packets.join(', ') }) : '';
      const itemText = units ? t('count.items', { n: units }) : '';
      const given = packetText && itemText
        ? t('give.doneBoth', { packets: packetText, items: itemText })
        : t('give.doneOne', { what: packetText || itemText });
      if (!putBack.length) return given;
      return given + ' ' + t('give.putBack', { items: putBack.map((i) => t('common.lineItem', i)).join(', ') });
    };
    app.notice = { kind: 'good', text, undoOp: reply.opId };
    render();
  }

  draw();

  return [
    h('div.card', null,
      h('h2', null, t('give.title')),
      h('h3', null, t('give.addPacket')),
      h('form.inline-form', { onsubmit: addPacket }, numberInput, h('button.btn', { type: 'submit' }, t('give.add')))),
    h('div.card', null,
      h('h3', null, t('give.fromShelves')),
      codeEntry({ continuous: true, onCode: addItem }),
      h('button.btn', { type: 'button', onclick: () => openPackPicker(addItem) }, t('common.addNoBarcode'))),
    basketCard,
    h('div.card', null, shelfTitle, shelfRows),
    bar,
  ];
}

function packetProblem(packet) {
  const { number, givenOn: date, givenBy: by, status } = packet;
  if (status === 'Given out' && date) return t(by ? 'give.givenOnBy' : 'give.givenOn', { number, date, by });
  return t('err.packetStatus', { number, status: statusLabel(status) });
}

function packetDetail(draft) {
  const number = draft.detail;
  const close = () => { draft.detail = null; render(); };
  const packet = app.data.packets.find((p) => p.number === number);
  if (!packet || packet.status !== 'On shelf') {
    return h('div.card', null,
      h('h2', null, t('give.packet', { n: number })),
      h('div.notice.warn', null, h('span', null, packet ? packetProblem(packet) : t('give.notInSheet'))),
      h('button.btn', { onclick: close }, t('common.back')));
  }
  return h('div.card', null,
    h('h2', null, t('give.packet', { n: number })),
    h('p', null, packet.contents),
    h('button.btn.primary', {
      onclick: () => {
        draft.packets.push(number);
        saveDraft(draft, true);
        close();
      },
    }, t('give.addToBasket')),
    h('button.btn', { onclick: () => openEditor(number) }, t('edit.button')),
    h('button.btn', {
      onclick: async () => {
        if (!window.confirm(t('give.unpackConfirm', { n: number }))) return;
        draft.unpackOp = draft.unpackOp || newOpId();
        const reply = await request('unpack', { opId: draft.unpackOp, number });
        if (!reply) return;
        draft.unpackOp = null;
        draft.detail = null;
        app.notice = { kind: 'good', text: say('give.unpacked', { n: number }), undoOp: reply.opId };
        render();
      },
    }, t('give.unpack')),
    h('button.btn', { onclick: close }, t('common.back')));
}

/* ---------- Edit a packet on the shelf ---------- */

async function openEditor(number) {
  // Check the sheet first, because another volunteer may have just changed or handed out this packet.
  await request('bootstrap');
  const packet = app.data.packets.find((p) => p.number === number);
  if (!packet) { showNotice('warn', say('give.noSuchPacket', { n: number })); return; }
  if (packet.status !== 'On shelf') { showNotice('warn', () => packetProblem(packet)); return; }
  if (app.view.give) app.view.give.detail = null;
  app.view.edit = {
    number,
    original: packet.items.map((i) => ({ barcode: i.barcode, name: i.name, qty: i.qty })),
    items: packet.items.map((i) => ({ barcode: i.barcode, name: i.name, qty: i.qty })),
    opId: newOpId(),
  };
  app.notice = null;
  render();
}

function editScreen() {
  const edit = app.view.edit;
  const number = edit.number;
  const originalQty = (code) => (edit.original.find((i) => i.barcode === code) || { qty: 0 }).qty;
  const close = () => { app.view.edit = null; render(); };

  const listEl = h('div.list');
  const emptyHint = h('div.notice.warn', null, h('span', null, t('edit.nowEmpty')));
  const saveButton = h('button.btn.primary', { type: 'button', onclick: () => save(false) }, t('edit.save'));

  function draw() {
    listEl.replaceChildren(...[...edit.items].reverse().map((item) => {
      const p = product(item.barcode);
      const short = p && item.qty - originalQty(item.barcode) > p.available;
      return h('div.row', null,
        h('div.row-main', null,
          h('div.row-title', null, p ? p.name : item.name),
          h(short ? 'div.short' : 'div.muted', null, p ? t('common.availableCount', { n: p.available }) : '')),
        h('div.mini-stepper', null,
          h('button', { type: 'button', 'aria-label': t('common.oneFewer'), onclick: () => change(item, -1) }, '−'),
          h('span', null, String(item.qty)),
          h('button', { type: 'button', 'aria-label': t('common.oneMore'), onclick: () => change(item, 1) }, '+')));
    }));
    const changed = edit.items.length !== edit.original.length
      || edit.items.some((i) => i.qty !== originalQty(i.barcode));
    emptyHint.hidden = edit.items.length > 0;
    saveButton.disabled = !edit.items.length || !changed;
  }

  function change(item, by) {
    item.qty += by;
    edit.items = edit.items.filter((i) => i.qty > 0);
    edit.opId = newOpId();
    draw();
  }

  function addCode(code) {
    resolveProduct(code, () => {
      const p = product(code);
      if (!p) { showNotice('warn', say('common.notReceived', { code })); return; }
      addScanned(edit.items, code, { name: p.name });
      edit.opId = newOpId();
      draw();
      confirmAdded(p.name);
    });
  }

  async function save(force) {
    const items = edit.items.map((i) => ({ barcode: i.barcode, qty: i.qty }));
    let reply;
    try {
      reply = await request('editPacket', { opId: edit.opId, number, items, force });
    } catch (err) {
      if (window.confirm(t('pack.shortageConfirm', { lines: shortageLines(err) }))) await save(true);
      return;
    }
    if (!reply) return;
    const putBack = edit.original
      .map((i) => {
        const now = edit.items.find((x) => x.barcode === i.barcode);
        return { name: i.name, qty: i.qty - (now ? now.qty : 0) };
      })
      .filter((i) => i.qty > 0);
    app.view.edit = null;
    app.notice = {
      kind: 'good',
      undoOp: reply.opId,
      text: () => {
        const saved = t('edit.saved', { n: number });
        if (!putBack.length) return saved;
        return saved + ' ' + t('give.putBack', { items: putBack.map((i) => t('common.lineItem', i)).join(', ') });
      },
    };
    render();
  }

  draw();

  return h('div.card', null,
    h('h2', null, t('edit.title', { n: number })),
    h('p.muted', null, t('edit.intro')),
    codeEntry({ continuous: true, onCode: addCode }),
    listEl,
    emptyHint,
    h('button.btn', { type: 'button', onclick: () => openPackPicker(addCode) }, t('common.addNoBarcode')),
    saveButton,
    h('button.btn', { type: 'button', onclick: close }, t('common.cancel')));
}

/* ---------- Stock ---------- */

function stockScreen() {
  const products = app.data.products;
  const totals = products.reduce((t, p) => ({
    available: t.available + p.available, packed: t.packed + p.packed, given: t.given + p.given,
  }), { available: 0, packed: 0, given: 0 });

  return [
    h('div.card', null,
      h('h2', null, t('stock.title')),
      countsEl(totals),
      app.data.sheetUrl ? h('a.btn', { href: app.data.sheetUrl, target: '_blank', rel: 'noopener' }, t('stock.openSheet')) : null),
    h('div.card', null,
      searchList({
        placeholder: t('common.searchProducts'),
        emptyText: t('stock.empty'),
        onPick: (p) => h('div.row', { style: 'display:block' },
          h('div.row-title', null, p.name),
          h('div.muted', null, categoryLabel(p.category)),
          countsEl(p),
          h('button.btn.btn-small', { type: 'button', onclick: () => openAdjust(p) }, t('stock.editAmount'))),
      })),
  ];
}

/* A popup, so a stray tap while scrolling the list can't change a count. */
function openAdjust(p) {
  const qty = qtyInput(Math.max(0, p.available), 0);
  const dialog = h('dialog', { style: 'width:min(92vw,520px);max-height:90vh;border:0;border-radius:12px;padding:16px' },
    h('form', {
      style: 'display:grid;gap:12px',
      onsubmit: async (event) => {
        event.preventDefault();
        const available = qty.read();
        if (available === null) { qty.el.querySelector('input').focus(); return; }
        // Closed first, because a popup would cover any error message.
        dialog.close();
        if (available === p.available) return;
        const reply = await request('adjust', { opId: newOpId(), barcode: p.barcode, available, expected: p.available });
        if (!reply) return;
        app.notice = { kind: 'good', text: say('stock.adjusted', { name: p.name, n: available }), undoOp: reply.opId };
        render();
      },
    },
    h('h2', null, p.name),
    h('p.muted', null, t('stock.adjustIntro', { n: p.available })),
    h('label', null, t('stock.newAmount'), qty.el),
    h('button.btn.primary', { type: 'submit' }, t('common.save')),
    h('button.btn', { type: 'button', onclick: () => dialog.close() }, t('common.cancel'))));
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/* ---------- People and money ---------- */

function formatDate(iso) {
  const [y, m, d] = String(iso).split('-');
  return `${d}.${m}.${y}`;
}

function formatMoney(amount) {
  return new Intl.NumberFormat(htmlLang(), { maximumFractionDigits: 2 }).format(amount);
}

/** +6,000 or -100 евро. An empty currency means RSD, which is left out. */
function signedMoney(amount, currency) {
  const number = amount > 0 ? `+${formatMoney(amount)}` : formatMoney(amount);
  return currency ? `${number} ${currency}` : number;
}

/** 10,000 (100 евро): RSD first, with other currencies counted separately and never converted. */
function balanceLine(data) {
  const others = (data.otherBalances || []).map((b) => `${formatMoney(b.amount)} ${b.currency}`);
  return others.length ? `${formatMoney(data.balance)} (${others.join(', ')})` : formatMoney(data.balance);
}

/* A warning for rows pasted into the sheet that can't be read, because they aren't being counted. */
function badRowsNote(tab, rows) {
  if (!rows || !rows.length) return null;
  return h('div.notice.warn', null, h('span', null, t('ledger.badRows', { tab, rows: rows.join(', ') })));
}

/*
 * A save takes a second or two, and people often come in groups. So taps count on screen straight
 * away, and are sent together once the tapping pauses.
 */
const peopleTaps = { pending: {}, timer: null, sending: false, onChange: () => {} };

function peopleCount(date, field) {
  const day = ((app.data && app.data.people && app.data.people.days) || []).find((d) => d.date === date);
  return (day ? day[field] : 0) + (peopleTaps.pending[`${date}|${field}`] || 0);
}

function tapPeople(date, field, by) {
  if (peopleCount(date, field) + by < 0) return;
  const key = `${date}|${field}`;
  peopleTaps.pending[key] = (peopleTaps.pending[key] || 0) + by;
  if (!peopleTaps.pending[key]) delete peopleTaps.pending[key];
  peopleTaps.onChange();
  clearTimeout(peopleTaps.timer);
  peopleTaps.timer = setTimeout(sendPeopleTaps, 800);
}

async function sendPeopleTaps() {
  clearTimeout(peopleTaps.timer);
  if (peopleTaps.sending) return;
  peopleTaps.sending = true;
  try {
    for (let key = Object.keys(peopleTaps.pending)[0]; key; key = Object.keys(peopleTaps.pending)[0]) {
      const [date, field] = key.split('|');
      const delta = peopleTaps.pending[key];
      try {
        await api('people', { opId: newOpId(), date, field, delta });
        // More taps may have come in while this was saving.
        peopleTaps.pending[key] -= delta;
        if (!peopleTaps.pending[key]) delete peopleTaps.pending[key];
      } catch (err) {
        delete peopleTaps.pending[key];
        if (err.code === 'BAD_PASSCODE') {
          signOut(say('err.passcodeChanged'));
          return;
        }
        showNotice('bad', err.say);
      }
      peopleTaps.onChange();
    }
  } finally {
    peopleTaps.sending = false;
  }
}

// Sends the last taps if the phone is locked or the app is closed straight after tapping.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') sendPeopleTaps();
});

function peopleScreen() {
  const data = app.data.people || { days: [], badRows: [] };
  const today = app.data.today || new Date().toISOString().slice(0, 10);
  if (!app.view.peopleDate) app.view.peopleDate = today;

  const dateInput = h('input', {
    type: 'date', value: app.view.peopleDate, max: today,
    onchange: () => { app.view.peopleDate = dateInput.value || today; draw(); },
  });
  const counters = ['brought', 'took'].map((field) => {
    const number = h('strong.people-number');
    const label = t(field === 'brought' ? 'people.brought' : 'people.took');
    return {
      field,
      number,
      el: h('div.people-counter', null,
        h('div.row-title', null, label),
        h('div.people-stepper', null,
          h('button', { type: 'button', 'aria-label': `${label}: ${t('common.oneFewer')}`, onclick: () => tapPeople(app.view.peopleDate, field, -1) }, '−'),
          number,
          h('button', { type: 'button', 'aria-label': `${label}: ${t('common.oneMore')}`, onclick: () => tapPeople(app.view.peopleDate, field, 1) }, '+'))),
    };
  });
  const list = h('div.list');

  function draw() {
    if (!list.isConnected && list.childElementCount) return;
    counters.forEach((c) => { c.number.textContent = String(peopleCount(app.view.peopleDate, c.field)); });
    const days = (app.data && app.data.people && app.data.people.days) || [];
    list.replaceChildren(...(days.length
      ? [h('div.day-row.day-head.muted', null, h('span', null, t('common.date')), h('span', null, t('people.brought')), h('span', null, t('people.took'))),
        ...days.slice(0, 14).map((d) => h('div.day-row', null, h('span', null, formatDate(d.date)), h('b', null, String(d.brought)), h('b', null, String(d.took))))]
      : [h('p.muted', null, t('people.empty'))]));
  }
  peopleTaps.onChange = draw;
  draw();

  return [
    badRowsNote('Люди', data.badRows),
    h('div.card', null,
      h('h2', null, t('people.title')),
      h('label', null, t('common.date'), dateInput),
      counters.map((c) => c.el)),
    h('div.card', null, h('h3', null, t('people.recent')), list),
  ];
}

function moneyScreen() {
  const data = app.data.money || { balance: 0, otherBalances: [], recent: [], badRows: [] };
  const today = app.data.today || new Date().toISOString().slice(0, 10);
  const amount = h('input', { autocomplete: 'off', maxlength: '60', placeholder: t('money.amountPlaceholder') });
  const note = h('input', { maxlength: '200', autocomplete: 'off' });
  const date = h('input', { type: 'date', value: today, max: today });

  async function save(sign) {
    // The two buttons give the sign, so a typed one is dropped.
    const typed = amount.value.trim().replace(/^[+\-\u2212]\s*/, '');
    if (!/\d/.test(typed)) {
      showNotice('warn', say('money.enterAmount'));
      return;
    }
    const entry = { amount: (sign < 0 ? '-' : '') + typed, date: date.value || today, note: note.value };
    // Trying again after a lost connection must not save it twice. Two equal gifts in a row are
    // still two entries, because the ID is dropped once a save succeeds.
    const key = JSON.stringify(entry);
    if (!app.view.moneyTry || app.view.moneyTry.key !== key) app.view.moneyTry = { key, opId: newOpId() };
    const reply = await request('money', { ...entry, opId: app.view.moneyTry.opId });
    if (!reply) return;
    app.view.moneyTry = null;
    beep();
    // A retry that was already saved gets no details back, so it shows what was typed.
    const saved = reply.result.amount === undefined ? entry.amount : signedMoney(reply.result.amount, reply.result.currency);
    app.notice = { kind: 'good', text: say('money.saved', { amount: saved }), undoOp: reply.opId };
    render();
  }

  return [
    badRowsNote('Деньги', data.badRows),
    h('div.card', null,
      h('h2', null, t('money.title')),
      h('div.balance', null, h('span.muted', null, t('money.balance')), h('strong', { class: data.balance < 0 ? 'short' : '' }, balanceLine(data))),
      h('form', { style: 'display:grid;gap:12px', onsubmit: (event) => event.preventDefault() },
        h('label', null, t('money.amount'), amount),
        h('label', null, t('money.note'), note),
        h('label', null, t('common.date'), date),
        h('div.money-actions', null,
          h('button.btn.primary', { type: 'button', onclick: () => save(1) }, t('money.in')),
          h('button.btn.danger', { type: 'button', onclick: () => save(-1) }, t('money.out'))))),
    h('div.card', null,
      h('h3', null, t('money.recent')),
      h('div.list', null, data.recent.length
        ? data.recent.map((r) => h('div.row', null,
          h('div.row-main', null,
            h('div.muted', null, formatDate(r.date)),
            r.note ? h('div', null, r.note) : null),
          h(r.amount < 0 ? 'b.short' : 'b.money-in', null, signedMoney(r.amount, r.currency))))
        : h('p.muted', null, t('money.empty')))),
  ];
}

/* ---------- Sign-in ---------- */

function signOut(message) {
  scanner.stop();
  app.passcode = '';
  app.data = null;
  store.remove('fb_passcode');
  clearDraft();
  app.view.edit = null;
  app.notice = message ? { kind: 'bad', text: message } : null;
  render();
}

function loginScreen() {
  const name = h('input', { required: true, maxlength: '60', autocomplete: 'name', value: app.volunteer });
  const pass = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  return h('form.card', {
    onsubmit: async (event) => {
      event.preventDefault();
      app.passcode = pass.value;
      app.volunteer = name.value.trim();
      setBusy(true);
      try {
        await api('bootstrap');
        store.set('fb_passcode', app.passcode);
        store.set('fb_volunteer', app.volunteer);
        app.notice = null;
        render();
      } catch (err) {
        app.passcode = '';
        showNotice('bad', err.say);
      } finally {
        setBusy(false);
      }
    },
  },
  h('h2', null, t('login.title')),
  h('label', null, t('login.name'), name),
  h('label', null, t('login.passcode'), pass),
  h('button.btn.primary', { type: 'submit' }, t('login.title')));
}

/* ---------- Rendering ---------- */

const TABS = [
  ['receive', receiveScreen],
  ['pack', packScreen],
  ['give', giveScreen],
  ['stock', stockScreen],
  ['people', peopleScreen],
  ['money', moneyScreen],
];

function switchTab(tab) {
  if (tab === app.tab && tab !== 'receive') return;
  app.tab = tab;
  app.notice = null;
  app.view.edit = null;
  if (tab === 'receive') app.view.receive = null;
  render();
  if (['give', 'stock', 'people', 'money'].includes(tab)) refreshInBackground();
}

function render() {
  scanner.stop();
  window.scrollTo(0, 0);

  const configured = window.FOOD_BANK_CONFIG && window.FOOD_BANK_CONFIG.apiUrl;
  const signedIn = Boolean(app.passcode && app.data);

  let content;
  if (!configured) {
    content = h('div.card', null,
      h('h2', null, t('app.notConnectedTitle')),
      h('p', null, t('app.notConnected')));
  } else if (!signedIn) {
    content = loginScreen();
  } else {
    content = app.view.edit ? editScreen() : TABS.find(([id]) => id === app.tab)[1]();
  }

  app.root.replaceChildren(h('div.shell', null,
    h('header.topbar', null,
      h('h1', null, t('app.title')),
      h('div.topbar-actions', null,
        h('select.lang-select', { 'aria-label': t('app.language'), onchange: (event) => setLanguage(event.target.value) },
          LANGUAGES.map((l) => h('option', { value: l.id, selected: l.id === lang }, l.label))),
        signedIn ? h('button.link-button', { onclick: () => signOut() }, t('app.signOut', { name: app.volunteer })) : null)),
    h('main', null,
      h('div', { id: 'notice-slot' }, noticeEl()),
      content),
    signedIn ? h('nav', { 'aria-label': t('app.sections') }, h('div', null, TABS.map(([id]) => h('button', {
      class: app.tab === id ? 'active' : '',
      'aria-current': app.tab === id ? 'page' : null,
      onclick: () => switchTab(id),
    }, t('tab.' + id))))) : null));
}

async function startApp() {
  applyLanguage();
  const configured = window.FOOD_BANK_CONFIG && window.FOOD_BANK_CONFIG.apiUrl;
  if (configured && app.passcode) {
    setBusy(true);
    try {
      await api('bootstrap');
    } catch (err) {
      if (err.code === 'BAD_PASSCODE') {
        app.passcode = '';
        store.remove('fb_passcode');
      }
      app.notice = { kind: 'bad', text: err.say };
    } finally {
      setBusy(false);
    }
  }
  render();
}

startApp();
