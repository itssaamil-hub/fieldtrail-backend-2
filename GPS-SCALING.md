# GPS scaling defaults

Raw `location_pings` are operational route history. Attendance Start/End GPS and lead-capture GPS remain stored in their own records and are not affected by this policy.

Defaults:
- Raw ping retention: 90 days
- Minimum movement before another raw history row: 20 metres
- Stationary heartbeat persisted at least every 120 seconds
- Cleanup batch size: 5,000 rows
- Cleanup maximum: 20 batches per daily run

Environment overrides:
- `LOCATION_PING_RETENTION_DAYS`
- `LOCATION_PING_MIN_DISTANCE_M`
- `LOCATION_PING_MAX_GAP_SECONDS`
- `LOCATION_PING_CLEANUP_BATCH_SIZE`
- `LOCATION_PING_CLEANUP_MAX_BATCHES`

The existing daily reminder cron also runs bounded location-ping cleanup, so no additional scheduler is required.
