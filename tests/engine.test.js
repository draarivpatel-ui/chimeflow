'use strict';
/*
 * ChimeFlow engine tests. Dash and emoji characters are built from code
 * points so this file stays free of them.
 */
const test = require('node:test');
const assert = require('node:assert');
const CF = require('../engine.js');

const EM = String.fromCharCode(0x2014);
const SMART = String.fromCharCode(0x2019);
const SMILE = String.fromCodePoint(0x1F600);

/* ---------- GSM-7 and UCS-2 ---------- */

test('GSM-7 basic table holds 127 characters', () => {
  assert.strictEqual(CF.GSM7_BASIC.length, 127);
});

test('GSM-7 extension table holds 10 characters', () => {
  assert.strictEqual(CF.GSM7_EXT.length, 10);
});

test('plain ASCII text is GSM-7', () => {
  assert.strictEqual(CF.analyzeSms('Hello there, your visit is at 10:15.').encoding, 'GSM-7');
});

test('160 GSM-7 characters fit one segment', () => {
  const r = CF.analyzeSms('a'.repeat(160));
  assert.strictEqual(r.segments, 1);
  assert.strictEqual(r.units, 160);
});

test('161 GSM-7 characters need two segments', () => {
  assert.strictEqual(CF.analyzeSms('a'.repeat(161)).segments, 2);
});

test('306 GSM-7 characters fill two multipart segments exactly', () => {
  assert.strictEqual(CF.analyzeSms('a'.repeat(306)).segments, 2);
});

test('307 GSM-7 characters spill into a third segment', () => {
  assert.strictEqual(CF.analyzeSms('a'.repeat(307)).segments, 3);
});

test('GSM-7 extension characters cost two units', () => {
  const r = CF.analyzeSms('{}');
  assert.strictEqual(r.units, 4);
  assert.strictEqual(r.characters, 2);
  assert.strictEqual(r.encoding, 'GSM-7');
});

test('the euro sign is an extension character, not a UCS-2 trigger', () => {
  const r = CF.analyzeSms('€');
  assert.strictEqual(r.encoding, 'GSM-7');
  assert.strictEqual(r.units, 2);
});

test('80 extension characters hit the 160 unit limit in one segment', () => {
  assert.strictEqual(CF.analyzeSms('{'.repeat(80)).segments, 1);
  assert.strictEqual(CF.analyzeSms('{'.repeat(81)).segments, 2);
});

test('an extension pair never splits across a segment boundary', () => {
  const text = 'a'.repeat(152) + '{' + 'a'.repeat(20);
  const segs = CF.splitIntoSegments(text);
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(segs[0].length, 152);
  assert.ok(segs[1].startsWith('{'));
});

test('a smart apostrophe forces UCS-2', () => {
  const r = CF.analyzeSms('Don' + SMART + 't be late');
  assert.strictEqual(r.encoding, 'UCS-2');
  assert.strictEqual(r.forcingChars[0].codepoint, 'U+2019');
});

test('70 UCS-2 characters fit one segment', () => {
  assert.strictEqual(CF.analyzeSms(SMART.repeat(70)).segments, 1);
});

test('71 UCS-2 characters need two segments', () => {
  assert.strictEqual(CF.analyzeSms(SMART.repeat(71)).segments, 2);
});

test('134 UCS-2 characters fit two multipart segments', () => {
  assert.strictEqual(CF.analyzeSms(SMART.repeat(134)).segments, 2);
});

test('135 UCS-2 characters spill into three segments', () => {
  assert.strictEqual(CF.analyzeSms(SMART.repeat(135)).segments, 3);
});

test('an emoji counts as two UCS-2 units', () => {
  const r = CF.analyzeSms(SMILE);
  assert.strictEqual(r.encoding, 'UCS-2');
  assert.strictEqual(r.characters, 1);
  assert.strictEqual(r.units, 2);
});

test('an emoji pair never splits across UCS-2 segments', () => {
  const text = SMART.repeat(66) + SMILE + SMART.repeat(5);
  const segs = CF.splitIntoSegments(text);
  assert.strictEqual(segs.length, 2);
  assert.strictEqual(Array.from(segs[0]).length, 66);
  assert.ok(segs[1].startsWith(SMILE));
});

test('a single non-GSM character moves the whole message to UCS-2', () => {
  assert.strictEqual(CF.analyzeSms('a'.repeat(100) + EM).encoding, 'UCS-2');
  assert.strictEqual(CF.analyzeSms('a'.repeat(100) + EM).segments, 2);
});

test('empty text has zero segments', () => {
  assert.strictEqual(CF.analyzeSms('').segments, 0);
});

test('a body over 1600 characters is flagged', () => {
  assert.strictEqual(CF.analyzeSms('a'.repeat(1601)).overApiLimit, true);
  assert.strictEqual(CF.analyzeSms('a'.repeat(1600)).overApiLimit, false);
});

test('estimateSmsCost multiplies segments, count and both rates', () => {
  const c = CF.estimateSmsCost(2, 10000, { smsPerSegment: 0.01, carrierFeePerSegment: 0.005 });
  assert.strictEqual(c, 300);
});

/* ---------- PII ---------- */

test('Luhn accepts a valid test card number', () => {
  assert.strictEqual(CF.luhnValid('4242 4242 4242 4242'), true);
});

