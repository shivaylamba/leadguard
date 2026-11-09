# API changes must keep the scanner and the console working

When a pull request changes a route in `app/src/server.js`, a request or response field used by `app/public/app.js` or `app/src/simulate.js`, or `api/openapi.yaml`:
- check that `api/openapi.yaml`, the server and the browser app still agree (CI runs `app/test/contract.test.js`)
- check that scanners already in the field keep working: `/api/scans/batch` must stay backwards compatible, because booth devices may run an old build all day
- if they don't agree, add the label `contract-break` and comment with the exact path or field that drifted.
