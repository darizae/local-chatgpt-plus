# Public candidate privacy and secret-scan triage — 2026-11-22

## Distinguish historical objects from new source content

The **215** lower-confidence signal blobs were observed in the *old private development history* (481 blobs scanned). Those commits and blobs do **not** form the parentage of the clean-root public candidate. Keeping the original GitHub repository private and publishing a new repository from one new root commit prevents old private Git objects from being inherited. A clean root does **not** remove sensitive strings from the new current files; those require separate examination.

The second clean candidate contained 234 unique current-source blobs and had 86 lower-confidence signal blobs in the custom historical scanner. Lower-confidence classifications were primarily examples of environment assignments (73), heuristic high-entropy values such as integrity hashes or test strings (13), synthetic email-shaped test values (7), synthetic UUIDs (3) and a private-IP pattern in a networking test. These categories can overlap within blobs and are **not counts of actual credentials**. The scanner initially produced one hardcoded-secret candidate in its *own regex/test-fixture source*, not in app credentials; the scanner was fixed to filter only exact known synthetic tokens and its syntactic regex definitions, without skipping an entire source file.

## Independent validation

- Gitleaks **8.30.1**, offline, was run against the original clean-root candidate and reported seven heuristic matches: a published JWT sample repeated in test/scanner code, one synthetic API key test value and one private-key matching **regular expression**, not an actual PEM file.
- Exact synthetic JWT/credential literals were reconstructed at test time rather than stored as token-shaped source strings. The .gitguardian config no longer includes an allowlisted JWT literal.
- Gitleaks **8.30.1** against the revised clean candidate's **directory and Git history** reported **zero findings**, with no secret matching contents sent to an external service.
- The repo's tracked-tree tripwire also reported zero high-confidence patterns in the revised root commit.
- A separate text privacy check found no hardcoded operator home paths, private tunnel/client/org identifiers or unrelated infrastructure/project identifiers in the revised candidate.
- The public candidate contains one root commit, no parent commits, no Git remotes, and no inherited private refs or Git history.
- The production `.env`, tunnel runtime key, OAuth credentials, private profiles and local task state are **not committed** to the candidate.

## Residual limitations

Gitleaks and the repo's own scanner are pattern-based, not cryptographic proofs that no secrets exist. Heuristic environment-assignment, high-entropy, UUID, email and private-address signals require contextual assessment and remain recorded as lower-confidence findings rather than being globally ignored. Before publishing, make sure there is no old remote/history or metadata in the new Git repository, and run a final scan against the exact commit to be pushed. Any *real* credential exposed in the old history should be revoked/rotated at the provider; scrubbing Git does not revoke it. Old private objects remain in the separately preserved private archive and must not be made public.

Do not misinterpret a clean Git scan as proof of safety while using `open`/full-machine permissions: shell commands still run with the user's operating-system privileges.
