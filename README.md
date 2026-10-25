# ChimeFlow

Voice fails. The message still lands.

ChimeFlow is an open-source workbench for teams building agentic conversations on AWS Communication Developer Services. You design a multi-step flow across Amazon Chime SDK voice, AWS End User Messaging (SMS and WhatsApp) and Amazon SES, break a carrier on purpose, and watch the failover, the guardrails and the exported payloads.

It is one static page. No build step, no dependencies, no network calls, and the same deterministic engine runs in the browser and under `node --test`.

Live page at https://aariv.me/chimeflow/

Built for the AWS Communication Developer Services Agentic AI Partner Hackathon.

## What is in the page

**Failover bench.** Four fictional scenarios (clinic reschedule with nurse escalation, power outage dispatch, flight rebooking, high-value fraud verification). Set the recipient clock and time zone, then break any channel with a timeout, an undeliverable result or a carrier outage. An SVG sequence diagram shows every attempt on a millisecond axis, the retries, the failover edges and the human bridge, with a step list as the text version. Every blocked channel is shown with its reason.

**Message inspector.** Type an agent reply and see GSM-7 against UCS-2 encoding, extension characters that cost two units, segment boundaries (a two-unit character or an emoji pair never splits across segments), and cost per 10,000 sends from rates you edit. Luhn-verified card numbers, SSNs, phone numbers, emails, medical record numbers, labelled dates of birth, diagnosis codes, checksum-verified routing numbers and labelled account numbers are masked before the message is priced. A tester recognises STOP, UNSUBSCRIBE, CANCEL, END, QUIT and STOPALL, and the TCPA check applies an 8:00 AM to 9:00 PM recipient local time window using the IANA time zone.

**Call and message simulator.** Run a scenario as a live conversation. The keypad plays real DTMF tones by adding two sine waves (697, 770, 852 or 941 Hz plus 1209, 1336 or 1477 Hz) with the Web Audio API, and each digit branches a pure state machine. Free-text replies go through a keyword classifier with a 0.6 confidence gate, red-flag phrases such as "chest pain" escalate immediately, and two invalid digits escalate to a human bridge.

**AWS export.** Templates for the selected scenario built from the documented request shapes.

- `SpeakAndGetDigits` and `PlayAudioAndGetDigits` actions for a Chime SDK SIP media application
- `CallAndBridge` to a human agent
- `ModifyChimeMeetingAttendees` (the documentation allows `Mute` and `Unmute` only)
- AWS End User Messaging SMS `SendTextMessage` request (dry run, transactional)
- Amazon SES v2 `SendEmail` request
- `CreateSipMediaApplication` request
- A Node.js Lambda scaffold that walks the flow by received digits

Each template is checked against the required fields and value ranges in the AWS documentation before it is shown.

## Run it

```
python3 -m http.server 8000
```

Then open http://localhost:8000. Any static file server works. To run the tests:

```
npm test
```

The suite uses only `node:test`. There is nothing to install.

## Honest limits

- Latencies, per-attempt costs, the response delay and the SMS rates are editable planning fixtures. They are not measurements and not AWS list prices.
- The exporters have never been deployed or sent. They follow the request shapes in the AWS documentation and are checked structurally, not against a live account.
- The TCPA check is a conservative engineering rule, not legal advice. Which rules bind a given message depends on who is being contacted and why.
- The clinic, utility, airline and credit union are fictional. There are no customers, no telemetry and no testimonials.
- Redaction is pattern based. It misses a name written in a sentence.
- The channel identifiers keep the `PINPOINT_` prefix as stable names. The services are now AWS End User Messaging SMS and AWS End User Messaging Social, and the labels in the page say so.
- WhatsApp is modelled in routing and failover but has no exporter, because its request shape was not verified.

## Files

| File | Purpose |
| --- | --- |
| `engine.js` | Deterministic engine, UMD for browser and Node |
| `app.js` | DOM wiring, SVG diagram, keypad and Web Audio |
| `index.html`, `styles.css`, `tokens.css` | Page, styles and design tokens |
| `tests/` | `engine.test.js` and `dom-smoke.test.js` |
| `NOTES.md` | Build notes, doc checks and what was verified |
| `video/SUBMISSION.md` | Devpost copy and voiceover script |

## License

MIT. Fonts (Instrument Serif, Plus Jakarta Sans, JetBrains Mono) are self-hosted under the SIL Open Font License.