test('Luhn rejects a number with one wrong digit', () => {
  assert.strictEqual(CF.luhnValid('4242 4242 4242 4241'), false);
});

test('Luhn rejects too short and too long digit runs', () => {
  assert.strictEqual(CF.luhnValid('424242'), false);
  assert.strictEqual(CF.luhnValid('4'.repeat(20)), false);
});

test('a Luhn-valid card is masked down to its last four', () => {
  const r = CF.redactPii('Card 4242-4242-4242-4242 on file.');
  assert.strictEqual(r.redacted, 'Card (CARD ending 4242) on file.');
});

test('a Luhn-invalid digit run is left alone', () => {
  const r = CF.redactPii('Order 4242 4242 4242 4241 shipped.');
  assert.strictEqual(r.findings.length, 0);
});

test('an SSN is masked down to its last four', () => {
  assert.strictEqual(CF.redactPii('SSN 123-45-6789').redacted, 'SSN (SSN ending 6789)');
});

test('invalid SSN areas and groups are not masked', () => {
  assert.strictEqual(CF.redactPii('000-12-3456').findings.length, 0);
  assert.strictEqual(CF.redactPii('666-12-3456').findings.length, 0);
  assert.strictEqual(CF.redactPii('900-12-3456').findings.length, 0);
  assert.strictEqual(CF.redactPii('123-00-3456').findings.length, 0);
  assert.strictEqual(CF.redactPii('123-45-0000').findings.length, 0);
});

test('US phone formats are masked', () => {
  assert.strictEqual(CF.redactPii('Call (703) 555-0142 today').redacted, 'Call (PHONE ending 0142) today');
  assert.strictEqual(CF.redactPii('Call 703-555-0142').findings.length, 1);
  assert.strictEqual(CF.redactPii('Call +1 703 555 0142').findings.length, 1);
});

test('an E.164 international number is masked', () => {
  assert.strictEqual(CF.redactPii('Reach me at +447911123456').findings[0].type, 'PHONE');
});

test('email addresses are masked', () => {
  assert.strictEqual(CF.redactPii('Write to maya@example.org please').redacted, 'Write to (EMAIL) please');
});

test('a card number is not double counted as a phone number', () => {
  const r = CF.redactPii('4242 4242 4242 4242');
  assert.strictEqual(r.findings.length, 1);
  assert.strictEqual(r.findings[0].type, 'CARD');
});

test('a medical record number is masked', () => {
  assert.strictEqual(CF.redactPii('MRN: 4471920 is ready').redacted, 'MRN: (MRN) is ready');
});

test('a labelled date of birth is masked', () => {
  assert.strictEqual(CF.redactPii('DOB 04/12/1988').redacted, 'DOB (DOB)');
});

test('a diagnosis code after a label is masked', () => {
  assert.strictEqual(CF.redactPii('Dx: E11.9 noted').redacted, 'Dx: (DX) noted');
});

test('a checksum-valid ABA routing number is masked', () => {
  assert.strictEqual(CF.abaValid('021000021'), true);
  assert.strictEqual(CF.redactPii('routing number 021000021').redacted, 'routing number (ROUTING)');
});

test('a bad routing checksum is not masked', () => {
  assert.strictEqual(CF.abaValid('021000022'), false);
  assert.strictEqual(CF.redactPii('routing 021000022').findings.length, 0);
});

test('a labelled account number is masked to its last four', () => {
  assert.strictEqual(CF.redactPii('account number 000123456789').redacted, 'account number (ACCOUNT ending 6789)');
});

test('text with no sensitive values is returned untouched', () => {
  const t = 'Your visit is Thursday at 10:15. Reply 1 to confirm.';
  assert.strictEqual(CF.redactPii(t).redacted, t);
});

test('mask tokens use only GSM-7 basic characters', () => {
  const r = CF.redactPii('4242 4242 4242 4242 and 123-45-6789 and (703) 555-0142 and a@b.co and MRN 123456');
  assert.strictEqual(CF.analyzeSms(r.redacted).encoding, 'GSM-7');
  assert.strictEqual(CF.analyzeSms(r.redacted).extendedChars.length, 0);
});

/* ---------- opt-out ---------- */

test('STOP, UNSUBSCRIBE and CANCEL are opt-out keywords', () => {
  ['STOP', 'UNSUBSCRIBE', 'CANCEL'].forEach((k) => assert.strictEqual(CF.detectOptOut(k).optOut, true, k));
});

test('opt-out detection ignores case, spacing and trailing punctuation', () => {
  assert.strictEqual(CF.detectOptOut('  stop. ').optOut, true);
  assert.strictEqual(CF.detectOptOut('Unsubscribe!').keyword, 'UNSUBSCRIBE');
});

test('a sentence that merely contains stop is not an opt-out', () => {
  assert.strictEqual(CF.detectOptOut('please do not stop the reminders').optOut, false);
});

test('HELP is recognised separately from opt-out', () => {
  const r = CF.detectOptOut('help');
  assert.strictEqual(r.optOut, false);
  assert.strictEqual(r.help, true);
});

/* ---------- quiet hours ---------- */

