# PH-192 contract rejection and workflow audit — 14 September 2026

PH-192 (`cmtrwi4ondjtyov2k9wfotit6`, Dev CBA payment down) remains In Progress
with its final end-to-end verification checklist item open. Main database
`wt-main.db` records an active blocker at `cmu0po98aatg2ov4rv2jualg0`.

The Dev payment invocation reached CBA and was refused because its transaction
ID was 50 characters; the gateway permits at most 40. `generateTransactionKey`
in V23 candidate `682a05db` concatenates a 13-digit millisecond timestamp,
a hyphen, and a 36-character UUID. This defect predates the V23-39 legacy-origin
change. Earlier artifact verification correctly showed V23-39 was deployed;
its narrower session-initialization acceptance did not test payment completion.

The V23 correction returns the full 36-character UUID. New handler tests
simulate the observed gateway rejection in both legacy and invoice paths,
assert stable identity on a transport retry and distinct identity for a new
invocation. Both tests failed with the original implementation. The corrected
full layer suite passes 273 tests. No payment is made by these tests.

PM also contributed: any mention of browser, Playwright or Chromium classified
technical evidence as a fresh-session fault, and even non-transient errors got
unconditional fresh-session retry guidance. This instructed repeated external
calls after a source defect had been identified. PM now limits browser fault
matching to actual failure descriptions. A dependency contract violation with
source inspection and an independent local reproduction can be reported
without a prior incident round. Self-directed blockers and vague/single-observation
failures remain rejected or internal incidents. Guidance explicitly avoids
replaying payments merely to collect escalation evidence.

The fix is prepared on isolated branches. This audit does not claim a live
Lambda or PM deployment, clear the task blocker, or claim end-to-end payment
success. Those require the exact deployment and subsequent verification.
