'use strict';
/*
 * ChimeFlow UI. Plain DOM, no framework, no network.
 * Everything user-typed is written with textContent or text nodes, never as markup.
 */
(function () {
  var CF = window.ChimeFlow;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var doc = document;

  var FAILURE_MODES = [
    { value: '', label: 'Healthy' },
    { value: 'timeout', label: 'No answer or timeout' },
    { value: 'undeliverable', label: 'Undeliverable' },
    { value: 'carrier_down', label: 'Carrier path down' }
  ];

  var KEY_LETTERS = { '1': '', '2': 'ABC', '3': 'DEF', '4': 'GHI', '5': 'JKL', '6': 'MNO', '7': 'PQRS', '8': 'TUV', '9': 'WXYZ', '*': '', '0': '+', '#': '' };

  var state = {
    scenarioId: CF.SCENARIOS[0].id,
    sendUtc: '',
    timeZone: '',
    failures: {},
    optedOutSms: false,
    safetyOverride: false,
    replies: '',
    rates: { smsPerSegment: CF.DEFAULT_RATES.smsPerSegment, carrierFeePerSegment: CF.DEFAULT_RATES.carrierFeePerSegment },
    message: 'Hi Maya, your visit is Thursday at 10:15. Pay the balance with card 4242 4242 4242 4242 or call (703) 555-0142. Reply STOP to opt out.',
    exportTab: 'sma',
    sim: null
  };

  /* ---------- helpers ---------- */

  function byId(id) { return doc.getElementById(id); }

  function el(tag, attrs, kids) {
    var node = doc.createElement(tag);
    applyAttrs(node, attrs);
    appendKids(node, kids);
    return node;
  }

  function svg(tag, attrs, kids) {
    var node = doc.createElementNS(SVG_NS, tag);
    applyAttrs(node, attrs);
    appendKids(node, kids);
    return node;
  }

  function applyAttrs(node, attrs) {
    if (!attrs) { return; }
    Object.keys(attrs).forEach(function (k) {
      if (k === 'text') { node.textContent = attrs[k]; }
      else if (k === 'class') { node.setAttribute('class', attrs[k]); }
      else { node.setAttribute(k, String(attrs[k])); }
    });
  }

  function appendKids(node, kids) {
    if (!kids) { return; }
    (Array.isArray(kids) ? kids : [kids]).forEach(function (k) {
      if (k == null) { return; }
      node.appendChild(typeof k === 'string' ? doc.createTextNode(k) : k);
    });
  }

  function clear(node) {
    while (node.firstChild) { node.removeChild(node.firstChild); }
  }

  function fmtMs(ms) {
    if (ms < 1000) { return Math.round(ms) + ' ms'; }
    return (ms / 1000).toFixed(1) + ' s';
  }

  function fmtUsd(n) {
    if (n === 0) { return '$0'; }
    if (n >= 1) { return '$' + n.toFixed(2); }
    return '$' + (n < 0.01 ? n.toFixed(4) : n.toFixed(3));
  }

  function humanize(id) {
    var t = id.replace(/_/g, ' ');
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  function scenario() { return CF.getScenario(state.scenarioId); }

  function toLocalInput(iso) { return iso.slice(0, 16); }
  function fromLocalInput(v) { return v.length === 16 ? v + ':00Z' : v; }

  function context() {
    return CF.normalizeContext(scenario(), {
      nowUtc: fromLocalInput(state.sendUtc),
      timeZone: state.timeZone,
      failures: state.failures,
      optedOut: state.optedOutSms ? ['PINPOINT_SMS'] : [],
      safetyOverride: state.safetyOverride,
      rates: state.rates
    });
  }

  function parseReplies(text) {
    return String(text).split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
  }

  function channelShort(id) {
    return id === CF.BRIDGE.id ? CF.BRIDGE.short : CF.CHANNELS[id].short;
  }

  /* ---------- failover DAG ---------- */

  var dagCounter = 0;

  function niceStep(total) {
    var steps = [500, 1000, 2000, 5000, 10000, 20000, 30000, 60000];
    for (var i = 0; i < steps.length; i++) {
      if (total / steps[i] <= 8) { return steps[i]; }
    }
    return 120000;
  }

  function renderDag(host, trace) {
    clear(host);
    dagCounter += 1;
    var uid = 'dag' + dagCounter;
    var W = 960;
    var gutter = 132;
    var padR = 28;
    var top = 30;
    var laneH = 56;
    var lanes = CF.LANES;
    var H = top + lanes.length * laneH + 30;
    var total = Math.max(trace.totalMs, 1000);
    var plotW = W - gutter - padR;
    var x = function (ms) { return gutter + (ms / total) * plotW; };
    var laneIndex = function (lane) { return Math.max(0, lanes.indexOf(lane)); };

    var attemptCount = 0;
    trace.steps.forEach(function (s) { attemptCount += s.attempts.length; });
    var root = svg('svg', {
      'class': 'dag', viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-labelledby': uid + '-t ' + uid + '-d', focusable: 'false'
    });
    root.appendChild(svg('title', { id: uid + '-t', text: 'Omnichannel sequence and failover diagram' }));
    root.appendChild(svg('desc', { id: uid + '-d', text: attemptCount + ' attempts across ' + trace.steps.length + ' steps over ' + fmtMs(trace.totalMs) + '. The step list below gives the same information as text.' }));

    lanes.forEach(function (lane, i) {
      var y = top + i * laneH;
      root.appendChild(svg('rect', { 'class': 'dag__lane-bg' + (i % 2 ? ' dag__lane-bg--alt' : ''), x: 0, y: y, width: W, height: laneH }));
      root.appendChild(svg('text', { 'class': 'dag__lane-label', x: 12, y: y + laneH / 2 + 4, text: CF.LANE_LABELS[lane] }));
    });

    var stepMs = niceStep(total);
    for (var t = 0; t <= total; t += stepMs) {
      var tx = x(t);
      root.appendChild(svg('line', { 'class': 'dag__tick', x1: tx, x2: tx, y1: top - 6, y2: top + lanes.length * laneH }));
      root.appendChild(svg('text', { 'class': 'dag__tick-label', x: tx + 3, y: top - 12, text: t === 0 ? '0' : (stepMs >= 1000 ? (t / 1000) + ' s' : t + ' ms') }));
    }

    var flat = [];
    trace.steps.forEach(function (s, si) {
      s.attempts.forEach(function (a, ai) { flat.push({ a: a, step: s, stepIndex: si, first: ai === 0 }); });
    });

    var layout = flat.map(function (f) {
      var a = f.a;
      var w = Math.max(x(a.endMs) - x(a.startMs), 8);
      var y = top + laneIndex(a.lane) * laneH + 10;
      return { x: x(a.startMs), y: y, w: w, h: laneH - 20, cy: y + (laneH - 20) / 2 };
    });

    var edgeGroup = svg('g', { 'aria-hidden': 'true' });
    for (var i = 1; i < flat.length; i++) {
      var p = layout[i - 1];
      var q = layout[i];
      var fromAttempt = flat[i - 1];
      var toAttempt = flat[i];
      var sameStep = fromAttempt.stepIndex === toAttempt.stepIndex;
      var isFailover = sameStep && fromAttempt.a.status !== 'delivered' && fromAttempt.a.channel !== toAttempt.a.channel;
      var x1 = p.x + p.w;
      var x2 = q.x;
      var mid = x1 + Math.max((x2 - x1) / 2, 4);
      var d = 'M' + x1 + ' ' + p.cy + ' H' + mid + ' V' + q.cy + ' H' + Math.max(x2, mid);
      var edge = svg('path', { 'class': 'dag__edge' + (isFailover ? ' dag__edge--failover' : ''), d: d, style: '--i:' + i });
      edgeGroup.appendChild(edge);
      if (!sameStep && toAttempt.first) {
        var prevStep = trace.steps[fromAttempt.stepIndex];
        if (prevStep.input) {
          var label = prevStep.input.raw.length > 9 ? prevStep.input.raw.slice(0, 8) + '...' : prevStep.input.raw;
          var lw = label.length * 7 + 10;
          edgeGroup.appendChild(svg('rect', { 'class': 'dag__edge-label-bg', x: mid - lw / 2, y: (p.cy + q.cy) / 2 - 9, width: lw, height: 18, rx: 2 }));
          edgeGroup.appendChild(svg('text', { 'class': 'dag__edge-label', x: mid, y: (p.cy + q.cy) / 2 + 4, 'text-anchor': 'middle', text: label }));
        }
      }
    }
    root.appendChild(edgeGroup);

    flat.forEach(function (f, idx) {
      var a = f.a;
      var l = layout[idx];
      var kind = a.channel === CF.BRIDGE.id ? 'human' : (a.status === 'delivered' ? 'ok' : 'fail');
      var g = svg('g');
      var rect = svg('rect', { 'class': 'dag__bar dag__bar--' + kind, x: l.x, y: l.y, width: l.w, height: l.h, rx: 2, style: '--i:' + idx });
      rect.appendChild(svg('title', { text: channelShort(a.channel) + ' attempt ' + a.attempt + ', ' + a.status.replace('_', ' ') + ', ' + fmtMs(a.startMs) + ' to ' + fmtMs(a.endMs) }));
      g.appendChild(rect);
      var long = channelShort(a.channel) + ' ' + fmtMs(a.endMs - a.startMs);
      var shortLabel = channelShort(a.channel);
      var text = null;
      if (l.w >= long.length * 6.8 + 10) { text = long; }
      else if (l.w >= shortLabel.length * 6.8 + 10) { text = shortLabel; }
      if (text) {
        g.appendChild(svg('text', { 'class': 'dag__bar-label' + (kind === 'fail' ? ' dag__bar-label--fail' : ''), x: l.x + 6, y: l.cy + 4, text: text }));
      }
      root.appendChild(g);
    });

    host.appendChild(root);
  }

  /* ---------- bench ---------- */

  function renderBench() {
    var sc = scenario();
    var ctx = context();
    var trace = CF.simulateConversationTrace(sc, { nowUtc: ctx.nowUtc, timeZone: ctx.timeZone, failures: ctx.failures, optedOut: ctx.optedOut, safetyOverride: ctx.safetyOverride, rates: ctx.rates, inputs: parseReplies(state.replies) });

    byId('scenario-summary').textContent = sc.title + '. ' + sc.org + '. ' + sc.summary;
    var quiet = CF.checkQuietHours(ctx.nowUtc, ctx.timeZone);
    var clock = byId('local-clock');
    clock.textContent = 'Recipient local time ' + quiet.localTime + '. ' + (quiet.quiet ? 'Inside quiet hours, voice and SMS are blocked.' : 'Inside the 08:00 to 21:00 window.');

    var outcome = trace.unreachable ? 'Unreachable' : (trace.handoff ? 'Human bridge' : humanize(trace.finalNode));
    var stats = byId('bench-stats');
    clear(stats);
    [
      { label: 'Total time', value: fmtMs(trace.totalMs) },
      { label: 'Cost, every attempt billed', value: fmtUsd(trace.totalCostUsd) },
      { label: 'Failovers', value: String(trace.failovers) },
      { label: 'Ended at', value: outcome, alert: trace.unreachable }
    ].forEach(function (s) {
      stats.appendChild(el('div', { 'class': 'stat' + (s.alert ? ' stat--alert' : '') }, [
        el('div', { 'class': 'stat__label', text: s.label }),
        el('div', { 'class': 'stat__value', text: s.value })
      ]));
    });

    renderDag(byId('bench-dag'), trace);
    renderSteps(trace);
    byId('bench-live').textContent = 'Trace updated. ' + trace.steps.length + ' steps over ' + fmtMs(trace.totalMs) + ', ' + trace.failovers + ' failovers, ended at ' + outcome + '.';
    return trace;
  }

  function renderSteps(trace) {
    var list = byId('bench-steps');
    clear(list);
    var sc = scenario();
    trace.steps.forEach(function (s) {
      var node = sc.nodes[s.nodeId];
      var meta = el('div', { 'class': 'step__meta' });
      s.attempts.forEach(function (a) {
        var ok = a.status === 'delivered';
        var cls = a.channel === CF.BRIDGE.id ? 'tag tag--human' : (ok ? 'tag tag--ok' : 'tag tag--fail');
        meta.appendChild(el('span', { 'class': cls, text: channelShort(a.channel) + ' ' + a.status.replace('_', ' ') + ', ' + fmtMs(a.startMs) + ' to ' + fmtMs(a.endMs) }));
      });
      s.blocked.forEach(function (b) {
        meta.appendChild(el('span', { 'class': 'tag tag--fail', text: channelShort(b.channel) + ' blocked, ' + b.reasons.join(', ') }));
      });
      if (s.smsAudit) {
        meta.appendChild(el('span', { 'class': 'tag', text: 'SMS ' + s.smsAudit.encoding + ', ' + s.smsAudit.segments + (s.smsAudit.segments === 1 ? ' segment' : ' segments') }));
      }
      if (s.input) {
        var res = s.result;
        var label = 'Reply ' + s.input.raw + (res ? ', ' + res.reason : '');
        meta.appendChild(el('span', { 'class': res && res.matched ? 'tag tag--good' : 'tag', text: label }));
      }
      var shown = s.deliveredOn && CF.CHANNELS[s.deliveredOn] ? CF.renderNodeText(node, s.deliveredOn) : node.text;
      list.appendChild(el('li', { 'class': 'step' }, [
        el('div', null, [
          el('div', { 'class': 'step__title', text: humanize(s.nodeId) }),
          el('div', { 'class': 'step__text', text: shown }),
          meta
        ])
      ]));
    });
    if (trace.warnings.length) {
      list.appendChild(el('li', { 'class': 'step' }, [
        el('div', null, [el('div', { 'class': 'step__title', text: 'Warnings' }), el('div', { 'class': 'step__text', text: trace.warnings.join(' ') })])
      ]));
    }
  }

  /* ---------- inspector ---------- */

  function renderInspector() {
    var ctx = context();
    var audit = CF.auditMessagePayload(state.message, { nowUtc: ctx.nowUtc, timeZone: ctx.timeZone, optedOut: ctx.optedOut.indexOf('PINPOINT_SMS') !== -1, rates: state.rates });
    var orig = audit.original;

    var masked = byId('masked');
    clear(masked);
    var pos = 0;
    audit.findings.forEach(function (f) {
      if (f.start > pos) { masked.appendChild(doc.createTextNode(state.message.slice(pos, f.start))); }
      masked.appendChild(el('span', { 'class': 'mask', text: f.mask }));
      pos = f.end;
    });
    if (pos < state.message.length) { masked.appendChild(doc.createTextNode(state.message.slice(pos))); }
    if (!state.message) { masked.textContent = 'Nothing to send yet.'; }

    var list = byId('findings');
    clear(list);
    if (!audit.findings.length) {
      list.appendChild(el('li', { text: 'No sensitive values found.' }));
    } else {
      audit.findings.forEach(function (f) {
        list.appendChild(el('li', null, [el('span', { 'class': 'tag', text: f.type }), el('span', { 'class': 'mono', text: f.mask })]));
      });
    }

    var sms = audit.sms;
    var meter = byId('meter');
    clear(meter);
    meter.appendChild(el('div', { 'class': 'meter__cell' }, [el('span', { 'class': 'meter__big', text: orig.encoding }), el('span', { 'class': 'meter__label', text: 'encoding of what you typed' })]));
    meter.appendChild(el('div', { 'class': 'meter__cell' }, [el('span', { 'class': 'meter__big', text: String(sms.segments) }), el('span', { 'class': 'meter__label', text: sms.segments === 1 ? 'segment after masking' : 'segments after masking' })]));
    meter.appendChild(el('div', { 'class': 'meter__cell' }, [el('span', { 'class': 'meter__big', text: String(sms.units) + '/' + (sms.segments > 1 ? sms.multipartLimit * sms.segments : sms.singleLimit) }), el('span', { 'class': 'meter__label', text: 'units used' })]));

    var segBox = byId('segments');
    clear(segBox);
    sms.segmentTexts.forEach(function (segText, i) {
      var unitsInSeg = CF.analyzeSms(segText).units;
      var cap = sms.segments === 1 ? sms.singleLimit : sms.multipartLimit;
      var pct = Math.min(100, Math.round((unitsInSeg / cap) * 100));
      var seg = el('div', { 'class': 'segment' + (sms.encoding === 'UCS-2' ? ' segment--ucs' : ''), title: 'Segment ' + (i + 1) + ': ' + unitsInSeg + ' of ' + cap + ' units' });
      seg.appendChild(el('div', { 'class': 'segment__fill', style: 'width:' + pct + '%' }));
      segBox.appendChild(seg);
    });

    var kv = byId('sms-kv');
    clear(kv);
    [
      ['Characters', String(sms.characters)],
      ['Single message limit', String(sms.singleLimit) + ' units'],
      ['Multipart limit per segment', String(sms.multipartLimit) + ' units'],
      ['Cost per message', fmtUsd(audit.cost.perMessage)],
      ['Cost per 10,000 messages', fmtUsd(audit.cost.per10k)]
    ].forEach(function (row) {
      kv.appendChild(el('dt', { text: row[0] }));
      kv.appendChild(el('dd', { text: row[1] }));
    });

    var forcing = byId('forcing');
    clear(forcing);
    orig.forcingChars.forEach(function (fc) {
      forcing.appendChild(el('span', { 'class': 'codepoint', title: 'This character is not in GSM-7' }, [el('strong', { text: fc.char }), el('span', { text: fc.codepoint })]));
    });
    if (orig.extendedChars.length) {
      forcing.appendChild(el('span', { 'class': 'tag', text: 'Extension characters cost 2 units each: ' + orig.extendedChars.join(' ') }));
    }

    var inbound = CF.detectOptOut(byId('inbound').value);
    var oo = byId('optout-result');
    oo.className = 'verdict ' + (inbound.optOut ? 'verdict--block' : 'verdict--ok');
    oo.textContent = inbound.optOut ? 'Opt-out keyword "' + inbound.keyword + '". Stop texting this number and send one confirmation.' : (inbound.help ? 'Help keyword "' + inbound.keyword + '". Reply with program info and a way to opt out.' : 'Not an opt-out keyword. The reply goes to the conversation.');

    var tc = byId('tcpa-result');
    tc.className = 'verdict ' + (audit.blocked ? 'verdict--block' : 'verdict--ok');
    var blockIssues = audit.issues.filter(function (i) { return i.severity === 'block'; });
    tc.textContent = blockIssues.length ? 'Send blocked. ' + blockIssues.map(function (i) { return i.message; }).join(' ') : 'Send allowed at the bench clock (' + (audit.quiet ? audit.quiet.localTime : 'n/a') + ' recipient local time).';
  }

  /* ---------- simulator ---------- */

  var audio = { ctx: null, failed: false };

  function playTone(key) {
    var f = CF.dtmfFrequencies(key);
    var label = byId('sim-tone');
    if (!f) { return; }
    label.textContent = 'Key ' + key + ' plays ' + f[0] + ' Hz plus ' + f[1] + ' Hz.';
    if (!byId('sim-sound').checked || audio.failed) { return; }
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) { audio.failed = true; label.textContent += ' Audio is not available in this browser.'; return; }
    try {
      if (!audio.ctx) { audio.ctx = new Ctor(); }
      if (audio.ctx.state === 'suspended') { audio.ctx.resume(); }
      var now = audio.ctx.currentTime;
      var gain = audio.ctx.createGain();
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.25, now + 0.01);
      gain.gain.setValueAtTime(0.25, now + 0.15);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
      gain.connect(audio.ctx.destination);
      f.forEach(function (hz) {
        var osc = audio.ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = hz;
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.22);
      });
    } catch (err) {
      audio.failed = true;
      label.textContent += ' Audio could not start.';
    }
  }

  function simLog(who, text) {
    state.sim.log.push({ who: who, text: text });
  }

  function simStart() {
    var sc = scenario();
    state.sim = { session: CF.createSession(sc), log: [], clockMs: 0, notes: 0 };
    simDeliver();
    renderSim();
  }

  function simDeliver() {
    var sim = state.sim;
    var sc = scenario();
    var guard = 0;
    while (guard++ < 4) {
      var node = sc.nodes[sim.session.nodeId];
      var ctx = context();
      var d = CF.planDelivery(sc, node, ctx, sim.clockMs);
      if (d.deliveredOn) {
        var shown = CF.renderNodeText(node, d.deliveredOn);
        var how = d.attempts.length > 1 || d.blocked.length ? ' after ' + d.blocked.map(function (b) { return channelShort(b.channel) + ' blocked (' + b.reasons.join(', ') + ')'; }).concat(d.attempts.filter(function (a) { return a.status !== 'delivered'; }).map(function (a) { return channelShort(a.channel) + ' ' + a.status.replace('_', ' '); })).join(', ') : '';
        simLog('System via ' + channelShort(d.deliveredOn), shown + (how ? ' [delivered' + how + ']' : ''));
        sim.channel = d.deliveredOn;
        sim.clockMs = d.endMs;
        if (node.kind === 'bridge') {
          simLog('System', 'Chime SDK CallAndBridge connects the call to the ' + node.bridgeTo + '. A person takes over here.');
        }
        return;
      }
      simLog('System', 'No channel could deliver "' + humanize(node.id) + '".');
      sim.channel = null;
      if (node.kind === 'bridge' || sim.session.escalated === 'undeliverable') { sim.session = Object.assign({}, sim.session, { done: true, unreachable: true }); return; }
      sim.session = CF.escalateSession(sim.session, sc, 'undeliverable');
    }
  }

  function simInput(ev, shown) {
    var sim = state.sim;
    var sc = scenario();
    if (!sim || sim.session.done) { return; }
    var node = sc.nodes[sim.session.nodeId];
    if (!node.options) { return; }
    simLog('You', shown);
    var adv = CF.advance(sim.session, ev, sc);
    sim.session = adv.session;
    sim.clockMs += ev.type === 'timeout' ? CF.NO_RESPONSE_MS : CF.RESPONSE_MS;
    simLog('Engine', adv.result.reason + (adv.result.escalated ? ' (escalated: ' + adv.result.escalated.replace(/_/g, ' ') + ')' : ''));
    if (adv.session.nodeId !== node.id || adv.session.done) { simDeliver(); }
    renderSim();
  }

  function renderSim() {
    var sim = state.sim;
    var sc = scenario();
    var node = sc.nodes[sim.session.nodeId];
    var awaiting = !!node.options && !sim.session.done;
    var channelId = sim.channel;

    var chan = byId('sim-channel');
    chan.textContent = channelId ? channelShort(channelId) : 'No channel';
    byId('sim-node').textContent = node.id;
    byId('sim-prompt').textContent = channelId ? CF.renderNodeText(node, channelId) : node.text;

    var keypad = byId('keypad');
    var buttons = keypad.children;
    for (var i = 0; i < buttons.length; i++) { buttons[i].disabled = !awaiting; }
    byId('sim-text').disabled = !awaiting;
    byId('sim-send').disabled = !awaiting;
    byId('sim-timeout').disabled = !awaiting;

    var path = byId('sim-path');
    clear(path);
    sim.session.history.forEach(function (id, i) {
      var last = i === sim.session.history.length - 1;
      var cls = 'path__node' + (last ? (sim.session.escalated ? ' path__node--escalated' : ' path__node--current') : '');
      path.appendChild(el('li', null, [el('span', { 'class': cls, text: id })]));
    });

    var log = byId('sim-log');
    clear(log);
    sim.log.forEach(function (entry) {
      log.appendChild(el('li', null, [el('span', { 'class': 'log__who', text: entry.who }), doc.createTextNode(entry.text)]));
    });
    log.scrollTop = log.scrollHeight;
  }

  function buildKeypad() {
    var keypad = byId('keypad');
    clear(keypad);
    CF.DTMF_KEYS.forEach(function (k) {
      var btn = el('button', { type: 'button', 'class': 'keypad__key', 'aria-label': k === '*' ? 'Star' : (k === '#' ? 'Pound' : 'Digit ' + k), 'data-key': k }, [
        doc.createTextNode(k),
        el('small', { 'aria-hidden': 'true', text: KEY_LETTERS[k] || ' ' })
      ]);
      btn.addEventListener('click', function () { pressKey(k); });
      keypad.appendChild(btn);
    });
  }

  function pressKey(k) {
    playTone(k);
    simInput({ type: 'digit', value: k }, 'Pressed ' + k);
  }

  /* ---------- export ---------- */

  var TABS = [
    { id: 'sma', label: 'SMA actions', pick: function (b) { return b.sipMediaApplication; }, file: 'sma-actions.json' },
    { id: 'audio', label: 'Audio file variant', pick: function (b) { return b.playAudioVariant; }, file: 'sma-audio-variant.json' },
    { id: 'bridge', label: 'Human bridge', pick: function (b) { return b.humanBridge; }, file: 'human-bridge.json' },
    { id: 'mute', label: 'Mute during review', pick: function (b) { return b.muteWhileReview; }, file: 'mute-attendee.json' },
    { id: 'sms', label: 'SMS v2', pick: function (b) { return b.smsV2; }, file: 'send-text-message.json' },
    { id: 'email', label: 'SES v2', pick: function (b) { return b.sesV2; }, file: 'ses-send-email.json' },
    { id: 'create', label: 'Create SMA', pick: function (b) { return b.createSipMediaApplication; }, file: 'create-sip-media-application.json' },
    { id: 'lambda', label: 'Lambda scaffold', pick: function (b) { return b.lambdaHandler; }, file: 'handler.js' }
  ];

  function currentBundle() {
    return CF.exportAwsCdsBundle(scenario(), { rates: state.rates });
  }

  function renderExport() {
    var bundle = currentBundle();
    var check = CF.validateBundle(bundle);
    var tabsHost = byId('export-tabs');
    clear(tabsHost);
    TABS.forEach(function (t) {
      var selected = t.id === state.exportTab;
      var btn = el('button', { type: 'button', role: 'tab', 'class': 'tab', id: 'tab-' + t.id, 'aria-selected': selected ? 'true' : 'false', 'aria-controls': 'export-panel', tabindex: selected ? '0' : '-1', text: t.label });
      btn.addEventListener('click', function () { state.exportTab = t.id; renderExport(); });
      btn.addEventListener('keydown', function (e) {
        var idx = TABS.indexOf(t);
        var next = null;
        if (e.key === 'ArrowRight') { next = TABS[(idx + 1) % TABS.length]; }
        else if (e.key === 'ArrowLeft') { next = TABS[(idx + TABS.length - 1) % TABS.length]; }
        else if (e.key === 'Home') { next = TABS[0]; }
        else if (e.key === 'End') { next = TABS[TABS.length - 1]; }
        if (next) { e.preventDefault(); state.exportTab = next.id; renderExport(); var nb = byId('tab-' + next.id); if (nb && nb.focus) { nb.focus(); } }
      });
      tabsHost.appendChild(btn);
    });
    var tab = TABS.filter(function (t) { return t.id === state.exportTab; })[0];
    byId('export-panel').setAttribute('aria-labelledby', 'tab-' + tab.id);
    var payload = tab.pick(bundle);
    var text = payload == null ? 'This scenario has no matching step for this target.' : (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
    byId('export-code').textContent = text;
    byId('export-status').textContent = check.ok ? 'Required-field check passed for every template.' : 'Check failed. ' + check.errors.join(' ');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error('Clipboard unavailable'));
  }

  function wireExport() {
    byId('export-copy').addEventListener('click', function () {
      var text = byId('export-code').textContent;
      var status = byId('export-status');
      copyText(text).then(function () { status.textContent = 'Copied.'; }, function () { status.textContent = 'Copy is blocked here. Select the text and copy it by hand.'; });
    });
    byId('export-download').addEventListener('click', function () {
      var bundle = currentBundle();
      var blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = el('a', { href: url, download: 'chimeflow-' + scenario().id + '-bundle.json' });
      doc.body.appendChild(a);
      a.click();
      doc.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  }

  /* ---------- controls ---------- */

  function findLocalTime(sc, tz, targetMinutes) {
    var base = new Date(sc.sendUtc).getTime();
    for (var m = 0; m < 24 * 60; m += 15) {
      var candidate = new Date(base + m * 60000);
      var c = CF.localClock(candidate, tz);
      if (c.minutes === targetMinutes) { return candidate.toISOString(); }
    }
    return sc.sendUtc;
  }

  function applyScenarioDefaults() {
    var sc = scenario();
    state.sendUtc = toLocalInput(sc.sendUtc);
    state.timeZone = sc.timeZone;
    state.replies = sc.defaultInputs.join(', ');
    state.failures = {};
    state.optedOutSms = false;
    state.safetyOverride = false;
    syncControls();
  }

  function syncControls() {
    byId('scenario').value = state.scenarioId;
    byId('send-utc').value = state.sendUtc;
    byId('time-zone').value = state.timeZone;
    byId('replies').value = state.replies;
    byId('opt-out-sms').checked = state.optedOutSms;
    byId('safety-override').checked = state.safetyOverride;
    CF.CHANNEL_IDS.forEach(function (id) { byId('fail-' + id).value = state.failures[id] || ''; });
  }

  function refreshAll(restartSim) {
    renderBench();
    renderInspector();
    renderExport();
    if (restartSim || !state.sim) { simStart(); } else { renderSim(); }
  }

  function wireControls() {
    var select = byId('scenario');
    CF.SCENARIOS.forEach(function (sc) { select.appendChild(el('option', { value: sc.id, text: sc.label })); });
    CF.CHANNEL_IDS.forEach(function (id) {
      var s = byId('fail-' + id);
      FAILURE_MODES.forEach(function (m) { s.appendChild(el('option', { value: m.value, text: m.label })); });
      s.addEventListener('change', function () {
        if (s.value) { state.failures[id] = s.value; } else { delete state.failures[id]; }
        refreshAll(true);
      });
    });
    select.addEventListener('change', function () {
      state.scenarioId = select.value;
      applyScenarioDefaults();
      refreshAll(true);
    });
    byId('send-utc').addEventListener('change', function () { state.sendUtc = byId('send-utc').value || state.sendUtc; refreshAll(true); });
    byId('time-zone').addEventListener('change', function () { state.timeZone = byId('time-zone').value; refreshAll(true); });
    byId('replies').addEventListener('input', function () { state.replies = byId('replies').value; renderBench(); });
    byId('opt-out-sms').addEventListener('change', function () { state.optedOutSms = byId('opt-out-sms').checked; refreshAll(true); });
    byId('safety-override').addEventListener('change', function () { state.safetyOverride = byId('safety-override').checked; refreshAll(true); });
    byId('preset-day').addEventListener('click', function () {
      state.sendUtc = toLocalInput(findLocalTime(scenario(), state.timeZone, 12 * 60));
      syncControls(); refreshAll(true);
    });
    byId('preset-night').addEventListener('click', function () {
      state.sendUtc = toLocalInput(findLocalTime(scenario(), state.timeZone, 22 * 60 + 15));
      syncControls(); refreshAll(true);
    });
    byId('bench-form').addEventListener('submit', function (e) { e.preventDefault(); });

    var msg = byId('msg');
    msg.value = state.message;
    msg.addEventListener('input', function () { state.message = msg.value; renderInspector(); });
    var insert = function (s) { state.message = msg.value + s; msg.value = state.message; renderInspector(); };
    byId('add-quote').addEventListener('click', function () { insert(' Don' + String.fromCharCode(0x2019) + 't be late.'); });
    byId('add-emoji').addEventListener('click', function () { insert(' ' + String.fromCodePoint(0x1F600)); });
    byId('add-brace').addEventListener('click', function () { insert(' {ref}'); });
    byId('add-long').addEventListener('click', function () {
      insert(' Please bring your insurance card, a photo ID and the forms from your last visit. Arrive ten minutes early so the front desk can check you in.');
    });
    byId('rate-seg').value = String(state.rates.smsPerSegment);
    byId('rate-carrier').value = String(state.rates.carrierFeePerSegment);
    var rateInput = function (id, key) {
      byId(id).addEventListener('input', function () {
        var v = parseFloat(byId(id).value);
        state.rates[key] = isFinite(v) && v >= 0 ? v : 0;
        refreshAll(false);
      });
    };
    rateInput('rate-seg', 'smsPerSegment');
    rateInput('rate-carrier', 'carrierFeePerSegment');
    byId('inbound').addEventListener('input', renderInspector);

    byId('sim-send').addEventListener('click', function () {
      var input = byId('sim-text');
      var v = input.value.trim();
      if (!v) { return; }
      input.value = '';
      simInput({ type: 'text', value: v }, v);
    });
    byId('sim-text').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); byId('sim-send').click(); } });
    byId('sim-timeout').addEventListener('click', function () { simInput({ type: 'timeout' }, 'No answer'); });
    byId('sim-restart').addEventListener('click', function () { simStart(); });
    byId('phone').addEventListener('keydown', function (e) {
      var tag = e.target && e.target.tagName ? e.target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'textarea') { return; }
      if (CF.DTMF_KEYS.indexOf(e.key) !== -1 && state.sim && !state.sim.session.done) { pressKey(e.key); }
    });
  }

  function renderHero() {
    var sc = CF.getScenario('clinic-reschedule');
    var trace = CF.simulateConversationTrace(sc, { failures: { CHIME_PSTN_VOICE: 'timeout' }, inputs: ['3'] });
    renderDag(byId('hero-dag'), trace);
  }

  function init() {
    wireControls();
    buildKeypad();
    wireExport();
    applyScenarioDefaults();
    renderHero();
    refreshAll(true);
  }

  init();
})();