test('local clock follows the recipient zone', () => {
  assert.strictEqual(CF.localClock('2026-11-03T16:00:00Z', 'America/New_York').hour, 11);
  assert.strictEqual(CF.localClock('2026-11-03T16:00:00Z', 'Asia/Kolkata').minute, 30);
});

test('07:59 local is quiet and 08:00 is not', () => {
  assert.strictEqual(CF.checkQuietHours('2026-11-03T12:59:00Z', 'America/New_York').quiet, true);
  assert.strictEqual(CF.checkQuietHours('2026-11-03T13:00:00Z', 'America/New_York').quiet, false);
});

test('20:59 local is allowed and 21:00 is quiet', () => {
  assert.strictEqual(CF.checkQuietHours('2026-11-04T01:59:00Z', 'America/New_York').quiet, false);
  assert.strictEqual(CF.checkQuietHours('2026-11-04T02:00:00Z', 'America/New_York').quiet, true);
});

test('midnight local reads as hour zero, not 24', () => {
  const c = CF.checkQuietHours('2026-11-04T05:00:00Z', 'America/New_York');
  assert.strictEqual(c.localHour, 0);
  assert.strictEqual(c.quiet, true);
});

test('daylight saving shifts the quiet window in UTC', () => {
  assert.strictEqual(CF.checkQuietHours('2026-07-01T12:30:00Z', 'America/New_York').quiet, false);
  assert.strictEqual(CF.checkQuietHours('2026-12-01T12:30:00Z', 'America/New_York').quiet, true);
  assert.strictEqual(CF.checkQuietHours('2026-07-01T12:30:00Z', 'Europe/London').quiet, false);
});

test('an invalid instant throws', () => {
  assert.throws(() => CF.checkQuietHours('not a time', 'America/New_York'), RangeError);
});

/* ---------- audit ---------- */

test('audit blocks a send inside quiet hours', () => {
  const r = CF.auditMessagePayload('Hello', { nowUtc: '2026-11-04T03:00:00Z', timeZone: 'America/New_York' });
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.issues[0].code, 'QUIET_HOURS');
});

test('audit allows a daytime send', () => {
  const r = CF.auditMessagePayload('Hello', { nowUtc: '2026-11-03T16:00:00Z', timeZone: 'America/New_York' });
  assert.strictEqual(r.blocked, false);
});

test('audit blocks a send to an opted-out recipient', () => {
  const r = CF.auditMessagePayload('Hello', { optedOut: true });
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.issues[0].code, 'OPTED_OUT');
});

test('audit reports masked values as a warning, not a block', () => {
  const r = CF.auditMessagePayload('Card 4242 4242 4242 4242');
  assert.strictEqual(r.blocked, false);
  assert.strictEqual(r.issues[0].severity, 'warn');
});

test('audit explains why a smart apostrophe forced UCS-2, and stays quiet for plain text', () => {
  const forced = CF.auditMessagePayload('Don' + SMART + 't');
  assert.ok(forced.issues.some((i) => i.code === 'UCS2_FORCED'));
  const plain = CF.auditMessagePayload('Dont');
  assert.ok(!plain.issues.some((i) => i.code === 'UCS2_FORCED'));
});

test('audit counts segments after masking', () => {
  const r = CF.auditMessagePayload('4242 4242 4242 4242');
  assert.strictEqual(r.sms.characters, '(CARD ending 4242)'.length);
});

test('audit prices ten thousand messages from the supplied rates', () => {
  const r = CF.auditMessagePayload('Hello', { rates: { smsPerSegment: 0.01, carrierFeePerSegment: 0 } });
  assert.strictEqual(r.cost.per10k, 100);
  assert.strictEqual(r.cost.perMessage, 0.01);
});

test('audit blocks a body over the API limit', () => {
  const r = CF.auditMessagePayload('a'.repeat(1601));
  assert.strictEqual(r.blocked, true);
});

/* ---------- DTMF ---------- */

test('DTMF digit 1 is 697 and 1209 Hz', () => {
  assert.deepStrictEqual(CF.dtmfFrequencies('1'), [697, 1209]);
});

test('DTMF digit 5 is 770 and 1336 Hz', () => {
  assert.deepStrictEqual(CF.dtmfFrequencies('5'), [770, 1336]);
});

test('DTMF star and pound use the bottom row', () => {
  assert.deepStrictEqual(CF.dtmfFrequencies('*'), [941, 1209]);
  assert.deepStrictEqual(CF.dtmfFrequencies('#'), [941, 1477]);
});

test('DTMF zero uses the middle column on the bottom row', () => {
  assert.deepStrictEqual(CF.dtmfFrequencies('0'), [941, 1336]);
});

test('every keypad key has a unique frequency pair', () => {
  const seen = new Set(CF.DTMF_KEYS.map((k) => CF.dtmfFrequencies(k).join('+')));
  assert.strictEqual(seen.size, 12);
});

test('an unknown key has no frequencies', () => {
  assert.strictEqual(CF.dtmfFrequencies('x'), null);
});

/* ---------- intents and state machine ---------- */

const clinic = CF.getScenario('clinic-reschedule');

test('an exact key classifies with full confidence', () => {
  const r = CF.classifyIntent('2', clinic.nodes.greet.options);
  assert.strictEqual(r.option.key, '2');
  assert.strictEqual(r.confidence, 1);
});

