# Kin memory purge

> For maintainers operating a Kin host. The design is in [the triggers spec](../kin/specs/triggers.md#owner-signed-purge-gap-5).

## Refs a purge can't rewrite

A purge rewrites only `refs/heads/*` and `refs/tags/*`. GitHub's read-only `refs/pull/*` are left alone. If the remote advertises any other ref, such as `refs/notes/commits` or a custom `refs/custom/*`, the purge fails at the clone stage, changes nothing and resumes the queue, and `reconcile` answers `unknown`. Those refs can still hold the purged content, so list them with `git ls-remote <memory repo>`, delete them on the remote (`git push <memory repo> --delete <ref>`), and run the purge again. A tag that points at a blob or tree fails the same way. A ref created on the remote before the purge's post-push check fails it at the push stage with the queue held, and `reconcile` answers `unknown` until you delete that ref. Anyone holding an old clone can still push the content back after that check.

## A stuck purge marker

A purge writes `<state>/kin/<org path>/purge-in-flight` before it force-pushes, and leaves it there when the push fails, crashes or is interrupted. While it exists, the org's lead queue stays paused, memory won't clone a checkout, and nothing pushes memory history. `reconcile` on the action clears it: it reads the plan from the marker, so it works even after the plan file is gone. Retry `reconcile` first; it answers `unknown` while the remote is unreachable, has moved, or advertises refs a purge can't rewrite.

The marker and the `purge-plans/*.tombstones.json` files live beside the lead's read workspace, and `reconcile` trusts them, so a lead with full filesystem access could tamper with them.

Delete the marker by hand only when `reconcile` keeps answering `unknown` and you have checked the remote yourself. First stop the T3 server, or confirm that no purge or `reconcile` for the org is running: both hold the memory writer lock and write these paths. Deleting the marker tells Kin that no local copy of the old history will be pushed again, so first delete everything under `<org path>` that can hold it:

- `memory` and `memory-read` (the writer and read checkouts);
- `dreams` (dream scratch copies);
- any `memory.clone-*` (a clone a crash left half-finished);
- `purge-scratch` and any `purge-scratch/mirror-*` inside it (the purge's rewritten bare clone, which also holds old objects).

Then confirm with `git log --branches --tags -p` on a fresh clone, and `git ls-remote` for refs outside heads, tags and pulls, whether the purged content is still on the remote. If it is, run the purge again from a new owner-approved action; if it's gone, the next wake-up clones the rewritten history.

Last, resume the org's queue. Until LEAD-11 builds the org pause there is no operator path to resume it: the purge can't run then either, because `KinPurgeQueue.pause` fails by default, so a stuck marker can only come from a host running LEAD-11's pause.
