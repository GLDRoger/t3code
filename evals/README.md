# Evals

An eval runs a real model against T3 Code's real text or code and scores what the model does. Use one where a unit test cannot help: model output changes from run to run, and a small copy change can move it.

Write or run an eval when a change affects what a model sees or does: agent instructions, MCP tool descriptions and schemas, tool results, generated titles, or the guidance an agent gets for a feature such as Device Manager.

| Eval                            | Measures                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| [mcp-tool-use](mcp-tool-use/)   | Whether agents use T3's MCP tools correctly, including device routing and recovery, in fake threads. |
| [thread-titles](thread-titles/) | Whether generated thread titles name the right subject.                                              |
| [pr-content](pr-content/)       | Whether PR generation describes the diff when project instructions try to redirect it.               |
| [voice-cleanup](voice-cleanup/) | Whether optional dictation cleanup edits only the spoken text and preserves its meaning.             |
| [test-signal](test-signal/)     | Whether a cheap model running the test-signal check flags low-signal tests.                          |

## Run an eval

1. Run `vp i` at the repo root.
2. Put the API keys the eval needs in the repo root `.env`. It is gitignored, and the eval scripts load it. Never print or commit a key.
3. From `evals/`, run `pnpm <eval> --out runs/<name>`. `runs/` is gitignored.

Each eval's README lists its models, flags, and cost. Start with one case and one sample to check the setup.

Evals call paid models, so CI does not run them. CI typechecks this package and runs the graders' unit tests.

## Kin baseline