test('one keyword hit clears the 0.6 confidence gate', () => {
  const r = CF.classifyIntent('I need to reschedule', clinic.nodes.greet.options);
  assert.strictEqual(r.option.key, '2');
  assert.ok(r.confidence >= CF.CONFIDENCE_THRESHOLD);
});

test('two competing keywords fall below the confidence gate', () => {
  const r = CF.classifyIntent('confirm or reschedule', clinic.nodes.greet.options);
  assert.ok(r.confidence < CF.CONFIDENCE_THRESHOLD);
});

test('no keyword gives zero confidence and no option', () => {
  const r = CF.classifyIntent('banana', clinic.nodes.greet.options);
  assert.strictEqual(r.option, null);
  assert.strictEqual(r.confidence, 0);
});

test('a digit moves the session to the matching node', () => {
  const s = CF.createSession(clinic);
  const r = CF.advance(s, { type: 'digit', value: '2' }, clinic);
  assert.strictEqual(r.session.nodeId, 'pick_slot');
  assert.deepStrictEqual(r.session.history, ['greet', 'pick_slot']);
});

test('advance never mutates the session it was given', () => {
  const s = CF.createSession(clinic);
  CF.advance(s, { type: 'digit', value: '1' }, clinic);
  assert.strictEqual(s.nodeId, 'greet');
});

test('one invalid digit reprompts, a second escalates to a human', () => {
  const s = CF.createSession(clinic);
  const a = CF.advance(s, { type: 'digit', value: '9' }, clinic);
  assert.strictEqual(a.session.nodeId, 'greet');
  const b = CF.advance(a.session, { type: 'digit', value: '8' }, clinic);
  assert.strictEqual(b.session.nodeId, 'nurse_bridge');
  assert.strictEqual(b.session.escalated, 'repeated_invalid_input');
});

test('a red flag phrase escalates regardless of confidence', () => {
  const s = CF.createSession(clinic);
  const r = CF.advance(s, { type: 'text', value: 'I have chest pain but also want to confirm' }, clinic);
  assert.strictEqual(r.session.nodeId, 'nurse_bridge');
  assert.strictEqual(r.result.escalated, 'red_flag');
});

test('low confidence text escalates to a human', () => {
  const s = CF.createSession(clinic);
  const r = CF.advance(s, { type: 'text', value: 'banana' }, clinic);
  assert.strictEqual(r.result.escalated, 'low_confidence');
});

test('a timeout follows the node timeout branch', () => {
  const s = CF.createSession(clinic);
  const r = CF.advance(s, { type: 'timeout' }, clinic);
  assert.strictEqual(r.session.nodeId, 'sms_nudge');
});

test('a terminal node accepts no further input', () => {
  const s = CF.advance(CF.createSession(clinic), { type: 'digit', value: '1' }, clinic).session;
  assert.strictEqual(s.done, true);
  const r = CF.advance(s, { type: 'digit', value: '1' }, clinic);
  assert.strictEqual(r.result.matched, false);
});

/* ---------- routing policy ---------- */

test('policy picks the first preferred channel when nothing blocks it', () => {
  const ctx = CF.normalizeContext(clinic, {});
  assert.strictEqual(CF.evaluateRoutingPolicy(clinic, ctx, 'greet').chosen, 'CHIME_PSTN_VOICE');
});

test('quiet hours block voice and SMS but not email', () => {
  const ctx = CF.normalizeContext(clinic, { nowUtc: '2026-11-04T03:00:00Z' });
  const p = CF.evaluateRoutingPolicy(clinic, ctx, 'greet');
  assert.strictEqual(p.chosen, 'SES_EMAIL');
  assert.ok(p.ordered[0].reasons.join(' ').includes('quiet hours'));
});

test('the safety override lifts quiet hours only for safety critical scenarios', () => {
  const night = '2026-11-04T03:00:00Z';
  const on = CF.normalizeContext(clinic, { nowUtc: night, safetyOverride: true });
  assert.strictEqual(CF.evaluateRoutingPolicy(clinic, on, 'greet').chosen, 'CHIME_PSTN_VOICE');
  const fraud = CF.getScenario('fraud-verify');
  const off = CF.normalizeContext(fraud, { nowUtc: night, safetyOverride: true });
  assert.strictEqual(CF.evaluateRoutingPolicy(fraud, off, 'verify').chosen, 'SES_EMAIL');
});

test('an opted-out SMS channel is skipped', () => {
  const ctx = CF.normalizeContext(clinic, { optedOut: ['CHIME_PSTN_VOICE', 'PINPOINT_SMS'] });
  assert.strictEqual(CF.evaluateRoutingPolicy(clinic, ctx, 'greet').chosen, 'SES_EMAIL');
});

test('missing consent blocks a channel with a reason', () => {
  const flight = CF.getScenario('flight-rebook');
  const ctx = CF.normalizeContext(flight, { consent: { whatsapp: false } });
  const p = CF.evaluateRoutingPolicy(flight, ctx, 'disruption');
  assert.strictEqual(p.ordered[0].allowed, false);
  assert.ok(p.ordered[0].reasons[0].includes('consent'));
  assert.strictEqual(p.chosen, 'PINPOINT_SMS');
});

