# Restore drill

Restores the Kin server from a `backup.sh` backup. Run every step as `kin` on the Kin host. Pick the backup day first:

```bash
DEST=/mnt/backup/kin   # the backup destination
DAY=2026-11-08         # the backup to restore
T3="$HOME/.t3"
```

1. Stop the server, so nothing writes to the database:

   ```bash
   systemctl --user stop kin-server
   ```

2. Move the current state aside. The `-wal` and `-shm` files must go with the database: a stale WAL replayed into the restored file corrupts it.

   ```bash
   aside="$T3/userdata/before-restore-$(date +%F-%H%M%S)"
   mkdir -m 700 "$aside"
   for f in statev2.sqlite statev2.sqlite-wal statev2.sqlite-shm; do
     [ -e "$T3/userdata/$f" ] && mv "$T3/userdata/$f" "$aside/"
   done
   [ -d "$T3/userdata/secrets" ] && mv "$T3/userdata/secrets" "$aside/"
   [ -f "$T3/service.env" ] && mv "$T3/service.env" "$aside/"
   ```

3. Restore the database, secrets and `service.env`, then check the database:

   ```bash
   install -m 600 "$DEST/kin-$DAY.sqlite" "$T3/userdata/statev2.sqlite"
   [ -d "$DEST/kin-$DAY-secrets" ] && cp -a "$DEST/kin-$DAY-secrets" "$T3/userdata/secrets" && chmod 700 "$T3/userdata/secrets"
   [ -f "$DEST/kin-$DAY-service.env" ] && install -m 600 "$DEST/kin-$DAY-service.env" "$T3/service.env"
   sqlite3 "$T3/userdata/statev2.sqlite" 'PRAGMA integrity_check;'   # prints: ok
   ```

4. Start the server and watch it come up:

   ```bash
   systemctl --user start kin-server
   journalctl --user -u kin-server -n 50 --no-pager
   ```

5. Check it worked:
   - The phone reaches the host over T3 Connect. The relay link is restored with `secrets/`, so no new sign-in should be needed.
   - `trigger_reconcile` runs at startup. It re-arms deferrals and routines from memory (GitHub is the source of truth), recreates missing webhook tasks, and reports any it can't fix. Triggers the backup missed come back this way, and overdue ones fire with when they were due. Until the deferral half of `trigger_reconcile` ships (see the triggers spec), deferrals re-arm on the next memory head.
   - Held webhooks the relay kept while the server was down arrive on reconnect (Hold webhooks while offline). `github_recheck` covers anything older than 24 h.

When the restored server looks right, delete the `before-restore-*` directory. To roll back instead, stop the server and move its files back.
