# Time and time zones

Check-ins, scans and anomalies are judged by time, and scanner clocks are wrong more often than you'd think. Flag:

- Stored timestamps that aren't ISO-8601 instants in UTC (`new Date().toISOString()`), or a date stored without a zone.
- `new Date('2026-11-09 09:00')` or any parse of a string without an offset: it's read in the server's zone, which is not the venue's.
- Business hours ("expo open", "desk shift") computed in the server zone. Use `isExpoOpen()` / `localMinutes()` in `app/src/model.js` with `VENUE_TZ`.
- Device timestamps (`scanned_at`) trusted without `scanTime()`: it corrects future and day-old clocks and records `clock`/`skew_ms`.
- UI times rendered without `timeZone: cfg.venue_tz`.
- New time logic without a test that crosses a zone boundary (see the America/Denver vs Europe/Zurich test).