test('a channel marked down is skipped', () => {
  const ctx = CF.normalizeContext(clinic, { down: ['CHIME_PSTN_VOICE'] });
  assert.strictEqual(CF.evaluateRoutingPolicy(clinic, ctx, 'greet').chosen, 'PINPOINT_SMS');
});

test('the clock advances with the offset, so a long failover can cross into quiet hours', () => {
  const ctx = CF.normalizeContext(clinic, { nowUtc: '2026-11-04T01:59:00Z' });
  assert.strictEqual(CF.evaluateRoutingPolicy(clinic, ctx, 'greet', 0).quiet.quiet, false);
  assert.strictEqual(CF.evaluateRoutingPolicy(clinic, ctx, 'greet', 120000).quiet.quiet, true);
});

/* ---------- traces ---------- */

test('every scenario completes a default trace without warnings', () => {
  CF.SCENARIOS.forEach((s) => {
    const t = CF.simulateConversationTrace(s);
    assert.deepStrictEqual(t.warnings, [], s.id);
    assert.ok(t.steps.length >= 1, s.id);
  });
});

test('the default clinic trace is deterministic', () => {
  const a = JSON.stringify(CF.simulateConversationTrace(clinic));
  const b = JSON.stringify(CF.simulateConversationTrace(clinic));
  assert.strictEqual(a, b);
});

test('a healthy trace ends at a terminal node with no failovers', () => {
  const t = CF.simulateConversationTrace(clinic, { inputs: ['1'] });
  assert.strictEqual(t.finalNode, 'confirmed');
  assert.strictEqual(t.failovers, 0);
  assert.strictEqual(t.handoff, null);
});

test('a voice timeout retries once then fails over to SMS', () => {
  const t = CF.simulateConversationTrace(clinic, { failures: { CHIME_PSTN_VOICE: 'timeout' }, inputs: ['1'] });
  const first = t.steps[0].attempts.map((a) => a.channel + ':' + a.status);
  assert.deepStrictEqual(first, ['CHIME_PSTN_VOICE:timeout', 'CHIME_PSTN_VOICE:timeout', 'PINPOINT_SMS:delivered']);
  assert.strictEqual(t.failovers, 1);
});

test('a voice timeout costs the documented 30 second call timeout per attempt', () => {
  const t = CF.simulateConversationTrace(clinic, { failures: { CHIME_PSTN_VOICE: 'timeout' }, inputs: ['1'] });
  const a = t.steps[0].attempts[0];
  assert.strictEqual(a.endMs - a.startMs, 30000);
  assert.strictEqual(t.steps[0].attempts[1].startMs, 30000 + CF.CHANNELS.CHIME_PSTN_VOICE.backoffMs);
});

test('an undeliverable SMS is not retried', () => {
  const t = CF.simulateConversationTrace(clinic, { failures: { CHIME_PSTN_VOICE: 'carrier_down', PINPOINT_SMS: 'undeliverable' }, inputs: ['1'] });
  const sms = t.steps[0].attempts.filter((a) => a.channel === 'PINPOINT_SMS');
  assert.strictEqual(sms.length, 1);
  assert.strictEqual(t.steps[0].deliveredOn, 'SES_EMAIL');
});

test('only a timeout earns a voice retry, a carrier outage fails fast', () => {
  const down = CF.simulateConversationTrace(clinic, { failures: { CHIME_PSTN_VOICE: 'carrier_down' }, inputs: ['1'] });
  assert.strictEqual(down.steps[0].attempts.filter((a) => a.channel === 'CHIME_PSTN_VOICE').length, 1);
  assert.strictEqual(down.steps[0].attempts[0].endMs, 800);
});

test('a no-answer timeout does not stop a requested bridge from connecting', () => {
  const t = CF.simulateConversationTrace(clinic, { failures: { CHIME_PSTN_VOICE: 'timeout' }, inputs: ['3'] });
  assert.ok(t.handoff);
  assert.strictEqual(t.handoff.nodeId, 'nurse_bridge');
});

test('a carrier-down voice path does stop a bridge', () => {
  const t = CF.simulateConversationTrace(clinic, { failures: { CHIME_PSTN_VOICE: 'carrier_down' }, inputs: ['3'] });
  assert.strictEqual(t.handoff, null);
  assert.strictEqual(t.unreachable, true);
});

test('pressing 3 reaches the nurse bridge and records a human handoff', () => {
  const t = CF.simulateConversationTrace(clinic, { inputs: ['3'] });
  assert.strictEqual(t.handoff.bridgeTo, 'nurse line');
  assert.strictEqual(t.steps[t.steps.length - 1].attempts.slice(-1)[0].channel, 'HUMAN_BRIDGE');
});

test('a red flag reply escalates and the trace records why', () => {
  const t = CF.simulateConversationTrace(clinic, { inputs: ['I cannot breathe'] });
  assert.strictEqual(t.handoff.reason, 'red_flag');
});

test('running out of replies counts as no answer', () => {
  const t = CF.simulateConversationTrace(clinic, { inputs: [] });
  assert.strictEqual(t.steps[0].input.type, 'timeout');
});

