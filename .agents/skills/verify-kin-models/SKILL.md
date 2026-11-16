---
name: verify-kin-models
description: Model-check Kin's riskiest flows (the send card, a turn's reply, the loose check-in) with TLA+ and draw them as statecharts the owner can read. Use when changing the code a model covers, when a model or property test fails, or when asked for a chart of one of these flows.
---

# Verify Kin's models

Three small TLA+ models live in `verification/kin/<name>/`. Each has a `README.md` with its rules, bound, what it leaves out, and the files it covers.

| Model     | Run it when you change                                                                                                                                         |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `send`    | `connections/ConnectionsService.ts` asks and sends, `connections/Sending.ts`, `work/cardAnswers.ts`, start-up resume in `layer.ts`                             |
| `reply`   | `reply/KinReplyBridge.ts`, `lead/WakeupRunner.ts` finish and cleanup, `lead/KinEventQueue.ts` claim, steer and requeue, `floor/KinFloor.ts`, relays and nudges |
| `checkin` | `scheduledTasks/Schedule.ts` or `ScheduledTaskService.ts` timing, `pulse/checkIn*.ts`, `pulse/KinPulse.ts` holds, `triggers/kinSchedules.ts`                   |

Paths are under `apps/server/src` and `apps/server/src/kin`.

## Run

```sh
node scripts/kin-model.ts <name>              # every rule; exit 1 if one breaks
node scripts/kin-model.ts <name> --variants   # each deliberately broken variant must be caught
node scripts/kin-model.ts <name> --chart /path/outside/the/repo.md
```

The script downloads TLC 1.7.4 once into `~/.cache/kin-model` (`KIN_MODEL_CACHE` overrides it) and checks its SHA-256. It needs Java 11 or later, and falls back to `mise exec java@temurin-21`. Each model runs in under a minute. Never commit the jar or a chart.

## Read a counterexample

A broken rule prints numbered steps in the owner's words: the shortest path from a calm start to the break. Read it as a bug report. Find the action in the `.tla` file; its comment names the code it stands for. Then check that the code really allows that path. If it does, it is a product bug: fix it in the product, with a test that fails first. If the model allows something the code never does, the model is wrong: fix the model and say why in the commit.

Rules that break today, each a listed finding in its README:

- `send`: `FailureComesBack`. A restart between a failed send and its new card leaves the mail on no card.
- `reply`: `NeverTwo`. A partway failure after a reply, or a restart after a reply.
- `checkin`: `FiresWhenUp`, `InsideWindow`, `FactNeverAbsent`.

Any other broken rule is new: treat it as a regression.

## Keep a model true

When a covered file changes, first read the action that stands for it, then make the model do what the code now does. Run the model and `--variants`. Update the README's covered files and the commit it was confirmed at. A new behaviour that can go wrong gets a rule and a broken variant that the rule catches.

Never weaken, narrow or drop a rule to make a run pass. A rule only changes when the owner changes what the product promises. Say so in the commit.

## Property tests

The pure rules beside the models are property-tested with Effect's `Arbitrary` through `it.prop` / `it.effect.prop` from `@effect/vitest`, in `*.property.test.ts` files next to each rule (`work/teamView`, `work/recordRows`, `work/nameMatch`, `pulse/checkIn`). Run them with `vp test run <file>` from `apps/server`. A falsified property prints a shrunk input and a `Replay` token: pass the token as `{ arbitrary: { replay } }` to reproduce it.
