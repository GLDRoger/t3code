# Kin memory purge

> For maintainers operating a Kin host. The design is in [the triggers spec](../kin/specs/triggers.md#owner-signed-purge-gap-5).

## A stuck purge marker

A purge writes `<state>/kin/<org path>/purge-in-flight` before it force-pushes, and leaves it there when the push fails, crashes or is interrupted. While it exists, the org's lead queue stays paused, memory won't clone a checkout, and nothing pushes memory history. `reconcile` on the action clears it: it reads the plan from the marker, so it works even after the plan file is gone. Retry `reconcile` first; it answers `unknown` while the remote is unreachable or has moved.

Delete the marker by hand only when `reconcile` keeps answering `unknown` and you have checked the remote yourself. Deleting it tells Kin that no local copy of the old history will be pushed again, so first delete `<org path>/memory`, `<org path>/memory-read` and `<org path>/dreams` too, and confirm with `git log --branches --tags -p` on a fresh clone whether the purged content is still on the remote. If it is, run the purge again from a new owner-approved action; if it's gone, the next wake-up clones the rewritten history. Then resume the org's queue.