test('a no-answer wait adds 30 seconds, a reply adds 6 seconds', () => {
  const fast = CF.simulateConversationTrace(clinic, { inputs: ['1'] });
  const slow = CF.simulateConversationTrace(clinic, { inputs: ['timeout', '1'] });
  assert.strictEqual(fast.steps[0].endMs - fast.steps[0].attempts[0].endMs, CF.RESPONSE_MS);
  assert.strictEqual(slow.steps[0].endMs - slow.steps[0].attempts[0].endMs, CF.NO_RESPONSE_MS);
});

test('quiet hours push the whole trace onto email', () => {
  const t = CF.simulateConversationTrace(clinic, { nowUtc: '2026-11-04T03:00:00Z', inputs: ['1'] });
  assert.deepStrictEqual(t.channelsUsed, ['SES_EMAIL']);
  assert.ok(t.steps[0].blocked.length >= 2);
});

test('an undeliverable prompt escalates once to the human bridge and the bridge still connects', () => {
  const flight = CF.getScenario('flight-rebook');
  const failures = { PINPOINT_WHATSAPP: 'carrier_down', PINPOINT_SMS: 'carrier_down', SES_EMAIL: 'carrier_down' };
  const t = CF.simulateConversationTrace(flight, { failures });
  assert.deepStrictEqual(t.path, ['disruption', 'agent_bridge']);
  assert.strictEqual(t.handoff.reason, 'undeliverable');
  assert.strictEqual(t.unreachable, false);
});

test('with every channel down the trace ends unreachable', () => {
  const failures = { CHIME_PSTN_VOICE: 'carrier_down', PINPOINT_SMS: 'carrier_down', SES_EMAIL: 'carrier_down' };
  const t = CF.simulateConversationTrace(clinic, { failures });
  assert.strictEqual(t.unreachable, true);
  assert.ok(t.warnings.length >= 1);
});

test('trace cost counts every attempt, so failures raise it', () => {
  const ok = CF.simulateConversationTrace(clinic, { inputs: ['1'] });
  const bad = CF.simulateConversationTrace(clinic, { failures: { CHIME_PSTN_VOICE: 'timeout' }, inputs: ['1'] });
  assert.ok(bad.totalCostUsd > ok.totalCostUsd);
});

test('SMS delivery in a trace carries its encoding and segment count', () => {
  const t = CF.simulateConversationTrace(clinic, { failures: { CHIME_PSTN_VOICE: 'carrier_down' }, inputs: ['1'] });
  assert.strictEqual(t.steps[0].smsAudit.encoding, 'GSM-7');
  assert.strictEqual(t.steps[0].smsAudit.segments, 1);
});

test('only SMS deliveries carry an SMS audit, and failed SMS attempts are billed per segment', () => {
  const voice = CF.simulateConversationTrace(clinic, { inputs: ['1'] });
  assert.strictEqual(voice.steps[0].smsAudit, null);
  const email = CF.simulateConversationTrace(clinic, { nowUtc: '2026-11-04T03:00:00Z', inputs: ['1'] });
  assert.strictEqual(email.steps[0].smsAudit, null);
  const text = CF.simulateConversationTrace(clinic, { failures: { CHIME_PSTN_VOICE: 'carrier_down' }, inputs: ['1'] });
  assert.ok(text.steps[0].smsAudit);
  const segs = text.steps[0].smsAudit.segments;
  const smsCost = text.steps[0].attempts.filter((a) => a.channel === 'PINPOINT_SMS')[0].costUsd;
  assert.strictEqual(smsCost, CF.CHANNELS.PINPOINT_SMS.costPerInteraction * segs);
});

test('voice text says Press and text channels say Reply', () => {
  const n = clinic.nodes.greet;
  assert.ok(CF.renderNodeText(n, 'CHIME_PSTN_VOICE').includes('Press 1'));
  assert.ok(CF.renderNodeText(n, 'PINPOINT_SMS').includes('Reply 1'));
  assert.ok(CF.renderNodeText(CF.getScenario('outage-dispatch').nodes.notice, 'CHIME_PSTN_VOICE').includes('Press 1'));
});

test('flight rebooking tries WhatsApp first and falls back to SMS when it is undeliverable', () => {
  const flight = CF.getScenario('flight-rebook');
  const t = CF.simulateConversationTrace(flight, { failures: { PINPOINT_WHATSAPP: 'undeliverable' }, inputs: ['1'] });
  assert.deepStrictEqual(t.steps[0].attempts.map((a) => a.channel), ['PINPOINT_WHATSAPP', 'PINPOINT_SMS']);
});

test('the agent bridge skips in-app audio when there is no app consent', () => {
  const flight = CF.getScenario('flight-rebook');
  const t = CF.simulateConversationTrace(flight, { consent: { app: false }, inputs: ['3'] });
  const bridge = t.steps[t.steps.length - 1];
  assert.strictEqual(bridge.attempts[0].channel, 'CHIME_PSTN_VOICE');
  assert.ok(bridge.blocked[0].reasons[0].includes('app consent'));
});

test('every scenario text is clean of sensitive values', () => {
  CF.SCENARIOS.forEach((s) => {
    Object.keys(s.nodes).forEach((id) => {
      assert.strictEqual(CF.detectPii(s.nodes[id].text).length, 0, s.id + ':' + id);
    });
  });
});

