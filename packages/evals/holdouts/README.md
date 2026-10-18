# Protected holdout preparation records

Only public metadata belongs here. Actual questions, assessment expectations and
independent query evidence remain in the author's private vault outside the
implementation repository and context until the required release boundary.

Set `hs_547e0142c0a64d0b88246c763258b38a` is independently authored by
`log54-sealed-author`, with two questions per role. Its
[registration](hs_547e0142c0a64d0b88246c763258b38a/registration.json) records the
author's declarations and hashes; it contains no questions, specific cases or
expected values. The author confirmed independent SQL verification and private
file permissions. Registration does not establish an actual freeze, question
release, model answer or passing holdout result.

The durable private vault is retained by the author at
`/Users/adrian/Documents/Log-Insights-Holdout/hs_547e0142c0a64d0b88246c763258b38a`.
The implementation has read only its public `metadata.json`. Do not open or copy
the other files before a valid freeze. They are not Git artifacts. Private
expectations stay separate after the question release too.

The [runtime smoke observation](runtime-smoke-2026-10-18/observation.json) and its
[complete corpus receipt](runtime-smoke-2026-10-18/receipt.json) demonstrate the
read-only runtime observer against the actual local database on 18 October 2026.
It matched the configured running ARM64 image, loopback port, full base corpus,
data version and lockfile. The receipt hash in the observation hashes canonical
receipt JSON; repository formatting preserves those values, signature and result
digest. This probe read no private holdout file, called no model and performed
no freeze. It is not the required runtime observation of a later accepted Dev
round and cannot authorize release.

Use the [protected preparation workflow](../README.md#protected-holdout-preparation).
A complete independently reviewed development pass, matching runtime evidence and
saved immutable freeze are still required. Missing gates remain closed.
