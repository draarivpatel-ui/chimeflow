'use strict';
/*
 * ChimeFlow engine. Pure, deterministic, dependency free.
 * Loads in the browser (window.ChimeFlow) and in Node (require).
 *
 * Every rate, latency and scenario in here is a planning fixture. Rates are
 * illustrative defaults you are expected to edit, not AWS list prices.
 * Scenario organisations are fictional.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ChimeFlow = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  var CHANNEL_IDS = ['CHIME_PSTN_VOICE', 'CHIME_WEBRTC', 'PINPOINT_SMS', 'PINPOINT_WHATSAPP', 'SES_EMAIL'];

  /*
   * Channel fixtures. latencyMs is the planning time from send to delivered
   * (voice: setup plus first prompt). costPerInteraction is in US dollars,
   * per attempt (per SMS segment for SMS). All values are editable defaults.
   * Voice timeoutMs mirrors the documented CallTimeoutSeconds default of 30.
   * PINPOINT_ prefixes are kept as stable identifiers; the services are now
   * AWS End User Messaging SMS and AWS End User Messaging Social.
   */
  var CHANNELS = {
    CHIME_PSTN_VOICE: {
      id: 'CHIME_PSTN_VOICE', short: 'Voice', label: 'Chime SDK PSTN voice',
      service: 'Amazon Chime SDK PSTN Audio', lane: 'voice',
      media: { voice: true, digits: true, text: false, rich: false, attachments: false },
      latencyMs: 4200, timeoutMs: 30000, retries: 1, backoffMs: 3000,
      costPerInteraction: 0.02, perSegment: false,
      tcpaGoverned: true, needsConsentKey: 'voice', failoverTo: 'PINPOINT_SMS'
    },
    CHIME_WEBRTC: {
      id: 'CHIME_WEBRTC', short: 'WebRTC', label: 'Chime SDK in-app audio',
      service: 'Amazon Chime SDK meetings', lane: 'voice',
      media: { voice: true, digits: true, text: false, rich: true, attachments: false },
      latencyMs: 1800, timeoutMs: 20000, retries: 0, backoffMs: 0,
      costPerInteraction: 0.008, perSegment: false,
      tcpaGoverned: false, needsConsentKey: 'app', failoverTo: 'PINPOINT_SMS'
    },
    PINPOINT_SMS: {
      id: 'PINPOINT_SMS', short: 'SMS', label: 'End User Messaging SMS',
      service: 'AWS End User Messaging SMS', lane: 'sms',
      media: { voice: false, digits: true, text: true, rich: false, attachments: false },
      latencyMs: 3000, timeoutMs: 15000, retries: 0, backoffMs: 0,
      costPerInteraction: 0.0075, perSegment: true,
      tcpaGoverned: true, needsConsentKey: 'sms', failoverTo: 'SES_EMAIL'
    },
    PINPOINT_WHATSAPP: {
      id: 'PINPOINT_WHATSAPP', short: 'WhatsApp', label: 'End User Messaging Social',
      service: 'AWS End User Messaging Social', lane: 'sms',
      media: { voice: false, digits: true, text: true, rich: true, attachments: true },
      latencyMs: 2200, timeoutMs: 15000, retries: 0, backoffMs: 0,
      costPerInteraction: 0.005, perSegment: false,
      tcpaGoverned: false, needsConsentKey: 'whatsapp', failoverTo: 'PINPOINT_SMS'
    },
    SES_EMAIL: {
      id: 'SES_EMAIL', short: 'Email', label: 'Amazon SES email',
      service: 'Amazon SES', lane: 'email',
      media: { voice: false, digits: false, text: true, rich: true, attachments: true },
      latencyMs: 9000, timeoutMs: 60000, retries: 0, backoffMs: 0,
      costPerInteraction: 0.0001, perSegment: false,
      tcpaGoverned: false, needsConsentKey: 'email', failoverTo: null
    }
  };

  var LANES = ['voice', 'sms', 'email', 'human'];
  var LANE_LABELS = { voice: 'Voice', sms: 'Text', email: 'Email', human: 'Human bridge' };

  var BRIDGE = {
    id: 'HUMAN_BRIDGE', short: 'Human', label: 'Chime SDK CallAndBridge to agent',
    service: 'Amazon Chime SDK PSTN Audio', lane: 'human',
    latencyMs: 5200, timeoutMs: 30000, costPerInteraction: 0.04
  };

  var RESPONSE_MS = 6000;       // modelled time for a person to answer a prompt
  var NO_RESPONSE_MS = 30000;   // modelled wait before a prompt counts as unanswered
  var CONFIDENCE_THRESHOLD = 0.6;
  var MAX_NODES = 12;

  var DEFAULT_RATES = { smsPerSegment: 0.0075, carrierFeePerSegment: 0.003 };

  var QUIET_START_MIN = 8 * 60;
  var QUIET_END_MIN = 21 * 60;

  var OPT_OUT_KEYWORDS = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT'];
  var HELP_KEYWORDS = ['HELP', 'INFO'];

  /* ---------- GSM-7 and UCS-2 ---------- */

  var GSM7_BASIC = '@£$¥èéùìòÇ\nØø\rÅå' +
    'Δ_ΦΓΛΩΠΨΣΘΞ' +
    'ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§' +
    '¿abcdefghijklmnopqrstuvwxyzäöñüà';
  var GSM7_EXT = '\f^{}\\[~]|€';

  var BASIC_SET = {};
  var EXT_SET = {};
  (function () {
    var i;
    for (i = 0; i < GSM7_BASIC.length; i++) { BASIC_SET[GSM7_BASIC.charAt(i)] = true; }
    for (i = 0; i < GSM7_EXT.length; i++) { EXT_SET[GSM7_EXT.charAt(i)] = true; }
  })();

  function gsmUnits(ch) {
    if (BASIC_SET[ch]) { return 1; }
    if (EXT_SET[ch]) { return 2; }
    return 0;
  }

  function codePoints(text) {
    return Array.from(String(text));
  }

  function isGsm7(text) {
    var chars = codePoints(text);
    for (var i = 0; i < chars.length; i++) {
      if (gsmUnits(chars[i]) === 0) { return false; }
    }
    return true;
  }

  function hex4(n) {
    var s = n.toString(16).toUpperCase();
    while (s.length < 4) { s = '0' + s; }
    return s;
  }

  function codepointLabel(ch) {
    return 'U+' + hex4(ch.codePointAt(0));
  }

  function splitIntoSegments(text) {
    var chars = codePoints(text);
    var gsm = isGsm7(text);
    var single = gsm ? 160 : 70;
    var multi = gsm ? 153 : 67;
    var unitOf = function (c) { return gsm ? gsmUnits(c) : (c.codePointAt(0) > 0xFFFF ? 2 : 1); };
    var total = 0;
    var i;
    for (i = 0; i < chars.length; i++) { total += unitOf(chars[i]); }
    if (total <= single) { return chars.length ? [chars.join('')] : []; }
    var segments = [];
    var cur = '';
    var used = 0;
    for (i = 0; i < chars.length; i++) {
      var u = unitOf(chars[i]);
      if (used + u > multi) { segments.push(cur); cur = ''; used = 0; }
      cur += chars[i];
      used += u;
    }
    if (cur) { segments.push(cur); }
    return segments;
  }

  function analyzeSms(text) {
    var s = String(text == null ? '' : text);
    var chars = codePoints(s);
    var gsm = isGsm7(s);
    var units = 0;
    var forcing = [];
    var extended = [];
    for (var i = 0; i < chars.length; i++) {
      var c = chars[i];
      if (gsm) {
        var g = gsmUnits(c);
        units += g;
        if (g === 2) { extended.push(c); }
      } else {
        units += c.codePointAt(0) > 0xFFFF ? 2 : 1;
        if (gsmUnits(c) === 0 && forcing.indexOf(c) === -1) { forcing.push(c); }
      }
    }
    var segs = splitIntoSegments(s);
    return {
      encoding: gsm ? 'GSM-7' : 'UCS-2',
      characters: chars.length,
      units: units,
      singleLimit: gsm ? 160 : 70,
      multipartLimit: gsm ? 153 : 67,
      segments: segs.length,
      segmentTexts: segs,
      forcingChars: forcing.map(function (c) { return { char: c, codepoint: codepointLabel(c) }; }),
      extendedChars: extended,
      overApiLimit: chars.length > 1600
    };
  }

  function estimateSmsCost(segments, messageCount, rates) {
    var r = rates || DEFAULT_RATES;
    var perSeg = Number(r.smsPerSegment) + Number(r.carrierFeePerSegment);
    return round6(segments * messageCount * perSeg);
  }

  function round6(n) { return Math.round(n * 1e6) / 1e6; }

  /* ---------- PII detection and redaction ---------- */

  function luhnValid(input) {
    var digits = String(input).replace(/[\s-]/g, '');
    if (!/^\d{13,19}$/.test(digits)) { return false; }
    var sum = 0;
    var dbl = false;
    for (var i = digits.length - 1; i >= 0; i--) {
      var d = digits.charCodeAt(i) - 48;
      if (dbl) { d *= 2; if (d > 9) { d -= 9; } }
      sum += d;
      dbl = !dbl;
    }
    return sum % 10 === 0;
  }

  function ssnValid(area, group, serial) {
    if (area === '000' || area === '666' || area.charAt(0) === '9') { return false; }
    return group !== '00' && serial !== '0000';
  }

  function abaValid(nine) {
    if (!/^\d{9}$/.test(nine)) { return false; }
    var d = nine.split('').map(Number);
    var sum = 3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
    return sum % 10 === 0;
  }

  function findAll(text, re, build) {
    var out = [];
    var m;
    re.lastIndex = 0;
    while ((m = re.exec(text)) !== null) {
      var hit = build(m);
      if (hit) { out.push(hit); }
    }
    return out;
  }

  var PRIORITY = { CARD: 1, SSN: 2, ROUTING: 3, ACCOUNT: 4, MRN: 5, DOB: 6, DIAGNOSIS: 7, EMAIL: 8, PHONE: 9 };

  function detectPii(text) {
    var s = String(text == null ? '' : text);
    var found = [];

    found = found.concat(findAll(s, /(?:\d[ -]?){12,18}\d/g, function (m) {
      var before = s.charAt(m.index - 1);
      var after = s.charAt(m.index + m[0].length);
      if (/\d/.test(before) || /\d/.test(after)) { return null; }
      if (!luhnValid(m[0])) { return null; }
      var digits = m[0].replace(/[\s-]/g, '');
      return { type: 'CARD', start: m.index, end: m.index + m[0].length, value: m[0], last4: digits.slice(-4) };
    }));

    found = found.concat(findAll(s, /\b(\d{3})[- ](\d{2})[- ](\d{4})\b/g, function (m) {
      if (!ssnValid(m[1], m[2], m[3])) { return null; }
      return { type: 'SSN', start: m.index, end: m.index + m[0].length, value: m[0], last4: m[3] };
    }));

    found = found.concat(findAll(s, /\b(?:routing(?: number)?|ABA)[:#\s]*(\d{9})\b/gi, function (m) {
      if (!abaValid(m[1])) { return null; }
      var start = m.index + m[0].length - 9;
      return { type: 'ROUTING', start: start, end: start + 9, value: m[1] };
    }));

    found = found.concat(findAll(s, /\baccount(?: number| no\.?)?[:#\s]*(\d{6,17})\b/gi, function (m) {
      var start = m.index + m[0].length - m[1].length;
      return { type: 'ACCOUNT', start: start, end: start + m[1].length, value: m[1], last4: m[1].slice(-4) };
    }));

    found = found.concat(findAll(s, /\b(?:MRN|medical record(?: number)?)[:#\s]*(\d{5,10})\b/gi, function (m) {
      var start = m.index + m[0].length - m[1].length;
      return { type: 'MRN', start: start, end: start + m[1].length, value: m[1] };
    }));

    found = found.concat(findAll(s, /\b(?:DOB|date of birth)[:\s]*(\d{1,2}\/\d{1,2}\/\d{2,4})\b/gi, function (m) {
      var start = m.index + m[0].length - m[1].length;
      return { type: 'DOB', start: start, end: start + m[1].length, value: m[1] };
    }));

    found = found.concat(findAll(s, /\b(?:dx|diagnosis)[:\s]+([A-TV-Z]\d{2}(?:\.\d{1,4})?)\b/gi, function (m) {
      var start = m.index + m[0].length - m[1].length;
      return { type: 'DIAGNOSIS', start: start, end: start + m[1].length, value: m[1] };
    }));

    found = found.concat(findAll(s, /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, function (m) {
      return { type: 'EMAIL', start: m.index, end: m.index + m[0].length, value: m[0] };
    }));

    found = found.concat(findAll(s, /(?:\+?1[ .-]?)?\(?\b\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}\b|\+\d{8,15}\b/g, function (m) {
      var digits = m[0].replace(/\D/g, '');
      if (digits.length < 10) { return null; }
      return { type: 'PHONE', start: m.index, end: m.index + m[0].length, value: m[0], last4: digits.slice(-4) };
    }));

    found.sort(function (a, b) {
      return PRIORITY[a.type] - PRIORITY[b.type] || a.start - b.start;
    });
    var kept = [];
    found.forEach(function (f) {
      var overlaps = kept.some(function (k) { return f.start < k.end && k.start < f.end; });
      if (!overlaps) { kept.push(f); }
    });
    kept.sort(function (a, b) { return a.start - b.start; });
    return kept;
  }

  function maskToken(f) {
    switch (f.type) {
      case 'CARD': return '(CARD ending ' + f.last4 + ')';
      case 'SSN': return '(SSN ending ' + f.last4 + ')';
      case 'ACCOUNT': return '(ACCOUNT ending ' + f.last4 + ')';
      case 'PHONE': return '(PHONE ending ' + f.last4 + ')';
      case 'ROUTING': return '(ROUTING)';
      case 'MRN': return '(MRN)';
      case 'DOB': return '(DOB)';
      case 'DIAGNOSIS': return '(DX)';
      default: return '(EMAIL)';
    }
  }

  function redactPii(text) {
    var s = String(text == null ? '' : text);
    var findings = detectPii(s);
    var out = '';
    var pos = 0;
    findings.forEach(function (f) {
      out += s.slice(pos, f.start) + maskToken(f);
      pos = f.end;
    });
    out += s.slice(pos);
    return { redacted: out, findings: findings.map(function (f) {
      return { type: f.type, start: f.start, end: f.end, mask: maskToken(f) };
    }) };
  }

  /* ---------- opt-out and quiet hours ---------- */

  function detectOptOut(inbound) {
    var t = String(inbound == null ? '' : inbound).trim().replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toUpperCase();
    if (OPT_OUT_KEYWORDS.indexOf(t) !== -1) { return { optOut: true, keyword: t, help: false }; }
    if (HELP_KEYWORDS.indexOf(t) !== -1) { return { optOut: false, keyword: t, help: true }; }
    return { optOut: false, keyword: null, help: false };
  }

  function localClock(nowUtc, timeZone) {
    var d = nowUtc instanceof Date ? nowUtc : new Date(nowUtc);
    if (isNaN(d.getTime())) { throw new RangeError('nowUtc is not a valid instant'); }
    var parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23'
    }).formatToParts(d);
    var hour = 0;
    var minute = 0;
    parts.forEach(function (p) {
      if (p.type === 'hour') { hour = Number(p.value) % 24; }
      if (p.type === 'minute') { minute = Number(p.value); }
    });
    return { hour: hour, minute: minute, minutes: hour * 60 + minute };
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function checkQuietHours(nowUtc, timeZone) {
    var c = localClock(nowUtc, timeZone);
    var quiet = c.minutes < QUIET_START_MIN || c.minutes >= QUIET_END_MIN;
    return {
      timeZone: timeZone, localHour: c.hour, localMinute: c.minute,
      localTime: pad2(c.hour) + ':' + pad2(c.minute),
      quiet: quiet, window: '08:00 to 21:00',
      reason: quiet ? 'Recipient local time ' + pad2(c.hour) + ':' + pad2(c.minute) + ' is outside 08:00 to 21:00.' : null
    };
  }

  /* ---------- message audit ---------- */

  function auditMessagePayload(text, ctx) {
    var c = ctx || {};
    var s = String(text == null ? '' : text);
    var red = redactPii(s);
    var original = analyzeSms(s);
    var after = analyzeSms(red.redacted);
    var issues = [];
    var quiet = null;
    if (c.nowUtc && c.timeZone) {
      quiet = checkQuietHours(c.nowUtc, c.timeZone);
      if (quiet.quiet) { issues.push({ code: 'QUIET_HOURS', severity: 'block', message: quiet.reason }); }
    }
    if (c.optedOut) {
      issues.push({ code: 'OPTED_OUT', severity: 'block', message: 'Recipient previously sent an opt-out keyword.' });
    }
    if (red.findings.length) {
      issues.push({ code: 'PII_MASKED', severity: 'warn', message: red.findings.length + ' sensitive value(s) masked before send.' });
    }
    if (after.overApiLimit) {
      issues.push({ code: 'OVER_1600', severity: 'block', message: 'Body exceeds the 1600 character SendTextMessage limit.' });
    }
    if (original.encoding === 'UCS-2' && original.forcingChars.length) {
      issues.push({ code: 'UCS2_FORCED', severity: 'info', message: 'Characters outside GSM-7 force UCS-2 encoding for the whole message.' });
    }
    var rates = c.rates || DEFAULT_RATES;
    var per10k = estimateSmsCost(after.segments, 10000, rates);
    var blocked = issues.some(function (i) { return i.severity === 'block'; });
    return {
      original: original,
      redacted: red.redacted,
      findings: red.findings,
      sms: after,
      quiet: quiet,
      issues: issues,
      blocked: blocked,
      cost: { per10k: per10k, perMessage: round6(per10k / 10000) }
    };
  }

  /* ---------- DTMF ---------- */

  var DTMF_ROWS = [697, 770, 852, 941];
  var DTMF_COLS = [1209, 1336, 1477];
  var DTMF_LAYOUT = [['1', '2', '3'], ['4', '5', '6'], ['7', '8', '9'], ['*', '0', '#']];
  var DTMF_KEYS = [].concat.apply([], DTMF_LAYOUT);

  function dtmfFrequencies(key) {
    for (var r = 0; r < DTMF_LAYOUT.length; r++) {
      var c = DTMF_LAYOUT[r].indexOf(String(key));
      if (c !== -1) { return [DTMF_ROWS[r], DTMF_COLS[c]]; }
    }
    return null;
  }

  /* ---------- scenarios ---------- */

  function opt(key, label, next, keywords) {
    return { key: key, label: label, next: next, keywords: keywords || [] };
  }

  var SCENARIOS = [
    {
      id: 'clinic-reschedule',
      label: 'Clinic reschedule and nurse escalation',
      title: 'Clinic appointment reschedule with urgent nurse escalation',
      org: 'Riverbend Clinic (fictional)',
      summary: 'Confirm or move a visit by phone, fall back to text, and bridge to a nurse the moment a red flag appears.',
      safetyCritical: true,
      start: 'greet', escalation: 'nurse_bridge',
      timeZone: 'America/New_York', sendUtc: '2026-11-03T16:00:00Z',
      consent: { voice: true, sms: true, whatsapp: false, email: true, app: false },
      redFlags: ['chest pain', 'cannot breathe', 'can\'t breathe', 'bleeding', 'overdose', 'faint'],
      defaultInputs: ['2', '1'],
      nodes: {
        greet: { id: 'greet', kind: 'prompt', channels: ['CHIME_PSTN_VOICE', 'PINPOINT_SMS', 'SES_EMAIL'],
          text: 'Riverbend Clinic here. Press 1 to confirm Thursday at 10:15, 2 to reschedule, 3 to talk to a nurse now.',
          options: [opt('1', 'Confirm visit', 'confirmed', ['confirm', 'yes', 'keep']),
            opt('2', 'Reschedule', 'pick_slot', ['reschedule', 'move', 'change', 'different day']),
            opt('3', 'Nurse now', 'nurse_bridge', ['nurse', 'talk to someone', 'person'])],
          timeoutNext: 'sms_nudge' },
        sms_nudge: { id: 'sms_nudge', kind: 'prompt', channels: ['PINPOINT_SMS', 'SES_EMAIL'],
          text: 'We could not reach you by phone. Reply 1 to confirm Thursday, 2 to reschedule, 3 for a nurse call.',
          options: [opt('1', 'Confirm visit', 'confirmed', ['confirm', 'yes']),
            opt('2', 'Reschedule', 'pick_slot', ['reschedule', 'move', 'change']),
            opt('3', 'Nurse call', 'nurse_bridge', ['nurse', 'call me'])],
          timeoutNext: 'email_summary' },
        pick_slot: { id: 'pick_slot', kind: 'prompt', channels: ['CHIME_PSTN_VOICE', 'PINPOINT_SMS'],
          text: 'Press 1 for Friday at 9:30, 2 for Monday at 2:00, 3 for another time.',
          options: [opt('1', 'Friday 9:30', 'booked', ['friday']),
            opt('2', 'Monday 2:00', 'booked', ['monday']),
            opt('3', 'Another time', 'email_summary', ['another', 'other', 'later'])],
          timeoutNext: 'email_summary' },
        confirmed: { id: 'confirmed', kind: 'notify', terminal: true, channels: ['PINPOINT_SMS', 'SES_EMAIL'],
          text: 'Thursday visit confirmed. Reply STOP to end reminders.' },
        booked: { id: 'booked', kind: 'notify', terminal: true, channels: ['PINPOINT_SMS', 'SES_EMAIL'],
          text: 'Your new time is saved. Reply STOP to end reminders.' },
        email_summary: { id: 'email_summary', kind: 'notify', terminal: true, channels: ['SES_EMAIL'],
          text: 'Open times for your visit are listed in this email. Reply to this message and the front desk will book you.' },
        nurse_bridge: { id: 'nurse_bridge', kind: 'bridge', terminal: true, channels: ['CHIME_PSTN_VOICE'],
          text: 'Connecting you to a nurse now.', bridgeTo: 'nurse line' }
      }
    },
    {
      id: 'outage-dispatch',
      label: 'Power outage dispatch',
      title: 'Power outage field dispatch',
      org: 'Northline Power (fictional)',
      summary: 'Tell a customer about an outage, flag medical-equipment households for priority, and bridge to dispatch.',
      safetyCritical: true,
      start: 'notice', escalation: 'dispatch_bridge',
      timeZone: 'America/Chicago', sendUtc: '2026-11-03T20:30:00Z',
      consent: { voice: true, sms: true, whatsapp: false, email: true, app: false },
      redFlags: ['oxygen', 'ventilator', 'dialysis', 'smell gas', 'downed line', 'sparks'],
      defaultInputs: ['1', '1'],
      nodes: {
        notice: { id: 'notice', kind: 'prompt', channels: ['PINPOINT_SMS', 'CHIME_PSTN_VOICE', 'SES_EMAIL'],
          text: 'Northline Power: outage on your street, crew estimate 2 hours. Reply 1 if you rely on medical equipment, 2 if power is back, 3 for a dispatch call.',
          options: [opt('1', 'Medical equipment', 'priority', ['medical', 'equipment', 'oxygen']),
            opt('2', 'Power restored', 'closed', ['back', 'restored', 'on again']),
            opt('3', 'Dispatch call', 'dispatch_bridge', ['call', 'dispatch', 'person'])],
          timeoutNext: 'closed_email' },
        priority: { id: 'priority', kind: 'prompt', channels: ['PINPOINT_SMS', 'CHIME_PSTN_VOICE'],
          text: 'Reply 1 to flag your address for priority crews, 2 to speak with dispatch.',
          options: [opt('1', 'Flag address', 'flagged', ['flag', 'priority', 'yes']),
            opt('2', 'Dispatch', 'dispatch_bridge', ['dispatch', 'speak', 'talk'])],
          timeoutNext: 'dispatch_bridge' },
        flagged: { id: 'flagged', kind: 'notify', terminal: true, channels: ['PINPOINT_SMS', 'SES_EMAIL'],
          text: 'Your address is flagged for priority crews. Reply STOP to end outage texts.' },
        closed: { id: 'closed', kind: 'notify', terminal: true, channels: ['PINPOINT_SMS', 'SES_EMAIL'],
          text: 'Thanks, we have closed this outage notice. Reply STOP to end outage texts.' },
        closed_email: { id: 'closed_email', kind: 'notify', terminal: true, channels: ['SES_EMAIL'],
          text: 'We could not reach you by text or phone. Outage updates will arrive by email.' },
        dispatch_bridge: { id: 'dispatch_bridge', kind: 'bridge', terminal: true, channels: ['CHIME_PSTN_VOICE'],
          text: 'Connecting you to a dispatcher now.', bridgeTo: 'dispatch line' }
      }
    },
    {
      id: 'flight-rebook',
      label: 'Flight disruption rebooking',
      title: 'Flight disruption rebooking',
      org: 'Skyway Air (fictional)',
      summary: 'Offer two replacement flights over WhatsApp first, fall back to SMS and email, hand to an agent on request.',
      safetyCritical: false,
      start: 'disruption', escalation: 'agent_bridge',
      timeZone: 'America/Los_Angeles', sendUtc: '2026-11-03T18:00:00Z',
      consent: { voice: true, sms: true, whatsapp: true, email: true, app: true },
      redFlags: ['stranded', 'medical', 'unaccompanied'],
      defaultInputs: ['2'],
      nodes: {
        disruption: { id: 'disruption', kind: 'prompt', channels: ['PINPOINT_WHATSAPP', 'PINPOINT_SMS', 'SES_EMAIL'],
          text: 'Skyway Air: flight SK 418 is cancelled. Reply 1 for the 6:40 PM flight, 2 for tomorrow at 7:10 AM, 3 for an agent.',
          options: [opt('1', 'Tonight 6:40 PM', 'rebooked', ['tonight', 'evening', '6:40']),
            opt('2', 'Tomorrow 7:10 AM', 'rebooked', ['tomorrow', 'morning', '7:10']),
            opt('3', 'Agent', 'agent_bridge', ['agent', 'person', 'human'])],
          timeoutNext: 'email_options' },
        rebooked: { id: 'rebooked', kind: 'notify', terminal: true, channels: ['PINPOINT_WHATSAPP', 'PINPOINT_SMS', 'SES_EMAIL'],
          text: 'You are rebooked. Your new boarding pass is in your email. Reply STOP to end flight texts.' },
        email_options: { id: 'email_options', kind: 'notify', terminal: true, channels: ['SES_EMAIL'],
          text: 'Your flight was cancelled. Replacement options and a rebooking link are in this email.' },
        agent_bridge: { id: 'agent_bridge', kind: 'bridge', terminal: true, channels: ['CHIME_WEBRTC', 'CHIME_PSTN_VOICE'],
          text: 'Connecting you to a rebooking agent.', bridgeTo: 'rebooking desk' }
      }
    },
    {
      id: 'fraud-verify',
      label: 'High-value fraud verification',
      title: 'High-value fraud verification',
      org: 'Harbor Credit Union (fictional)',
      summary: 'Ask the member to verify a large purchase by phone, freeze the card on a no, and bridge to a specialist.',
      safetyCritical: false,
      start: 'verify', escalation: 'specialist_bridge',
      timeZone: 'America/New_York', sendUtc: '2026-11-03T19:00:00Z',
      consent: { voice: true, sms: true, whatsapp: false, email: true, app: false },
      redFlags: ['stolen', 'scam', 'hacked', 'identity'],
      defaultInputs: ['2', '1'],
      nodes: {
        verify: { id: 'verify', kind: 'prompt', channels: ['CHIME_PSTN_VOICE', 'PINPOINT_SMS', 'SES_EMAIL'],
          text: 'Harbor Credit Union: did you make a 1,240 dollar purchase at Lakeside Electronics on the card ending 4242? Press 1 for yes, 2 for no, 3 for a fraud specialist.',
          options: [opt('1', 'Yes, it was me', 'cleared', ['yes', 'mine', 'me']),
            opt('2', 'No, not me', 'freeze', ['no', 'not me', 'did not']),
            opt('3', 'Specialist', 'specialist_bridge', ['specialist', 'person', 'agent'])],
          timeoutNext: 'hold_notice' },
        freeze: { id: 'freeze', kind: 'prompt', channels: ['CHIME_PSTN_VOICE', 'PINPOINT_SMS'],
          text: 'We froze the card. Press 1 to order a replacement, 2 to speak with a specialist.',
          options: [opt('1', 'Order replacement', 'replacement', ['replacement', 'order', 'new card']),
            opt('2', 'Specialist', 'specialist_bridge', ['specialist', 'person'])],
          timeoutNext: 'replacement' },
        cleared: { id: 'cleared', kind: 'notify', terminal: true, channels: ['PINPOINT_SMS', 'SES_EMAIL'],
          text: 'Thanks, the purchase is approved. Reply STOP to end fraud alerts.' },
        replacement: { id: 'replacement', kind: 'notify', terminal: true, channels: ['PINPOINT_SMS', 'SES_EMAIL'],
          text: 'A replacement card is on its way. Reply STOP to end fraud alerts.' },
        hold_notice: { id: 'hold_notice', kind: 'notify', terminal: true, channels: ['PINPOINT_SMS', 'SES_EMAIL'],
          text: 'We placed a temporary hold on your card. Call the number on the back to release it.' },
        specialist_bridge: { id: 'specialist_bridge', kind: 'bridge', terminal: true, channels: ['CHIME_PSTN_VOICE'],
          text: 'Connecting you to a fraud specialist.', bridgeTo: 'fraud desk' }
      }
    }
  ];

  function getScenario(id) {
    for (var i = 0; i < SCENARIOS.length; i++) {
      if (SCENARIOS[i].id === id) { return SCENARIOS[i]; }
    }
    return null;
  }

  /* ---------- intent classification and state machine ---------- */

  function normalizeText(t) {
    return String(t == null ? '' : t).toLowerCase().replace(/[^a-z0-9:' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function containsPhrase(norm, phrase) {
    var p = normalizeText(phrase);
    if (!p) { return false; }
    return (' ' + norm + ' ').indexOf(' ' + p + ' ') !== -1;
  }

  function classifyIntent(utterance, options) {
    var norm = normalizeText(utterance);
    var opts = options || [];
    var i;
    for (i = 0; i < opts.length; i++) {
      if (norm === opts[i].key) { return { option: opts[i], confidence: 1, score: 99, reason: 'exact key' }; }
    }
    var scores = opts.map(function (o) {
      var s = 0;
      (o.keywords || []).forEach(function (k) { if (containsPhrase(norm, k)) { s += 2; } });
      return s;
    });
    var top = -1;
    var topScore = 0;
    var second = 0;
    for (i = 0; i < scores.length; i++) {
      if (scores[i] > topScore) { second = topScore; topScore = scores[i]; top = i; }
      else if (scores[i] > second) { second = scores[i]; }
    }
    if (top === -1) { return { option: null, confidence: 0, score: 0, reason: 'no keyword matched' }; }
    var conf = Math.round((topScore / (topScore + second + 1)) * 1000) / 1000;
    return { option: opts[top], confidence: conf, score: topScore, reason: 'keyword score ' + topScore + ' vs ' + second };
  }

  function hasRedFlag(scenario, utterance) {
    var norm = normalizeText(utterance);
    var flags = scenario.redFlags || [];
    for (var i = 0; i < flags.length; i++) {
      if (containsPhrase(norm, flags[i])) { return flags[i]; }
    }
    return null;
  }

  function createSession(scenario) {
    return { scenarioId: scenario.id, nodeId: scenario.start, invalid: 0, done: false, escalated: null, history: [scenario.start] };
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function moveTo(session, nodeId, scenario, escalation) {
    var s = clone(session);
    s.nodeId = nodeId;
    s.history.push(nodeId);
    s.invalid = 0;
    var n = scenario.nodes[nodeId];
    if (escalation) { s.escalated = escalation; }
    if (n && n.terminal) { s.done = true; }
    return s;
  }

  function escalate(session, scenario, reason) {
    return moveTo(session, scenario.escalation, scenario, reason);
  }

  function advance(session, event, scenario) {
    var sc = scenario || getScenario(session.scenarioId);
    var node = sc.nodes[session.nodeId];
    if (session.done || !node || !node.options) {
      return { session: session, result: { matched: false, reason: 'no input expected at this step' } };
    }
    if (event.type === 'digit') {
      var hit = node.options.filter(function (o) { return o.key === String(event.value); })[0];
      if (hit) {
        return { session: moveTo(session, hit.next, sc), result: { matched: true, option: hit.key, reason: 'digit ' + hit.key, confidence: 1 } };
      }
      var bad = clone(session);
      bad.invalid += 1;
      if (bad.invalid >= 2) {
        return { session: escalate(bad, sc, 'repeated_invalid_input'), result: { matched: false, reason: 'second invalid digit, escalating to a human', escalated: 'repeated_invalid_input' } };
      }
      return { session: bad, result: { matched: false, reason: 'invalid digit ' + event.value + ', reprompting' } };
    }
    if (event.type === 'text') {
      var flag = hasRedFlag(sc, event.value);
      if (flag) {
        return { session: escalate(session, sc, 'red_flag'), result: { matched: false, reason: 'red flag phrase "' + flag + '"', escalated: 'red_flag', confidence: 1 } };
      }
      var cls = classifyIntent(event.value, node.options);
      if (cls.option && cls.confidence >= CONFIDENCE_THRESHOLD) {
        return { session: moveTo(session, cls.option.next, sc), result: { matched: true, option: cls.option.key, reason: cls.reason, confidence: cls.confidence } };
      }
      return { session: escalate(session, sc, 'low_confidence'), result: { matched: false, reason: 'confidence ' + cls.confidence + ' is below ' + CONFIDENCE_THRESHOLD, escalated: 'low_confidence', confidence: cls.confidence } };
    }
    if (event.type === 'timeout') {
      if (node.timeoutNext) {
        return { session: moveTo(session, node.timeoutNext, sc), result: { matched: false, reason: 'no response, following timeout branch', timedOut: true } };
      }
      return { session: escalate(session, sc, 'no_response'), result: { matched: false, reason: 'no response, escalating', escalated: 'no_response', timedOut: true } };
    }
    return { session: session, result: { matched: false, reason: 'unknown event type' } };
  }

  /* ---------- routing policy ---------- */

  function normalizeContext(scenario, opts) {
    var o = opts || {};
    return {
      timeZone: o.timeZone || scenario.timeZone,
      nowUtc: o.nowUtc || scenario.sendUtc,
      consent: Object.assign({}, scenario.consent, o.consent || {}),
      optedOut: o.optedOut || [],
      down: o.down || [],
      failures: o.failures || {},
      safetyOverride: !!o.safetyOverride,
      rates: o.rates || DEFAULT_RATES
    };
  }

  function evaluateRoutingPolicy(scenario, ctx, nodeId, offsetMs) {
    var c = ctx.nowUtc ? ctx : normalizeContext(scenario, ctx);
    var node = scenario.nodes[nodeId || scenario.start];
    var at = new Date(new Date(c.nowUtc).getTime() + (offsetMs || 0));
    var quiet = checkQuietHours(at, c.timeZone);
    var overrideActive = c.safetyOverride && scenario.safetyCritical;
    var ordered = node.channels.map(function (id) {
      var ch = CHANNELS[id];
      var reasons = [];
      if (c.down.indexOf(id) !== -1) { reasons.push('carrier path marked down'); }
      if (c.optedOut.indexOf(id) !== -1) { reasons.push('recipient opted out'); }
      if (!c.consent[ch.needsConsentKey]) { reasons.push('no ' + ch.needsConsentKey + ' consent on file'); }
      if (ch.tcpaGoverned && quiet.quiet && !overrideActive) { reasons.push('quiet hours at ' + quiet.localTime + ' local'); }
      if (node.kind === 'bridge' && !ch.media.voice) { reasons.push('channel cannot carry a voice bridge'); }
      return { channel: id, allowed: reasons.length === 0, reasons: reasons };
    });
    var first = ordered.filter(function (o) { return o.allowed; })[0] || null;
    return { nodeId: node.id, ordered: ordered, chosen: first ? first.channel : null, quiet: quiet, overrideActive: overrideActive };
  }

  /* ---------- trace simulation ---------- */

  /*
   * Authoring wording follows the channel. Voice prompts say "Press 1",
   * text channels say "Reply 1". The node text in the fixtures can use either.
   */
  function renderNodeText(node, channelId) {
    var ch = CHANNELS[channelId];
    var text = node.text;
    if (ch && ch.media.voice) { return text.replace(/\bReply (\d)\b/g, 'Press $1'); }
    return text.replace(/\bPress (\d)\b/g, 'Reply $1');
  }

  function deliverNode(scenario, node, ctx, startMs) {
    var policy = evaluateRoutingPolicy(scenario, ctx, node.id, startMs);
    var attempts = [];
    var t = startMs;
    var delivered = null;
    var smsAudit = null;
    var blocked = policy.ordered.filter(function (o) { return !o.allowed; });
    var candidates = policy.ordered.filter(function (o) { return o.allowed; });
    for (var i = 0; i < candidates.length && !delivered; i++) {
      var ch = CHANNELS[candidates[i].channel];
      var failure = ctx.failures[ch.id] || null;
      if (node.kind === 'bridge' && failure === 'timeout') { failure = null; } // no-answer describes the person, not the path
      var tries = failure === 'timeout' ? ch.retries + 1 : 1;
      var segments = 1;
      if (ch.id === 'PINPOINT_SMS') {
        smsAudit = auditMessagePayload(renderNodeText(node, ch.id), { rates: ctx.rates });
        segments = smsAudit.sms.segments;
      }
      for (var n = 0; n < tries && !delivered; n++) {
        var dur;
        var status;
        if (failure === 'timeout') { dur = ch.timeoutMs; status = 'timeout'; }
        else if (failure === 'undeliverable') { dur = ch.latencyMs; status = 'undeliverable'; }
        else if (failure === 'carrier_down') { dur = 800; status = 'carrier_down'; }
        else { dur = ch.latencyMs; status = 'delivered'; }
        var cost = round6(ch.costPerInteraction * (ch.perSegment ? segments : 1));
        attempts.push({ channel: ch.id, lane: ch.lane, startMs: t, endMs: t + dur, status: status, attempt: n + 1, costUsd: cost });
        t += dur;
        if (status === 'delivered') { delivered = ch.id; }
        else if (n < tries - 1) { t += ch.backoffMs; }
      }
    }
    return { attempts: attempts, deliveredOn: delivered, endMs: t, policy: policy, blocked: blocked, smsAudit: smsAudit };
  }

  function inputToEvent(raw) {
    if (raw === 'timeout') { return { type: 'timeout' }; }
    if (/^[0-9*#]$/.test(String(raw))) { return { type: 'digit', value: String(raw) }; }
    return { type: 'text', value: String(raw) };
  }

  function simulateConversationTrace(scenario, opts) {
    var o = opts || {};
    var ctx = normalizeContext(scenario, o);
    var inputs = (o.inputs || scenario.defaultInputs).slice();
    var session = createSession(scenario);
    var steps = [];
    var t = 0;
    var totalCost = 0;
    var warnings = [];
    var handoff = null;
    var escalatedOnce = false;
    var guard = 0;

    while (guard++ < MAX_NODES) {
      var node = scenario.nodes[session.nodeId];
      var d = deliverNode(scenario, node, ctx, t);
      var attemptCost = d.attempts.reduce(function (s, a) { return s + a.costUsd; }, 0);
      totalCost += attemptCost;
      var step = {
        nodeId: node.id, kind: node.kind, text: node.text, startMs: t, endMs: d.endMs,
        attempts: d.attempts, deliveredOn: d.deliveredOn, blocked: d.blocked,
        smsAudit: d.smsAudit ? { encoding: d.smsAudit.sms.encoding, segments: d.smsAudit.sms.segments, characters: d.smsAudit.sms.characters } : null,
        input: null, result: null
      };
      t = d.endMs;

      if (!d.deliveredOn) {
        warnings.push('No channel could deliver "' + node.id + '".');
        steps.push(step);
        if (node.kind !== 'bridge' && !escalatedOnce) {
          escalatedOnce = true;
          session = escalate(session, scenario, 'undeliverable');
          continue;
        }
        session = clone(session);
        session.done = true;
        session.unreachable = true;
        break;
      }

      if (node.kind === 'bridge') {
        t += BRIDGE.latencyMs;
        totalCost += BRIDGE.costPerInteraction;
        step.attempts.push({ channel: BRIDGE.id, lane: 'human', startMs: d.endMs, endMs: t, status: 'delivered', attempt: 1, costUsd: BRIDGE.costPerInteraction });
        step.endMs = t;
        handoff = { nodeId: node.id, reason: session.escalated || 'requested', bridgeTo: node.bridgeTo, atMs: t };
        steps.push(step);
        break;
      }

      if (node.terminal || !node.options) { steps.push(step); break; }

      var raw = inputs.length ? inputs.shift() : 'timeout';
      var ev = inputToEvent(raw);
      t += ev.type === 'timeout' ? NO_RESPONSE_MS : RESPONSE_MS;
      step.input = { raw: String(raw), type: ev.type };
      var adv = advance(session, ev, scenario);
      step.result = adv.result;
      step.endMs = t;
      steps.push(step);
      session = adv.session;
      if (session.escalated && !escalatedOnce) { escalatedOnce = true; }
    }

    var used = [];
    steps.forEach(function (s) { s.attempts.forEach(function (a) { if (used.indexOf(a.channel) === -1) { used.push(a.channel); } }); });
    var failovers = 0;
    steps.forEach(function (s) {
      var seen = [];
      s.attempts.forEach(function (a) { if (a.channel !== BRIDGE.id && seen.indexOf(a.channel) === -1) { seen.push(a.channel); } });
      if (seen.length > 1) { failovers += seen.length - 1; }
    });

    return {
      scenarioId: scenario.id, steps: steps, totalMs: t, totalCostUsd: round6(totalCost),
      channelsUsed: used, failovers: failovers, handoff: handoff, warnings: warnings,
      finalNode: session.nodeId, unreachable: !!session.unreachable, path: session.history,
      context: { timeZone: ctx.timeZone, nowUtc: ctx.nowUtc, safetyOverride: ctx.safetyOverride }
    };
  }

  /* ---------- AWS exporter ---------- */

  var E164 = /^\+[1-9]\d{1,14}$/;

  function speech(text) {
    return { Text: text, Engine: 'neural', LanguageCode: 'en-US', TextType: 'text', VoiceId: 'Joanna' };
  }

  function digitRegex(options) {
    return '^[' + options.map(function (o) { return o.key; }).join('') + ']$';
  }

  function buildSpeakAndGetDigits(node, callId) {
    return {
      Type: 'SpeakAndGetDigits',
      Parameters: {
        CallId: callId,
        InputDigitsRegex: digitRegex(node.options),
        SpeechParameters: speech(renderNodeText(node, 'CHIME_PSTN_VOICE')),
        FailureSpeechParameters: { Text: 'That was not one of the choices. Please try again.', Engine: 'neural', LanguageCode: 'en-US', TextType: 'text', VoiceId: 'Joanna' },
        MinNumberOfDigits: 1,
        MaxNumberOfDigits: 1,
        Repeat: 2,
        RepeatDurationInMilliseconds: 8000
      }
    };
  }

  function buildPlayAudioAndGetDigits(node, callId, bucket, keyBase) {
    return {
      Type: 'PlayAudioAndGetDigits',
      Parameters: {
        CallId: callId,
        InputDigitsRegex: digitRegex(node.options),
        AudioSource: { Type: 'S3', BucketName: bucket, Key: keyBase + '/' + node.id + '.wav' },
        FailureAudioSource: { Type: 'S3', BucketName: bucket, Key: keyBase + '/invalid-choice.wav' },
        MinNumberOfDigits: 1,
        MaxNumberOfDigits: 1,
        Repeat: 2,
        RepeatDurationInMilliseconds: 8000
      }
    };
  }

  function buildCallAndBridge(callerId, agentNumber) {
    return {
      Type: 'CallAndBridge',
      Parameters: {
        CallTimeoutSeconds: 30,
        CallerIdNumber: callerId,
        Endpoints: [{ BridgeEndpointType: 'PSTN', Uri: agentNumber }]
      }
    };
  }

  function buildMute(meetingId, callId) {
    return {
      Type: 'ModifyChimeMeetingAttendees',
      Parameters: {
        Operation: 'Mute',
        MeetingId: meetingId,
        CallId: callId,
        ParticipantTag: 'LEG-B',
        AttendeeList: ['REPLACE_WITH_ATTENDEE_ID']
      }
    };
  }

  function maxPriceFor(segments, rates) {
    var perSeg = Number(rates.smsPerSegment) + Number(rates.carrierFeePerSegment);
    var cap = Math.max(perSeg * segments * 2, 0.00001);
    return cap.toFixed(5);
  }

  function lambdaSource(scenario) {
    var flow = {};
    Object.keys(scenario.nodes).forEach(function (id) {
      var n = scenario.nodes[id];
      var entry = { kind: n.kind, text: renderNodeText(n, 'CHIME_PSTN_VOICE') };
      if (n.options) {
        entry.options = {};
        n.options.forEach(function (op) { entry.options[op.key] = op.next; });
      }
      if (n.timeoutNext) { entry.timeoutNext = n.timeoutNext; }
      flow[id] = entry;
    });
    var lines = [];
    lines.push('// Generated by ChimeFlow for scenario "' + scenario.id + '". A starting scaffold, not a deployed function.');
    lines.push('// Voice-only walk of the flow. Replace the placeholders before you deploy.');
    lines.push('const FLOW = ' + JSON.stringify(flow, null, 2) + ';');
    lines.push('const START = ' + JSON.stringify(scenario.start) + ';');
    lines.push('const ESCALATION = ' + JSON.stringify(scenario.escalation) + ';');
    lines.push('const CALLER_ID = "+15555550100";');
    lines.push('const AGENT_NUMBER = "+15555550123";');
    lines.push('');
    lines.push('const voice = (text) => ({ Text: text, Engine: "neural", LanguageCode: "en-US", TextType: "text", VoiceId: "Joanna" });');
    lines.push('');
    lines.push('function actionFor(nodeId, callId) {');
    lines.push('  const node = FLOW[nodeId];');
    lines.push('  if (node.kind === "bridge") {');
    lines.push('    return { Type: "CallAndBridge", Parameters: { CallTimeoutSeconds: 30, CallerIdNumber: CALLER_ID, Endpoints: [{ BridgeEndpointType: "PSTN", Uri: AGENT_NUMBER }] } };');
    lines.push('  }');
    lines.push('  if (node.options) {');
    lines.push('    return { Type: "SpeakAndGetDigits", Parameters: { CallId: callId, InputDigitsRegex: "^[" + Object.keys(node.options).join("") + "]$", SpeechParameters: voice(node.text), FailureSpeechParameters: voice("That was not one of the choices. Please try again."), MinNumberOfDigits: 1, MaxNumberOfDigits: 1, Repeat: 2, RepeatDurationInMilliseconds: 8000 } };');
    lines.push('  }');
    lines.push('  return { Type: "Speak", Parameters: Object.assign({ CallId: callId }, voice(node.text)) };');
    lines.push('}');
    lines.push('');
    lines.push('exports.handler = async (event) => {');
    lines.push('  const callId = event.CallDetails.Participants[0].CallId;');
    lines.push('  const attrs = event.CallDetails.TransactionAttributes || {};');
    lines.push('  let nodeId = attrs.node || START;');
    lines.push('  const type = event.InvocationEventType;');
    lines.push('  if (type === "ACTION_SUCCESSFUL" && event.ActionData.Type === "SpeakAndGetDigits") {');
    lines.push('    nodeId = FLOW[nodeId].options[event.ActionData.ReceivedDigits] || nodeId;');
    lines.push('  } else if (type === "ACTION_FAILED") {');
    lines.push('    nodeId = FLOW[nodeId].timeoutNext || ESCALATION;');
    lines.push('  } else if (type === "ACTION_SUCCESSFUL" && FLOW[nodeId].kind === "notify") {');
    lines.push('    return { SchemaVersion: "1.0", Actions: [{ Type: "Hangup", Parameters: { CallId: callId, SipResponseCode: "0" } }] };');
    lines.push('  } else if (type === "HANGUP") {');
    lines.push('    return { SchemaVersion: "1.0", Actions: [] };');
    lines.push('  }');
    lines.push('  return { SchemaVersion: "1.0", Actions: [actionFor(nodeId, callId)], TransactionAttributes: { node: nodeId } };');
    lines.push('};');
    return lines.join('\n');
  }

  function exportAwsCdsBundle(scenario, options) {
    var o = options || {};
    var callId = o.callId || 'REPLACE_WITH_CALL_ID';
    var callerId = o.callerIdNumber || '+15555550100';
    var agentNumber = o.agentNumber || '+15555550123';
    var rates = o.rates || DEFAULT_RATES;
    var region = o.region || 'us-east-1';
    var start = scenario.nodes[scenario.start];
    var firstVoicePrompt = start.options && start.channels.indexOf('CHIME_PSTN_VOICE') !== -1 ? start : null;
    var smsNode = null;
    var smsNodeId = Object.keys(scenario.nodes).filter(function (id) {
      var n = scenario.nodes[id];
      return n.kind !== 'bridge' && n.channels.indexOf('PINPOINT_SMS') !== -1;
    })[0];
    if (smsNodeId) { smsNode = scenario.nodes[smsNodeId]; }
    var emailNodeId = Object.keys(scenario.nodes).filter(function (id) {
      return scenario.nodes[id].channels.indexOf('SES_EMAIL') !== -1;
    })[0];
    var emailNode = scenario.nodes[emailNodeId];

    var bundle = {
      meta: {
        scenario: scenario.id,
        note: 'Structural templates built from the documented request shapes. Not deployed, not sent, not run against live AWS.',
        placeholders: ['REPLACE_WITH_CALL_ID', 'REPLACE_ORIGINATION_IDENTITY', 'REPLACE_WITH_ATTENDEE_ID', 'REPLACE_WITH_MEETING_ID', 'REPLACE_LAMBDA_ARN', 'REPLACE_BUCKET']
      },
      createSipMediaApplication: {
        AwsRegion: region,
        Name: 'chimeflow-' + scenario.id,
        Endpoints: [{ LambdaArn: 'REPLACE_LAMBDA_ARN' }]
      },
      sipMediaApplication: {
        SchemaVersion: '1.0',
        Actions: firstVoicePrompt ? [buildSpeakAndGetDigits(firstVoicePrompt, callId)] : [],
        TransactionAttributes: { node: scenario.start }
      },
      playAudioVariant: firstVoicePrompt ? {
        SchemaVersion: '1.0',
        Actions: [buildPlayAudioAndGetDigits(firstVoicePrompt, callId, 'REPLACE_BUCKET', 'chimeflow/' + scenario.id)]
      } : null,
      humanBridge: { SchemaVersion: '1.0', Actions: [buildCallAndBridge(callerId, agentNumber)] },
      muteWhileReview: { SchemaVersion: '1.0', Actions: [buildMute('REPLACE_WITH_MEETING_ID', callId)] },
      smsV2: null,
      sesV2: null,
      lambdaHandler: lambdaSource(scenario)
    };

    if (smsNode) {
      var red = redactPii(renderNodeText(smsNode, 'PINPOINT_SMS')).redacted;
      var segs = analyzeSms(red).segments;
      bundle.smsV2 = {
        DestinationPhoneNumber: '+15555550123',
        OriginationIdentity: 'REPLACE_ORIGINATION_IDENTITY',
        MessageBody: red,
        MessageType: 'TRANSACTIONAL',
        MaxPrice: maxPriceFor(segs, rates),
        Context: { scenario: scenario.id, node: smsNode.id },
        DryRun: true
      };
    }
    if (emailNode) {
      var emailBody = redactPii(renderNodeText(emailNode, 'SES_EMAIL')).redacted;
      bundle.sesV2 = {
        FromEmailAddress: 'notices@example.com',
        Destination: { ToAddresses: ['recipient@example.com'] },
        Content: { Simple: {
          Subject: { Data: scenario.org.replace(/ \(fictional\)$/, '') + ': ' + scenario.title, Charset: 'UTF-8' },
          Body: { Text: { Data: emailBody, Charset: 'UTF-8' } }
        } },
        EmailTags: [{ Name: 'scenario', Value: scenario.id }]
      };
    }
    return bundle;
  }

  function validateBundle(bundle) {
    var errors = [];
    var need = function (cond, msg) { if (!cond) { errors.push(msg); } };
    var actionLists = [bundle.sipMediaApplication, bundle.playAudioVariant, bundle.humanBridge, bundle.muteWhileReview];
    actionLists.forEach(function (resp) {
      if (!resp) { return; }
      need(resp.SchemaVersion === '1.0', 'SchemaVersion must be "1.0"');
      need(Array.isArray(resp.Actions), 'Actions must be an array');
      (resp.Actions || []).forEach(function (a) {
        var p = a.Parameters || {};
        if (a.Type === 'SpeakAndGetDigits') {
          need(typeof p.CallId === 'string' && p.CallId.length > 0, 'SpeakAndGetDigits needs CallId');
          need(p.SpeechParameters && typeof p.SpeechParameters.Text === 'string' && p.SpeechParameters.Text.length > 0, 'SpeakAndGetDigits needs SpeechParameters.Text');
          need(p.FailureSpeechParameters && typeof p.FailureSpeechParameters.Text === 'string', 'SpeakAndGetDigits needs FailureSpeechParameters.Text when set');
          need(p.RepeatDurationInMilliseconds > 0, 'SpeakAndGetDigits needs RepeatDurationInMilliseconds');
          need(p.MaxNumberOfDigits >= p.MinNumberOfDigits, 'MaxNumberOfDigits must not be below MinNumberOfDigits');
          need(['neural', 'standard'].indexOf(p.SpeechParameters && p.SpeechParameters.Engine) !== -1, 'Engine must be neural or standard');
        } else if (a.Type === 'PlayAudioAndGetDigits') {
          need(p.AudioSource && p.AudioSource.Type === 'S3' && p.AudioSource.BucketName && p.AudioSource.Key, 'PlayAudioAndGetDigits needs an S3 AudioSource with BucketName and Key');
          need(p.FailureAudioSource && p.FailureAudioSource.Type === 'S3', 'PlayAudioAndGetDigits needs a FailureAudioSource');
          need(p.RepeatDurationInMilliseconds > 0, 'PlayAudioAndGetDigits needs RepeatDurationInMilliseconds');
        } else if (a.Type === 'CallAndBridge') {
          need(E164.test(p.CallerIdNumber || ''), 'CallAndBridge CallerIdNumber must be E.164');
          need(p.CallTimeoutSeconds >= 1 && p.CallTimeoutSeconds <= 120, 'CallTimeoutSeconds must be 1 to 120');
          need(Array.isArray(p.Endpoints) && p.Endpoints.length > 0, 'CallAndBridge needs Endpoints');
          (p.Endpoints || []).forEach(function (e) {
            need(['PSTN', 'AWS'].indexOf(e.BridgeEndpointType) !== -1, 'BridgeEndpointType must be PSTN or AWS');
            if (e.BridgeEndpointType === 'PSTN') { need(E164.test(e.Uri || ''), 'PSTN endpoint Uri must be E.164'); }
          });
        } else if (a.Type === 'ModifyChimeMeetingAttendees') {
          need(['Mute', 'Unmute'].indexOf(p.Operation) !== -1, 'Operation must be Mute or Unmute');
          need(typeof p.MeetingId === 'string' && p.MeetingId.length > 0, 'MeetingId is required');
          need(Array.isArray(p.AttendeeList) && p.AttendeeList.length >= 1 && p.AttendeeList.length <= 100, 'AttendeeList needs 1 to 100 ids');
        } else {
          errors.push('Unexpected action type ' + a.Type);
        }
      });
    });
    var sms = bundle.smsV2;
    if (sms) {
      need(/^\+?[1-9][0-9]{1,18}$/.test(sms.DestinationPhoneNumber), 'DestinationPhoneNumber must be E.164');
      need(typeof sms.MessageBody === 'string' && sms.MessageBody.length >= 1 && sms.MessageBody.length <= 1600, 'MessageBody must be 1 to 1600 characters');
      need(['TRANSACTIONAL', 'PROMOTIONAL'].indexOf(sms.MessageType) !== -1, 'MessageType must be TRANSACTIONAL or PROMOTIONAL');
      need(/^[0-9]{0,2}\.[0-9]{1,5}$/.test(sms.MaxPrice), 'MaxPrice must match [0-9]{0,2}.[0-9]{1,5}');
      need(Object.keys(sms.Context || {}).length <= 5, 'Context holds at most 5 entries');
    }
    var ses = bundle.sesV2;
    if (ses) {
      need(ses.Content && ses.Content.Simple && ses.Content.Simple.Subject && ses.Content.Simple.Subject.Data, 'SES Simple content needs a Subject');
      need(ses.Content && ses.Content.Simple && ses.Content.Simple.Body && ses.Content.Simple.Body.Text && ses.Content.Simple.Body.Text.Data, 'SES Simple content needs a Text body');
      need(ses.Destination && ses.Destination.ToAddresses && ses.Destination.ToAddresses.length > 0, 'SES Destination needs ToAddresses');
    }
    return { ok: errors.length === 0, errors: errors };
  }

  return {
    CHANNELS: CHANNELS, CHANNEL_IDS: CHANNEL_IDS, LANES: LANES, LANE_LABELS: LANE_LABELS, BRIDGE: BRIDGE,
    SCENARIOS: SCENARIOS, DEFAULT_RATES: DEFAULT_RATES, CONFIDENCE_THRESHOLD: CONFIDENCE_THRESHOLD,
    RESPONSE_MS: RESPONSE_MS, NO_RESPONSE_MS: NO_RESPONSE_MS,
    OPT_OUT_KEYWORDS: OPT_OUT_KEYWORDS, GSM7_BASIC: GSM7_BASIC, GSM7_EXT: GSM7_EXT,
    DTMF_ROWS: DTMF_ROWS, DTMF_COLS: DTMF_COLS, DTMF_LAYOUT: DTMF_LAYOUT, DTMF_KEYS: DTMF_KEYS,
    getScenario: getScenario,
    isGsm7: isGsm7, splitIntoSegments: splitIntoSegments, analyzeSms: analyzeSms, estimateSmsCost: estimateSmsCost,
    luhnValid: luhnValid, abaValid: abaValid, detectPii: detectPii, redactPii: redactPii,
    detectOptOut: detectOptOut, localClock: localClock, checkQuietHours: checkQuietHours,
    auditMessagePayload: auditMessagePayload,
    dtmfFrequencies: dtmfFrequencies,
    classifyIntent: classifyIntent, createSession: createSession, advance: advance, normalizeContext: normalizeContext,
    evaluateRoutingPolicy: evaluateRoutingPolicy, simulateConversationTrace: simulateConversationTrace,
    planDelivery: deliverNode, renderNodeText: renderNodeText, escalateSession: escalate,
    exportAwsCdsBundle: exportAwsCdsBundle, validateBundle: validateBundle
  };
});
