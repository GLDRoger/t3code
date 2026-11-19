# Kin look book

The look book captures every main Kin screen on the invented company (Ambermill) at one frozen moment, wide (1440×900) and at phone width (390×844), and compares the set with the one the owner last accepted. It exists so that nothing a person already has changes without someone seeing it.

## When

Before every deploy and every phone build. It makes no model turns and costs nothing; a capture takes about nine minutes, most of it waiting for each staged message to start on a fresh minute.

## Commands

```bash
node scripts/kin-lookbook.ts capture                       # into ~/.kin-lookbook/<short commit>
node scripts/kin-lookbook.ts compare --new ~/.kin-lookbook/<short commit> --out ~/.kin-lookbook/compare-<short commit>
node scripts/kin-lookbook.ts accept --new ~/.kin-lookbook/<short commit>   # the owner's yes only
```

- `capture` starts its own instance (`lookbook`), seeds Ambermill with the `lookbook` seed, captures, and stops and wipes the instance, also on failure. `--out <dir>` picks the folder, `--only a,b` a few screens, `--keep` leaves the instance up for `kin-verify --instance lookbook`. Captures live outside the repo; never commit them.
- `compare` exits 1 when anything changed, new or missing, 0 when nothing did. `--accepted <dir>` compares with another set instead of `~/.kin-lookbook/accepted`.
- `accept` copies a set to `~/.kin-lookbook/accepted` and keeps the previous one beside it as `accepted-before-<commit>`.

## Reading the page

Open `index.html` in the `--out` folder. The top counts screens that are the same, changed, new and missing; a changed browser tab title or icon counts as changed. Each changed screen shows the accepted and new capture side by side with the differing areas outlined. Every outlined change is either something the brief for that change asked for, or a side effect to report. A screen the run could not capture is listed by `capture` and in `manifest.json` under `failed`.

Accepting is the owner's call. Show him the page; run `accept` only after his yes.

## What keeps two captures equal

- Every process of the instance starts its clock at Tuesday 4 June 2030, 08:05 in Kolkata, and the browser reads 08:35. Ids made by the server and the seed come from a fixed stream per source file and process start, so agent and person pebbles are the same every run (`scripts/kin-lookbook/freeze.ts`). Moving code that makes ids can change pebbles once; accept that set if nothing else changed.
- Clock times stamped during the run (08:05 to 08:35) show as `hh:mm`, and "… ago" counts as `n`; each screen's `masked` entry in `manifest.json` says what was hidden. Other times, such as a check-in's hour, stay.
- Animations, transitions, carets and hover are off. Differences under 16/255 per colour channel are treated as rendering noise.

The phone app is not captured yet. The manifest's `surface` field (`web`) leaves room for `ios` and `android` sets made on a simulator.
