# Send card (`node scripts/kin-model.ts send`)

**Rules.** A confirmed mail goes out at most once, exactly as its card showed it, never in an outdated version, and only on the owner's or a co-owner's Confirm. An agent's correction replaces the older card for good. Confirm always ends as Sent or Failed. A failed or outdated mail comes back on a new card, or on the agent's newer card for it.
**Harm guarded.** Money or mail leaves the company twice, outdated, unasked, or not at all, and nobody can tell.
**Bound.** Two agent cards (a draft and a correction), five card slots, and at most two of these, once each: the invoice is re-made, the sign-in expires, the mail service fails, Kin restarts. About 7,500 states, 5 s. `--variants` breaks each rule on purpose (9/9 caught).
**Open finding (not fixed).** Kin restarts in the moment between "the card says it failed" and the new card being posted. The mail is then on no card. Fixing this needs a stored link from a failed ask to its copy. `FailureComesBack` fails on exactly this path until that is fixed.
**"Comes back".** This includes the mail standing on the agent's own newer card: a correction is the same mail.
**Left out.** Calendar and MCP-call cards (they never come back on a card). The From switch. Receipts and statements: their Confirm records inside the tap's own transaction, so a restart can't split it. A co-owner's tap runs the same `ownerLevel` check as the owner's, so the model has one owner-level person.
**Covers** (confirmed at kin `6b1f702561` plus this change):

- `apps/server/src/kin/connections/ConnectionsService.ts`: `askFor`, `answerAsk`, `sendAsk`, `freshAsk`, `superseded`, `interruptedSends`, `withSignIn`
- `apps/server/src/kin/connections/Sending.ts`: `sendMail`, `filesOf`, `attachmentsCurrent`
- `apps/server/src/kin/work/cardAnswers.ts`: `answerChoice`, `sendAsked`, `showOutcome`, `resumeInterruptedSends`
- `apps/server/src/kin/layer.ts`: start-up wiring
