# Auto-apply

Automatically push fixes for failing CI checks when the failure is in:
- `npm run lint` or `npm test` in `app/`
- `kubeconform` validation of `deploy/`

Do not auto-apply changes to Secrets, to `.github/workflows/`, to `local/`, or anything that weakens a test or removes an assertion.