test('every scenario node points only at nodes that exist', () => {
  CF.SCENARIOS.forEach((s) => {
    assert.ok(s.nodes[s.start], s.id + ' start');
    assert.ok(s.nodes[s.escalation], s.id + ' escalation');
    Object.keys(s.nodes).forEach((id) => {
      const n = s.nodes[id];
      (n.options || []).forEach((o) => assert.ok(s.nodes[o.next], s.id + ':' + id + ' -> ' + o.next));
      if (n.timeoutNext) { assert.ok(s.nodes[n.timeoutNext], s.id + ':' + id + ' timeout'); }
    });
  });
});

test('every scenario can reach a terminal node from its start', () => {
  CF.SCENARIOS.forEach((s) => {
    const seen = new Set([s.start]);
    const queue = [s.start];
    let terminal = false;
    while (queue.length) {
      const n = s.nodes[queue.shift()];
      if (n.terminal) { terminal = true; }
      const nexts = (n.options || []).map((o) => o.next).concat(n.timeoutNext ? [n.timeoutNext] : []);
      nexts.forEach((x) => { if (!seen.has(x)) { seen.add(x); queue.push(x); } });
    }
    assert.ok(terminal, s.id);
  });
});

test('no scenario text contains an em dash or an en dash', () => {
  const dash = new RegExp('[' + EM + String.fromCharCode(0x2013) + ']');
  assert.strictEqual(dash.test(JSON.stringify(CF.SCENARIOS)), false);
});

/* ---------- exporter ---------- */

test('every scenario exports a bundle that passes the required-field check', () => {
  CF.SCENARIOS.forEach((s) => {
    const r = CF.validateBundle(CF.exportAwsCdsBundle(s));
    assert.deepStrictEqual(r.errors, [], s.id);
  });
});

test('the SMA response starts with a SpeakAndGetDigits action and SchemaVersion 1.0', () => {
  const b = CF.exportAwsCdsBundle(clinic);
  assert.strictEqual(b.sipMediaApplication.SchemaVersion, '1.0');
  assert.strictEqual(b.sipMediaApplication.Actions[0].Type, 'SpeakAndGetDigits');
});

test('the digit regex only accepts the option keys', () => {
  const p = CF.exportAwsCdsBundle(clinic).sipMediaApplication.Actions[0].Parameters;
  const re = new RegExp(p.InputDigitsRegex);
  assert.strictEqual(re.test('1'), true);
  assert.strictEqual(re.test('3'), true);
  assert.strictEqual(re.test('4'), false);
});

test('the PlayAudioAndGetDigits variant uses an S3 audio source', () => {
  const a = CF.exportAwsCdsBundle(clinic).playAudioVariant.Actions[0];
  assert.strictEqual(a.Type, 'PlayAudioAndGetDigits');
  assert.strictEqual(a.Parameters.AudioSource.Type, 'S3');
});

test('CallAndBridge targets an E.164 PSTN endpoint with a 30 second timeout', () => {
  const a = CF.exportAwsCdsBundle(clinic).humanBridge.Actions[0];
  assert.strictEqual(a.Type, 'CallAndBridge');
  assert.strictEqual(a.Parameters.CallTimeoutSeconds, 30);
  assert.strictEqual(a.Parameters.Endpoints[0].BridgeEndpointType, 'PSTN');
  assert.match(a.Parameters.Endpoints[0].Uri, /^\+[1-9]\d{1,14}$/);
});

test('the attendee action only mutes, because the docs allow only Mute and Unmute', () => {
  const a = CF.exportAwsCdsBundle(clinic).muteWhileReview.Actions[0];
  assert.strictEqual(a.Type, 'ModifyChimeMeetingAttendees');
  assert.strictEqual(a.Parameters.Operation, 'Mute');
});

test('the SMS payload is a transactional dry run with a MaxPrice that fits the pattern', () => {
  const sms = CF.exportAwsCdsBundle(clinic).smsV2;
  assert.strictEqual(sms.MessageType, 'TRANSACTIONAL');
  assert.strictEqual(sms.DryRun, true);
  assert.match(sms.MaxPrice, /^[0-9]{0,2}\.[0-9]{1,5}$/);
});

test('the SES payload uses the Simple content shape', () => {
  const ses = CF.exportAwsCdsBundle(clinic).sesV2;
  assert.ok(ses.Content.Simple.Subject.Data);
  assert.ok(ses.Content.Simple.Body.Text.Data);
  assert.deepStrictEqual(ses.Destination.ToAddresses, ['recipient@example.com']);
});

test('SMS and email templates are built from nodes that really use those channels', () => {
  CF.SCENARIOS.forEach((s) => {
    const b = CF.exportAwsCdsBundle(s);
    const smsNodes = Object.keys(s.nodes).map((k) => s.nodes[k]).filter((n) => n.channels.indexOf('PINPOINT_SMS') !== -1);
    const emailNodes = Object.keys(s.nodes).map((k) => s.nodes[k]).filter((n) => n.channels.indexOf('SES_EMAIL') !== -1);
    assert.ok(smsNodes.some((n) => CF.redactPii(CF.renderNodeText(n, 'PINPOINT_SMS')).redacted === b.smsV2.MessageBody), s.id);
    assert.ok(emailNodes.some((n) => CF.redactPii(CF.renderNodeText(n, 'SES_EMAIL')).redacted === b.sesV2.Content.Simple.Body.Text.Data), s.id);
  });
});

