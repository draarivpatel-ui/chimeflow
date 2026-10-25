'use strict';
/*
 * DOM smoke tests with no browser and no dependencies.
 * Part one reads the shipped files as text and checks structure and the
 * craft rules. Part two runs app.js against a small fake DOM built from the
 * ids in index.html and drives it with clicks and changes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('index.html');
const css = read('styles.css');
const tokens = read('tokens.css');
const appSrc = read('app.js');
const CF = require('../engine.js');

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

function walk(dir, out) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'fonts') { return; }
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p, out); } else { out.push(p); }
  });
  return out;
}

const TEXT_EXT = new Set(['.html', '.css', '.js', '.md', '.json', '.txt']);
const textFiles = walk(ROOT, []).filter((p) => TEXT_EXT.has(path.extname(p)));

/* ---------- static structure ---------- */

test('the page declares a language, a viewport and exactly one h1', () => {
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.strictEqual((html.match(/<h1[ >]/g) || []).length, 1);
});

test('every section heading is wired to its section by aria-labelledby', () => {
  const labelled = html.match(/<section[^>]*aria-labelledby="([^"]+)"/g) || [];
  assert.ok(labelled.length >= 6);
  labelled.forEach((tag) => {
    const id = /aria-labelledby="([^"]+)"/.exec(tag)[1];
    assert.ok(html.includes('id="' + id + '"'), id);
  });
});

test('all Open Graph and Twitter tags are present', () => {
  ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt', 'og:locale'].forEach((p) => {
    assert.ok(html.includes('property="' + p + '"'), p);
  });
  ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image'].forEach((n) => {
    assert.ok(html.includes('name="' + n + '"'), n);
  });
});

test('an inline SVG favicon, a description and a noscript fallback exist', () => {
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.match(html, /<meta name="description" content="[^"]{60,}/);
  assert.match(html, /<noscript>[\s\S]*<\/noscript>/);
});

test('the og image file ships with the repo', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'assets', 'og.png')));
});

test('there is a skip link that targets the main landmark', () => {
  assert.match(html, /<a class="skip" href="#main">/);
  assert.match(html, /<main id="main">/);
});

test('every form control has a label bound by for', () => {
  const controls = html.match(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"/g) || [];
  assert.ok(controls.length >= 15);
  controls.forEach((c) => {
    const id = /id="([^"]+)"/.exec(c)[1];
    assert.ok(new RegExp('<label[^>]*for="' + id + '"').test(html), 'label for ' + id);
  });
});

test('live regions exist for the trace, the inspector and the simulator', () => {
  assert.ok((html.match(/aria-live="polite"/g) || []).length >= 6);
  assert.match(html, /id="sim-log" role="log"/);
});

test('every svg in the markup is hidden from assistive tech or labelled', () => {
  (html.match(/<svg\b[^>]*>/g) || []).forEach((tag) => {
    assert.ok(/aria-hidden="true"/.test(tag) || /role="img"/.test(tag), tag);
  });
});

test('every id used by app.js exists in index.html', () => {
  const used = new Set();
  const re = /byId\('([^']+)'\)/g;
  let m;
  while ((m = re.exec(appSrc)) !== null) { used.add(m[1]); }
  assert.ok(used.size > 40);
  used.forEach((id) => {
    if (id.endsWith('-') || id === 'tab-') { return; }
    if (/^(fail-|tab-)/.test(id)) { return; }
    assert.ok(html.includes('id="' + id + '"'), id);
  });
});

test('there is a failure selector for each of the five channels', () => {
  CF.CHANNEL_IDS.forEach((id) => assert.ok(html.includes('id="fail-' + id + '"'), id));
});

