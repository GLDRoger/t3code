# Restore drill

Restores the Kin server from a `backup.sh` backup into an empty `~/.t3/userdata`, the same as on a new disk. Run every step in a kin shell on the Kin host (`sudo -iu kin`, then `export XDG_RUNTIME_DIR=/run/user/$(id -u)`). Pick the backup day first:

```bash
DEST=/mnt/backup/kin   # the backup destination
DAY=2026-11-08         # the backup to restore
T3="$HOME/.t3"
BACKUP="$DEST/kin-$DAY"
```

1. Stop the server, so nothing writes to the database:

   ```bash
   systemctl --user stop kin-server
   ```

2. Move the whole current state aside, `service.env` included. The database's `-wal` and `-shm` files go with it: a stale WAL next to the restored file would be replayed into it and corrupt it.

   ```bash
   aside="$T3/before-restore-$(date +%F-%H%M%S)"
   mkdir -m 700 "$aside"
   [ -d "$T3/userdata" ] && mv "$T3/userdata" "$aside/"
   [ -f "$T3/service.env" ] && mv "$T3/service.env" "$aside/"
   ```

3. Restore into an empty `userdata`, then check it. The backup holds a single `statev2.sqlite` with no `-wal` or `-shm`.

   ```bash
   mkdir -p -m 700 "$T3/userdata"
   cp -a "$BACKUP/userdata/." "$T3/userdata/"
   [ -f "$BACKUP/service.env" ] && install -m 600 "$BACKUP/service.env" "$T3/service.env"
   ls "$T3/userdata"/statev2.sqlite-* 2>/dev/null           # prints nothing
   sqlite3 "$T3/userdata/statev2.sqlite" 'PRAGMA integrity_check;'   # prints: ok
   cat "$T3/userdata/environment-id"                        # the same id as before
   cat "$aside/userdata/environment-id" 2>/dev/null           # (if there was a before)
   ```

4. Start the server and watch it come up:

   ```bash
   systemctl --user start kin-server
   journalctl --user -u kin-server -n 50 --no-pager
   ```

5. Check it worked:
   - `environment-id` is unchanged, so clients, the relay and linked environments see the same machine. A missing `environment-id` would make the server mint a new one.
   - The phone reaches the host over T3 Connect. The relay link is restored with `secrets/`, so no new sign-in should be needed.
   - `trigger_reconcile` runs at startup. It re-arms deferrals and routines from memory (GitHub is the source of truth), recreates missing webhook tasks, and reports any it can't fix. Triggers the backup missed come back this way, and overdue ones fire with when they were due. Until the deferral half of `trigger_reconcile` ships (see the triggers spec), deferrals re-arm on the next memory head.
   - Held webhooks the relay kept while the server was down arrive on reconnect (Hold webhooks while offline). `github_recheck` covers anything older than 24 h.

When the restored server looks right, delete the `before-restore-*` directory. To roll back instead: stop the server, `mv "$T3/userdata" "$T3/userdata.failed-restore"`, move `"$aside/userdata"` and `"$aside/service.env"` back into `$T3`, and start it.
