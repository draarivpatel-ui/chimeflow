# ChimeFlow Build Notes

Date: 2026-10-25. Author: Aariv Patel. Built for the AWS Communication Developer Services
Agentic AI Partner Hackathon (listing at https://aws-cds-partner.devpost.com/, deadline Oct 28).

## What was built

One static page at the repo root, vanilla HTML, CSS and JavaScript, zero dependencies, zero
network requests (fonts are self-hosted), GitHub Pages deployable as is.

- `engine.js` is a UMD module. Browser global `ChimeFlow`, Node `require`. All of the logic is
  here and is deterministic.
- `app.js` wires the DOM, draws the SVG sequence diagram, builds the keypad and plays the
  tones. User text is only ever written with `textContent` and text nodes.
- `tokens.css` holds every colour, font family, size, space and timing value. `styles.css`
  and `index.html` only reference `var(--...)`. The one allowed raw colour is the inline SVG
  favicon, which cannot read page variables.

## Engine surface

| Function | What it does |
| --- | --- |
| `analyzeSms`, `splitIntoSegments` | GSM-7 against UCS-2, extension characters at two units, 160 and 153 against 70 and 67, no split of an escape pair or surrogate pair across segments |
| `redactPii`, `detectPii` | Luhn cards, SSN validity rules, phone, email, MRN, labelled DOB, diagnosis codes after a label, ABA checksum routing, labelled accounts |
| `checkQuietHours` | 8:00 AM to 9:00 PM recipient local time from a UTC instant and an IANA zone through `Intl.DateTimeFormat` with `hourCycle: 'h23'` |
| `detectOptOut` | STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT, plus HELP and INFO as help |
| `auditMessagePayload` | Combines all of the above with cost per 10,000 sends from editable rates |
| `evaluateRoutingPolicy` | Per node, ordered channel list with an allowed flag and reasons (down, opted out, no consent, quiet hours) |
| `simulateConversationTrace` | Deterministic replay with retries, backoff, failover, response time, confidence gating and a human bridge |
| `createSession`, `advance` | Pure state machine behind the keypad |
| `exportAwsCdsBundle`, `validateBundle` | AWS templates and a required-field checker |
| `dtmfFrequencies` | Row and column tone table |

## Corrections to the brief, checked against the AWS docs on 2026-10-25

- `ModifyChimeMeetingAttendees` supports `Mute` and `Unmute` only, needs a prior
  `JoinChimeMeeting`, and takes a list of 1 to 100 attendee ids. The page doc title is
  singular (`ModifyChimeMeetingAttendee`), the wire `Type` in its examples is plural. The
  exporter emits a Mute action named "Mute during review" and the validator rejects any other
  operation. It is not used for transfers, which go through `CallAndBridge`.
- The brief asked for a "CDK exporter". The CloudFormation and CDK property names for
  `AWS::ChimeSDKVoice::SipMediaApplication` could not be confirmed from the docs, so the
  exporter emits the `CreateSipMediaApplication` API request instead (`AwsRegion`, `Name`,
  `Endpoints[].LambdaArn`), which matches the API reference. No CDK code is generated.
- Channel ids keep the `PINPOINT_` prefix from the brief as stable names. The page labels say
  AWS End User Messaging SMS and AWS End User Messaging Social.
- WhatsApp is modelled in routing and failover but has no exporter, because its request shape
  was not confirmed.

## Doc checks (what was read, and what was not)

Read in the AWS documentation on 2026-10-25 and encoded in `validateBundle`
- `SpeakAndGetDigits` (required `CallId`, `SpeechParameters.Text`, `RepeatDurationInMilliseconds`,
  engine `neural` or `standard`, `ReceivedDigits` on `ACTION_SUCCESSFUL`)
- `PlayAudioAndGetDigits` (S3 `AudioSource` and `FailureAudioSource`)
- `CallAndBridge` (`CallerIdNumber` E.164, timeout 1 to 120 with 30 default, `PSTN` or `AWS` endpoint)
- `ModifyChimeMeetingAttendees`, `Speak`, `Hangup`
- End User Messaging SMS `SendTextMessage` (`DestinationPhoneNumber` pattern, `MessageBody` 1 to 1600,
  `MessageType`, `MaxPrice` pattern, `Context` at most 5 entries, `DryRun`)
- SES v2 `SendEmail` (`Content.Simple.Subject` and `Body.Text`, `Destination.ToAddresses`)

Not confirmed from the docs
- The Lambda event envelope beyond `InvocationEventType`, `ActionData` and `CallDetails`
  (the scaffold uses `CallDetails.Participants[0].CallId` and round-trips state through
  `TransactionAttributes`, both from memory of the SMA model)
- WhatsApp request shape, CloudFormation and CDK property names

## Planning fixtures, not measurements

Latencies (voice 4.2 s, in-app 1.8 s, SMS 3.0 s, WhatsApp 2.2 s, email 9.0 s, bridge 5.2 s),
per-attempt costs, the 6 s reply delay, the 30 s no-answer wait and the SMS rates are
editable placeholders. The voice timeout of 30 s mirrors the documented `CallTimeoutSeconds`
default. Cost in the bench bills every attempt, so it is an upper bound.

## Design

Hallmark flow, non-interactive so the three-question gate was inferred. Audience is engineers
building multi-channel agent flows and hackathon judges. Use is to break a carrier, press a
keypad and read an exported payload. Tone is technical editorial. Macrostructure Workbench,
masthead nav, statement footer, custom palette from the brief (paper, surface, ink, terracotta
signal, cobalt trace). Display type Instrument Serif, body Plus Jakarta Sans, mono JetBrains
Mono, all self-hosted woff2 latin subsets from Google Fonts under the OFL. No eyebrow kickers,
no emoji, no italic headings, no fake browser chrome. The sequence diagram is hand-authored
SVG because it is a data graphic. No GSAP, Lenis or Three.js, on purpose. Motion is CSS only
(bars grow, edges fade) and is removed under `prefers-reduced-motion`.

## Verification

- `npm test` runs `node --test tests/`. 179 tests pass (engine and DOM smoke). The DOM smoke
  suite runs the real `app.js` against a small fake DOM built from the ids in `index.html`
  and drives it with clicks and changes, including keypad presses that assert the oscillator
  frequencies.
- `python3 hark_honesty_and_defect_harness.py --audit` reports 0 violations.
- Real Chrome (headless, DevTools console) on the local page. No console errors. A click on
  key 2 created oscillators at 697 Hz and 1336 Hz and the state machine moved to the next node.
  No horizontal overflow at 320, 375, 414 and 768 px (measured through iframes).
- The harness planted-defect runner (`--planted-defects --count 25`) catches 25 of 25 mutations on
  the final tree. It was also used to find missing assertions. A run of 80 mutations before the last
  round of added tests showed 3 escapes (an escalation guard in the trace, and two exporter node
  pickers). Tests were added for those and that 80 run was not repeated.
- Not done: no screen reader pass, no Safari or Firefox pass, and no AWS account was touched.
  The exporters are checked structurally only.