test('the create-application request names a Lambda endpoint placeholder', () => {
  const c = CF.exportAwsCdsBundle(clinic).createSipMediaApplication;
  assert.strictEqual(c.Endpoints[0].LambdaArn, 'REPLACE_LAMBDA_ARN');
});

test('the generated Lambda scaffold parses and branches on received digits', () => {
  const src = CF.exportAwsCdsBundle(clinic).lambdaHandler;
  const mod = { exports: {} };
  new Function('exports', 'module', src)(mod.exports, mod);
  const event = {
    InvocationEventType: 'ACTION_SUCCESSFUL',
    ActionData: { Type: 'SpeakAndGetDigits', ReceivedDigits: '2' },
    CallDetails: { TransactionAttributes: { node: 'greet' }, Participants: [{ CallId: 'c1' }] }
  };
  return mod.exports.handler(event).then((res) => {
    assert.strictEqual(res.TransactionAttributes.node, 'pick_slot');
    assert.strictEqual(res.Actions[0].Type, 'SpeakAndGetDigits');
    assert.strictEqual(res.Actions[0].Parameters.CallId, 'c1');
  });
});

test('the Lambda scaffold follows the timeout branch on ACTION_FAILED', () => {
  const src = CF.exportAwsCdsBundle(clinic).lambdaHandler;
  const mod = { exports: {} };
  new Function('exports', 'module', src)(mod.exports, mod);
  const event = {
    InvocationEventType: 'ACTION_FAILED',
    ActionData: { Type: 'SpeakAndGetDigits' },
    CallDetails: { TransactionAttributes: { node: 'greet' }, Participants: [{ CallId: 'c1' }] }
  };
  return mod.exports.handler(event).then((res) => assert.strictEqual(res.TransactionAttributes.node, 'sms_nudge'));
});

test('the Lambda scaffold starts at the first node on a new inbound call', () => {
  const src = CF.exportAwsCdsBundle(clinic).lambdaHandler;
  const mod = { exports: {} };
  new Function('exports', 'module', src)(mod.exports, mod);
  const event = { InvocationEventType: 'NEW_INBOUND_CALL', CallDetails: { Participants: [{ CallId: 'c1' }] } };
  return mod.exports.handler(event).then((res) => assert.strictEqual(res.TransactionAttributes.node, 'greet'));
});

test('the Lambda scaffold hangs up after a spoken notice and replays an unexpected success', () => {
  const src = CF.exportAwsCdsBundle(clinic).lambdaHandler;
  const mod = { exports: {} };
  new Function('exports', 'module', src)(mod.exports, mod);
  const done = { InvocationEventType: 'ACTION_SUCCESSFUL', ActionData: { Type: 'Speak' }, CallDetails: { TransactionAttributes: { node: 'confirmed' }, Participants: [{ CallId: 'c1' }] } };
  const again = { InvocationEventType: 'ACTION_SUCCESSFUL', ActionData: { Type: 'Speak' }, CallDetails: { TransactionAttributes: { node: 'greet' }, Participants: [{ CallId: 'c1' }] } };
  return Promise.all([mod.exports.handler(done), mod.exports.handler(again)]).then(([a, b]) => {
    assert.strictEqual(a.Actions[0].Type, 'Hangup');
    assert.strictEqual(b.Actions[0].Type, 'SpeakAndGetDigits');
  });
});

test('the Lambda scaffold bridges when the flow reaches the escalation node', () => {
  const src = CF.exportAwsCdsBundle(clinic).lambdaHandler;
  const mod = { exports: {} };
  new Function('exports', 'module', src)(mod.exports, mod);
  const event = {
    InvocationEventType: 'ACTION_SUCCESSFUL',
    ActionData: { Type: 'SpeakAndGetDigits', ReceivedDigits: '3' },
    CallDetails: { TransactionAttributes: { node: 'greet' }, Participants: [{ CallId: 'c1' }] }
  };
  return mod.exports.handler(event).then((res) => assert.strictEqual(res.Actions[0].Type, 'CallAndBridge'));
});

test('the validator catches a bad Operation, bad E.164 number and long SMS body', () => {
  const b = CF.exportAwsCdsBundle(clinic);
  b.muteWhileReview.Actions[0].Parameters.Operation = 'Remove';
  b.humanBridge.Actions[0].Parameters.CallerIdNumber = '5555550100';
  b.smsV2.MessageBody = 'a'.repeat(1601);
  const r = CF.validateBundle(b);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors.length, 3);
});

test('the validator rejects a PSTN bridge endpoint that is not E.164', () => {
  const b = CF.exportAwsCdsBundle(clinic);
  b.humanBridge.Actions[0].Parameters.Endpoints[0].Uri = '555';
  const r = CF.validateBundle(b);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors[0].includes('PSTN endpoint'));
});

test('the exporter output contains no live account details', () => {
  const text = JSON.stringify(CF.exportAwsCdsBundle(clinic));
  assert.ok(!/arn:aws/.test(text));
  assert.ok(!/AKIA[0-9A-Z]{16}/.test(text));
});