test('no external scripts, styles or fonts are loaded', () => {
  assert.ok(!/<script[^>]+src="https?:/.test(html));
  assert.ok(!/<link[^>]+href="https?:/.test(html.replace(/<link rel="icon"[^>]*>/, '')));
  assert.ok(!/https?:\/\/fonts\./.test(html + css + tokens));
  assert.ok(!/@import/.test(css + tokens));
});

test('external anchors use rel noopener', () => {
  (html.match(/<a[^>]+href="https?:[^>]*>/g) || []).forEach((a) => assert.ok(/rel="noopener"/.test(a), a));
});

test('the three font files exist and are referenced by tokens.css', () => {
  ['instrument-serif', 'plus-jakarta-sans', 'jetbrains-mono'].forEach((f) => {
    const file = 'fonts/' + f + '-latin.woff2';
    assert.ok(fs.existsSync(path.join(ROOT, file)), file);
    assert.ok(tokens.includes(file), file);
  });
});

/* ---------- tokens and craft rules ---------- */

test('tokens.css locks the brief palette', () => {
  ['#F7F5F0', '#EFECE4', '#15171A', '#E05A2B', '#1D4ED8'].forEach((hex) => assert.ok(tokens.includes(hex), hex));
});

test('every custom property used in styles.css and index.html is declared', () => {
  const declared = new Set((tokens.match(/--[a-z0-9-]+(?=\s*:)/g) || []));
  const declaredHere = new Set((css.match(/^\s*--[a-z0-9-]+(?=\s*:)/gm) || []).map((s) => s.trim()));
  const used = new Set();
  (css + html).replace(/var\((--[a-z0-9-]+)/g, (_, name) => { used.add(name); return ''; });
  assert.ok(used.size > 30);
  used.forEach((name) => assert.ok(declared.has(name) || declaredHere.has(name), name));
});

test('styles.css and app.js contain no raw colour values', () => {
  const raw = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|oklch\(/;
  assert.ok(!raw.test(css.replace(/\/\*[\s\S]*?\*\//g, '')), 'styles.css');
  assert.ok(!raw.test(appSrc), 'app.js');
});

test('index.html has no raw colour values outside the favicon', () => {
  const noIcon = html.replace(/<link rel="icon"[^>]*>/, '');
  assert.ok(!/#[0-9a-fA-F]{6}\b|rgba?\(|hsla?\(/.test(noIcon));
});

test('every font-family in styles.css goes through a token', () => {
  (css.match(/font-family:[^;]+;/g) || []).forEach((d) => assert.ok(/var\(--font-/.test(d), d));
});

test('headings and display type are roman, never italic', () => {
  assert.ok(!/<(em|i)>/.test(html.replace(/<i class="swatch[^>]*><\/i>/g, '')));
  assert.ok(!/h[1-3][^{]*\{[^}]*font-style:\s*italic/.test(css));
});

test('there are no uppercase eyebrow kickers', () => {
  assert.ok(!/text-transform:\s*uppercase/.test(css));
  assert.ok(!/class="[^"]*(eyebrow|kicker)/.test(html));
});

test('motion honours reduced motion and focus is visible', () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /:focus-visible/);
});

test('buttons keep one-line labels', () => {
  assert.match(css, /\.btn\s*\{[^}]*white-space:\s*nowrap/);
});

test('app.js never writes markup from strings', () => {
  ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval('].forEach((s) => assert.ok(!appSrc.includes(s), s));
});

test('no file contains an em dash or an en dash', () => {
  textFiles.forEach((f) => {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!t.includes(EM) && !t.includes(EN), path.relative(ROOT, f));
  });
});

test('no file contains an emoji code point', () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u;
  textFiles.forEach((f) => assert.ok(!emoji.test(fs.readFileSync(f, 'utf8')), path.relative(ROOT, f)));
});

test('no file exposes a personal email or home address', () => {
  textFiles.forEach((f) => {
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!/@gmail\.com/i.test(t), path.relative(ROOT, f));
    assert.ok(!new RegExp('Tan' + 'yard', 'i').test(t), path.relative(ROOT, f));
  });
});

test('required project files exist and the licence is MIT', () => {
  ['README.md', 'NOTES.md', 'LICENSE', 'video/SUBMISSION.md', 'package.json', '.nojekyll'].forEach((f) => {
    assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  });
  assert.match(read('LICENSE'), /MIT License/);
  assert.strictEqual(JSON.parse(read('package.json')).license, 'MIT');
});

test('the Chatterbox voiceover is exactly 55 words with no hyphens', () => {
  const sub = read('video/SUBMISSION.md');
  const m = /<!-- voiceover:start -->([\s\S]*?)<!-- voiceover:end -->/.exec(sub);
  assert.ok(m, 'voiceover markers');
  const script = m[1].trim();
  assert.strictEqual(script.split(/\s+/).length, 55);
  assert.ok(!/[-‐-―]/.test(script));
});

test('the README states that playtesting is not claimed and nothing is deployed', () => {
  const r = read('README.md');
  assert.match(r, /not been (deployed|sent)|never been (deployed|sent)/i);
  assert.match(r, /fictional/i);
});

/* ---------- fake DOM ---------- */

class FNode {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this._text = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.className = '';
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.style = {};
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(c) { this.children.push(c); c.parent = this; return c; }
  removeChild(c) { this.children.splice(this.children.indexOf(c), 1); return c; }
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === 'id' && this.doc) { this.doc.registry[v] = this; }
    if (k === 'class') { this.className = String(v); }
  }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  dispatch(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(Object.assign({ target: this, preventDefault() {}, key: '' }, ev || {}))); }
  click() { this.dispatch('click'); }
  focus() {}
  set textContent(v) { this.children = []; this._text = String(v); }
  get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
  walk(fn) { fn(this); this.children.forEach((c) => c.walk && c.walk(fn)); }
  find(pred) { const out = []; this.walk((n) => { if (pred(n)) { out.push(n); } }); return out; }
}

function buildEnvironment() {
  const doc = { registry: {}, listeners: {} };
  const make = (tag) => { const n = new FNode(tag); n.doc = doc; return n; };
  doc.createElement = make;
  doc.createElementNS = (ns, tag) => make(tag);
  doc.createTextNode = (t) => { const n = make('#text'); n._text = String(t); return n; };
  doc.getElementById = (id) => doc.registry[id] || null;
  doc.addEventListener = () => {};
  doc.body = make('body');
  (html.match(/\sid="([^"]+)"/g) || []).forEach((m) => {
    const id = /id="([^"]+)"/.exec(m)[1];
    const tag = new RegExp('<([a-z0-9]+)[^>]*\\sid="' + id + '"').exec(html)[1];
    const n = make(tag);
    n.attrs.id = id;
    doc.registry[id] = n;
  });
  doc.registry['sim-sound'].checked = true;
  doc.registry['inbound'].value = 'STOP';

  const made = [];
  class FakeAudio {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
    resume() {}
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() { const o = { frequency: { value: 0 }, type: '', connect() {}, start() {}, stop() {} }; made.push(o); return o; }
  }
  const win = { ChimeFlow: CF, AudioContext: FakeAudio };
  const sandbox = {
    window: win, document: doc, navigator: {}, console, setTimeout: () => 0, Blob: class {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
    Promise, String, Array, Object, JSON, Math, isFinite, parseFloat, Date
  };
  vm.createContext(sandbox);
  vm.runInContext(appSrc, sandbox);
  return { doc, made, byId: (id) => doc.registry[id] };
}

const statValue = (env, label) => {
  const cards = env.byId('bench-stats').children;
  const card = cards.filter((c) => c.children[0].textContent === label)[0];
  return card.children[1].textContent;
};

test('app.js boots against the page ids without throwing', () => {
  assert.doesNotThrow(() => buildEnvironment());
});

test('the scenario menu lists all four scenarios by label', () => {
  const env = buildEnvironment();
  const opts = env.byId('scenario').children;
  assert.strictEqual(opts.length, 4);
  assert.strictEqual(opts[0].textContent, CF.SCENARIOS[0].label);
});

test('each channel selector offers four failure modes', () => {
  const env = buildEnvironment();
  CF.CHANNEL_IDS.forEach((id) => assert.strictEqual(env.byId('fail-' + id).children.length, 4, id));
});

test('the hero and the bench both render a labelled svg diagram', () => {
  const env = buildEnvironment();
  ['hero-dag', 'bench-dag'].forEach((id) => {
    const svg = env.byId(id).children[0];
    assert.strictEqual(svg.tagName, 'SVG');
    assert.strictEqual(svg.attrs.role, 'img');
    assert.ok(svg.attrs['aria-labelledby']);
    assert.ok(svg.find((n) => /dag__bar/.test(n.className)).length >= 3, id);
  });
});

test('the bench shows four stat cards and a step list that matches the trace', () => {
  const env = buildEnvironment();
  assert.strictEqual(env.byId('bench-stats').children.length, 4);
  const trace = CF.simulateConversationTrace(CF.SCENARIOS[0]);
  assert.strictEqual(env.byId('bench-steps').children.length, trace.steps.length);
  assert.match(env.byId('bench-live').textContent, /Trace updated/);
});

test('breaking voice with a timeout fails over once per voice step', () => {
  const env = buildEnvironment();
  assert.strictEqual(statValue(env, 'Failovers'), '0');
  const sel = env.byId('fail-CHIME_PSTN_VOICE');
  sel.value = 'timeout';
  sel.dispatch('change');
  assert.strictEqual(statValue(env, 'Failovers'), '2');
});

test('the night preset blocks voice and says so in the local clock line', () => {
  const env = buildEnvironment();
  env.byId('preset-night').click();
  assert.match(env.byId('local-clock').textContent, /22:15/);
  assert.match(env.byId('local-clock').textContent, /quiet hours/i);
});

test('switching scenario rewrites the summary and restarts the simulator', () => {
  const env = buildEnvironment();
  const sel = env.byId('scenario');
  sel.value = 'fraud-verify';
  sel.dispatch('change');
  assert.match(env.byId('scenario-summary').textContent, /Harbor Credit Union/);
  assert.match(env.byId('sim-prompt').textContent, /Lakeside Electronics/);
  assert.strictEqual(env.byId('sim-path').children.length, 1);
});

test('the keypad has twelve keys with accessible names', () => {
  const env = buildEnvironment();
  const keys = env.byId('keypad').children;
  assert.strictEqual(keys.length, 12);
  assert.ok(keys.every((k) => k.attrs['aria-label']));
});

test('pressing 2 plays 697 Hz plus 1336 Hz and branches the state machine', () => {
  const env = buildEnvironment();
  env.byId('keypad').children.filter((k) => k.attrs['data-key'] === '2')[0].click();
  assert.deepStrictEqual(env.made.map((o) => o.frequency.value), [697, 1336]);
  assert.match(env.byId('sim-tone').textContent, /697 Hz plus 1336 Hz/);
  assert.strictEqual(env.byId('sim-path').children.length, 2);
  assert.strictEqual(env.byId('sim-path').children[1].textContent, 'pick_slot');
});

test('muting the tones keeps the branch but plays no oscillator', () => {
  const env = buildEnvironment();
  env.byId('sim-sound').checked = false;
  env.byId('keypad').children.filter((k) => k.attrs['data-key'] === '1')[0].click();
  assert.strictEqual(env.made.length, 0);
  assert.strictEqual(env.byId('sim-path').children.length, 2);
});

test('keys disable once the conversation reaches a terminal node', () => {
  const env = buildEnvironment();
  const key = (k) => env.byId('keypad').children.filter((b) => b.attrs['data-key'] === k)[0];
  key('1').click();
  assert.ok(env.byId('keypad').children.every((b) => b.disabled));
  assert.strictEqual(env.byId('sim-send').disabled, true);
});

test('typing a red flag phrase escalates to the human bridge', () => {
  const env = buildEnvironment();
  env.byId('sim-text').value = 'I have chest pain';
  env.byId('sim-send').click();
  assert.match(env.byId('sim-log').textContent, /red flag/);
  assert.match(env.byId('sim-log').textContent, /CallAndBridge/);
});

test('start over resets the path to a single node', () => {
  const env = buildEnvironment();
  env.byId('keypad').children.filter((k) => k.attrs['data-key'] === '2')[0].click();
  env.byId('sim-restart').click();
  assert.strictEqual(env.byId('sim-path').children.length, 1);
});

test('the inspector masks the card number and keeps the raw digits out of the preview', () => {
  const env = buildEnvironment();
  const text = env.byId('masked').textContent;
  assert.match(text, /\(CARD ending 4242\)/);
  assert.ok(!text.includes('4242 4242'));
});

test('adding an emoji flips the inspector to UCS-2 and shows the code point', () => {
  const env = buildEnvironment();
  env.byId('add-emoji').click();
  assert.strictEqual(env.byId('meter').children[0].children[0].textContent, 'UCS-2');
  assert.match(env.byId('forcing').textContent, /U\+1F600/);
});

test('typing in the message box updates the segment strip', () => {
  const env = buildEnvironment();
  const msg = env.byId('msg');
  msg.value = 'a'.repeat(200);
  msg.dispatch('input');
  assert.strictEqual(env.byId('segments').children.length, 2);
});

test('raising the rate raises the ten thousand message cost', () => {
  const env = buildEnvironment();
  const before = env.byId('sms-kv').textContent;
  const r = env.byId('rate-seg');
  r.value = '0.05';
  r.dispatch('input');
  assert.notStrictEqual(env.byId('sms-kv').textContent, before);
  assert.match(env.byId('sms-kv').textContent, /\$[\d.]+/);
});

test('the opt-out tester recognises STOP and rejects a sentence', () => {
  const env = buildEnvironment();
  assert.match(env.byId('optout-result').textContent, /Opt-out keyword "STOP"/);
  env.byId('inbound').value = 'see you Thursday';
  env.byId('inbound').dispatch('input');
  assert.match(env.byId('optout-result').textContent, /Not an opt-out/);
});

test('the export panel opens on the SMA action and lists eight tabs', () => {
  const env = buildEnvironment();
  assert.strictEqual(env.byId('export-tabs').children.length, 8);
  assert.match(env.byId('export-code').textContent, /"Type": "SpeakAndGetDigits"/);
  assert.match(env.byId('export-status').textContent, /check passed/);
});

test('selecting the SMS tab shows a SendTextMessage payload', () => {
  const env = buildEnvironment();
  env.byId('export-tabs').children.filter((t) => t.attrs.id === 'tab-sms')[0].click();
  assert.match(env.byId('export-code').textContent, /"MessageType": "TRANSACTIONAL"/);
  const selected = env.byId('export-tabs').children.filter((t) => t.attrs['aria-selected'] === 'true');
  assert.strictEqual(selected.length, 1);
});

test('arrow keys move between export tabs', () => {
  const env = buildEnvironment();
  env.byId('export-tabs').children[0].dispatch('keydown', { key: 'ArrowRight' });
  const selected = env.byId('export-tabs').children.filter((t) => t.attrs['aria-selected'] === 'true')[0];
  assert.strictEqual(selected.attrs.id, 'tab-audio');
});
