# LeadGuard demo: 3 minutes, live, with the judges

Backup video (2 min, captions): `leadguard-backup-demo.mp4` (kept outside the repo). Play it if the venue Wi-Fi fails.

## Setup (10 minutes before)

| Device | Screen | Who |
|---|---|---|
| Laptop on the projector | `#/ops` (Organizer), large text | Presenter |
| Phone 1 | `#/scan`, booth **Radar** | Teammate (booth staff) |
| Phone 2 | `#/scan`, booth **Dash0** | Teammate, or a judge |
| Laptop 2 or tablet | `#/desk` | Desk volunteer |

- [ ] Reset the data: `scripts/demo-reset.sh --yes --namespace team-<team>` (about 20 s). On Civo, add `--context kind-overflow --keep-traffic`.
- [ ] Pre-register the judges at `#/badges` (name + email), print the page (two badges per sheet), cut them out.
- [ ] Keep one extra printed badge for someone who will **not** check in (the never-checked-in story), or use `B39999`.
- [ ] Phones: open the scanner, pick the booth, check that "Scan with camera" reads a printed badge. On iPhone Safari the jsQR fallback is used. Typing the badge id always works.
- [ ] Optional, Dash0 depth: start the kiosk rig (`cd kiosk && make up`) 10 minutes before and `make learn` while calm.
- [ ] Dash0 dashboard "LeadGuard: conference health" open in a second tab; Radar Cloud open on the timeline.

## Script

1. **(0:00) The problem, 20 s.** "A conference organizer told us: *a sponsor complained no leads were generated, and nearly didn't come back*. And at the desk: *someone bought a ticket with their work email, changed jobs, and the ticket email went to spam.*"
2. **(0:20) Desk, 30 s.** Ask a judge to give their name misspelled, or an old email. The desk finds them. Link the email they use today and click **Check in**. Point out "Tickets at risk" on the organizer screen: people whose ticket email bounced or went to spam, listed before they reach the desk.
3. **(0:50) Booths, 40 s.**
   - Phone 1 scans two checked-in judges, with consent and a note.
   - Turn on **Simulate Wi-Fi off** and scan two more: "3 scans waiting".
   - Scan the badge of someone who never checked in.
   - Turn Wi-Fi back on: the queue syncs exactly once.
   - Within 30 s the organizer screen shows **never checked in** at the Radar booth, with an explanation.
4. **(1:30) Ask ops, 30 s.** Type: "What happened at the Radar booth in the last 15 minutes? Were any leads lost?" AURA answers from the evidence: the scans made offline and synced late, nothing lost, and the never-checked-in badge. Ask it to "draft a short note to the Radar sponsor". The draft appears, **waiting for approval**. Nothing is sent without a human.
5. **(2:00) Under the hood, 40 s** (the tab switch is the point: each sponsor sees their product doing real work):
   - **Dash0:** the trace from a scan → ingest → Elasticsearch; the SLO "99.9% of scans stored"; the check rule "Booth went silent"; the Agent0 finding from the load test (reconnect storm: 30 batches queue for about 1 s, then 1.5 s in the lead write).
   - **Radar:** the timeline of today's deploys; the `ingest` canary judged on its own pods; the HPA scaling 2→4 during the storm; the AI investigation.
   - **Elasticsearch:** the ES|QL `LOOKUP JOIN` that finds the anomaly; the per-booth ML scan-rate job; the hybrid search over lead notes.
   - **Gitar:** a PR where the API contract test failed and Gitar's auto-apply fixed it; the time-zone and privacy rules.
6. **(2:40) Close, 20 s.** "Check-ins you can trust. Leads sponsors can trust. And the people running the event finally get to see what's happening."

## If something breaks

| Symptom | Do this |
|---|---|
| No Wi-Fi at all | Play the backup video |
| Anomaly not showing after 30 s | Refresh `#/ops`; the integrity sweep runs every 30 s |
| AURA slow (>60 s) or down | Show the drafted answer from the video; the evidence is also in the booth card and the anomalies table |
| Camera won't read a badge | Type the badge id; the scanner accepts typed ids |
| Kiosk finding has no process yet | Wait a minute and run `make report` again; OBI attributes the process after it parses a request |

## Load-test numbers (Civo, for questions)

- **Doors-open rush:** 300 check-ins across 12 desks in 6 s, 0 errors, p95 521 ms.
- **Reconnect storm:**
  - 30 scanners flushed 4,500 offline scans at once: all 4,500 stored, 0 errors, 0 lost.
  - The HPA scaled `ingest` from 2 to 4 replicas.
  - Each batch took p95 3.9 s: about 1 s queued under load, about 1 s storing scans, about 1.5 s writing leads (including embeddings).