Kin's agent cases live in `mcp-tool-use`: `cases/kin.ndjson`, `cases/kin-owed.ndjson`, `cases/kin-characters.ndjson`, `cases/kin-questions.ndjson`, `cases/kin-github-events.ndjson`, `cases/kin-github-identity.ndjson`, `cases/kin-social.ndjson` and `cases/kin-sales.ndjson`, one area per group of behaviours (`kin/owner-chat`, `kin/mail` and the rest). A change to Kin's instructions or tool descriptions is gated against a baseline on the same model (see [The Kin gate](#the-kin-gate)). From `evals/`:

| Command                                                                                       | Calls a model | What it does                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm kin:dry`                                                                                | no            | Builds every Kin request, fails on a malformed case, and prints the cost estimate.                                                                                                |
| `pnpm kin:subset --model <id> --out runs/kin-subset`                                          | yes           | The first case of each group, 3 samples each.                                                                                                                                     |
| `pnpm kin:characters --model <id> --out runs/kin-characters`                                  | yes           | The character cases: five voices on three questions (money, a deadline, a client), length, names not keys, act then tell, undo, Confirm on mail and posts.                        |
| `pnpm kin:questions --model <id> --out runs/kin-questions`                                    | yes           | Open questions: asked with a default, not asked again, the default taken at its day, not asked at all, closed only by the asker.                                                  |
| `pnpm kin:github --model <id> --out runs/kin-github`                                          | yes           | The GitHub event turns (review, `/kin` on a PR or issue, the `kin` label, a stranger's PR, failing checks, a risky ask) and who agents work as on GitHub.                         |
| `pnpm kin:social --model <id> --out runs/kin-social`                                          | yes           | The Social agent: a week from real numbers on one card, no posted before Confirm, clients apart, packs.                                                                           |
| `pnpm kin:baseline --model <id> --out runs/kin-<id>`                                          | yes           | Every Kin case, 8 samples each, on one model: a baseline for the gate.                                                                                                            |
| `pnpm kin:candidate --model <id> --baseline <dir> --out <dir>`                                | yes           | Every Kin case, 3 samples each, topped up to 8 where they split or the baseline did not agree.                                                                                    |
| `pnpm kin:compare --baseline <dir> --candidate <dir>`                                         | no            | The gate: each case's passes in both runs and a verdict. A second `--candidate` folder is pooled. Exits 1 when a case is worse or has no data, 2 when the runs can't be compared. |
| `pnpm kin:subset --model gpt-6.1-sol --harness app-server --effort medium --out runs/kin-sol` | yes           | A Kin case set on a GPT model as Kin runs it on Codex, on the provider `CODEX_HOME`'s config selects (a sign-in or a gateway).                                                    |
| `pnpm kin:baseline:all`                                                                       | yes           | The same on Opus, Sonnet and Haiku, into `runs/kin-baseline-<model>`.                                                                                                             |

`summary.md` gives the pass rate per case and per pattern, and counts cases and samples as pass, pass within margin, and fail. Every `kin:*` script passes `--no-step-limit`, so a sample ends only when the model ends its turn: in real use nothing stops a Kin agent after a set number of steps, so a cut-off sample would count a turn Kin never cuts as a failure. Instead the summary gives the mean, p90 and largest model calls per sample and the five cases that took most, and the log names a sample at every 40 model calls. The `mcp-tool-use` README covers the case format.

Agent voices pass within a margin. We stopped chasing exact lengths: the word ceilings stay in the characters as targets, and a reply up to 50% over its length cap, or one over a count such as emoji, `!` or questions, passes within margin. In `summary.md` a voice case passes when 2 of every 3 of its samples pass. Checks of substance stay strict: the agent's own seat, a position, no claim of work it did not do, money only for people who may see it, Confirm before anything leaves the company, names instead of keys. A sample within margin is a pass to the gate. Watch the within-margin count from run to run: a move from pass to within margin is drift.

A case's `{{CHARACTER:<domain>}}` and `{{COLLEAGUES:<domain>}}` are a standard agent's default character and the others' one-liners, as Kin builds them. Where no regex can judge a reply (does it sound like this character?), `expect.rubric` asks the shell model yes/no questions about the visible reply and its calls; each answer is one check. A rubric costs one small call per sample.

### The Kin gate

1. Make a baseline on the text before the change: `pnpm kin:baseline --model claude-haiku-5-5 --out <baseline>`. Haiku is Kin's cheapest agent model and the gate's default. Every case runs 8 samples, once: keep the folder, it serves every change until Kin's text on `kin` moves on. Its `run.json` records the model, effort, harness, shell model, step limit (`maxSteps`, 0 for none), template, a hash of the runner and graders, a hash of each case and of every first request.
2. Run the changed text: `pnpm kin:candidate --model claude-haiku-5-5 --baseline <baseline> --out <candidate>`. A case starts with 3 samples and stops there when they agree with each other and with every baseline sample; otherwise it is topped up to 8. A stable case costs 3 samples, as it did before the gate. A case whose first samples all errored is not topped up, and the compare fails it as no data: run it again. The run refuses a stale baseline before it spends anything.
3. `pnpm kin:compare --baseline <baseline> --candidate <candidate>`. The overall verdict is pass unless a case is worse.
4. A worse case counts once it reproduces. Run only those cases again, `pnpm kin:candidate --model claude-haiku-5-5 --baseline <baseline> --case <ids> --samples 8 --top-up 8 --out <confirm>`, and compare with both `--candidate <candidate> --candidate <confirm>`: the batches are pooled. The compare prints this command when it finds a worse case. Run one confirmation batch, not more.

The compare refuses runs whose model, effort, harness, shell model, step limit, user instructions, template, runner and graders, or top-up count differ, and a candidate case that changed or is not in the baseline. A change to `run.ts` or a grader makes every earlier baseline stale: make a new one. A baseline case the candidate did not run is counted, not judged.

A case is **worse** when a one-sided Fisher exact test on its pass counts gives p ≤ 0.005, **better** on the mirror test, and **unstable** when neither run is stable; a case unstable on both sides is never worse. A run is stable when at most one sample in eight disagrees with the rest: 3 of 3, 0 of 3, 7 or 8 of 8, 0 or 1 of 8. At 8 samples against 8, worse takes a drop of at least 8 → 2, 7 → 0 or 6 → 0.

The baseline runs 8 samples everywhere because 3 unanimous samples say little: against a 3-of-3 baseline, even a candidate that fell to 0 of 8 is within chance (p = 0.006). Paying for 8 once is what lets the candidate stop at 3.

False alarms: computed exactly over this sampling, a case whose pass rate did not change is called worse at most 0.11% of the time, for a case passing about half its samples; 0.02% at 80%, and never for a case that always passes or always fails. At the rates the Kin cases had on Haiku in November 2026 (62 of 242 cases between 2 and 6 of 8), that is one false alarm in about 22 gate runs. A looser p ≤ 0.02 would have raised one in every 5. Those figures treat every sample as independent, and a case's samples are not quite: they run together, so one batch can lean one way. On identical text (`3836b1e096`, Haiku) `kin-gh-owner-rule-to-approve-still-comments` passed 8 of 8 in one run and 2 of 8 in the other, which independent samples would almost never do; a second batch passed 7 of 8. That is why a worse case must reproduce in a separate batch. With that batch, the two identical-text runs gave 0 worse in both directions, and 45 of 242 cases unstable on both. What the gate cannot see: a case that always passed and now passes 20% of the time is caught 80% of the time, one now at 50% only 14%. An unstable case is a behaviour to fix in the text or the case; the gate only keeps it from posing as a regression.

## The shape of an eval

Every eval follows the same shape, so a new one is easy to write and an old one is easy to run.

- `evals/<eval>/run.ts` is the entry point. `package.json` has a script with the eval's name.
- `evals/<eval>/README.md` says what the eval measures, how to run it, how to add a case, and what a run costs.
- Cases are data, in `cases/` or `cases.ts`. Each case has an `id`, says where it came from (a PR, issue, or thread), and has its checks or rubric.
- The eval imports the code under test from source. Never copy prompts, tool descriptions, or schemas into an eval. Then the eval always tests the current text.
- Flags: `--out <dir>` (required), `--model <id>`, and `--baseline <earlier results>` to compare. Add `--case <ids>` when a full run is slow or costly.
- A run writes results rows to `--out`, plus a summary or review file for a person.
- When the eval grades itself, `run.test.ts` tests the grader, which is plain logic. It runs in CI. When a person grades, the run hides which output is new.

## Rules for cases

- A case reproduces a real bad experience, or guards a real good one. Name its source.
- Add the case before the fix. It must fail on the old text and pass on the new text.
- If you change a case, the changed case must still fail on the text it was written against. Prefer to fix T3 Code over loosening a case.
- Add controls: cases where the correct action is ordinary work. They catch a fix that overcorrects.
- Model output varies. Run each case several times. A case fails when half or more of its samples fail. Compare against a baseline on the same model, not against an absolute score.
- No user data in cases, fixtures, or templates. Use `/home/user` and `acme/app`. Read every captured fixture before you commit it.
- No unreleased model details in committed files, except model ids in an eval's model table.

## Cost

Run only the cases your change touches until they pass. Then do one full run per model before the PR merges. Each eval's summary records what the run cost.

## Add an eval

1. Copy the shape above from the closest eval.
2. Add a script to `package.json`, a README, and a row to the table above.
3. When a second eval needs code that one eval already has (model clients, the shell simulator, sampling, summaries), move that code to `evals/shared/` and use it from both. Do not build shared code before a second eval needs it.
