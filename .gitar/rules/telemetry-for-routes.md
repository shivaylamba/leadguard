# New routes need telemetry and a test

When a pull request adds a new `app.get`, `app.post`, `app.put` or `app.delete` route in `app/src/server.js`:
- check that the handler calls `annotate()` or `inSpan()` with at least one `conference.*`, `search.*`, `overflow.*` or `signal.*` attribute
- check that `app/test/` gains or changes a test in the same pull request
- if either is missing, comment with the missing piece and an example from an existing route.
