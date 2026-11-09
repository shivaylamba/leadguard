# Leads and attendee privacy

Lead data is personal data, and sponsors only get it with consent. Flag:

- Any span attribute, metric attribute, log field or log message containing a badge id, name, email, company or order id. Use `pseudonym()` (`enduser.pseudo_id`) when a correlation id is needed. The Collector's `transform/privacy` is a backstop, not the control.
- Lead contact details (name, email, company) copied or exported without `consent === true`.
- A second export path: sponsor exports go through `GET /api/leads/export.csv` only, which filters on consent.
- Metric attributes with attendee or badge ids (cardinality and privacy): booth, desk, outcome and kind only.
- Webhook endpoints without the shared-token check, or tokens and keys written into code, manifests or logs (the repo and image are public).
- Synthetic data that isn't clearly synthetic: emails must use `.example` domains.
