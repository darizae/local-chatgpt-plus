# Open-Source CI Security Gates

This document describes the purpose, scope, and limitations of the CI security
gates in `.github/workflows/release-security.yml` and the companion credential
tripwire `scripts/check-publication-content.mjs`.

## What the workflow does

`release-security.yml` runs on `macos-latest` (the supported platform for this
macOS-first project) on every push and pull request targeting `main`, and via manual dispatch. It is a
local, self-contained gate: the job has `permissions: contents: read`, receives
**no** repository secrets, and runs only the repository's own scripts and
official GitHub Actions. It never uploads repository content to any third-party
secret-scanning service.

Steps, in order:

1. `npm ci` — clean install from the locked `package-lock.json`.
2. `npm run build` — TypeScript compile (`tsc`) to `dist/`.
3. `npm run test:smoke` — fast fail-closed security smoke check.
4. `npm test` — unit/regression suite.
5. `npm run test:integration` — MCP bridge integration suite.
6. `npm audit --omit=dev` — production dependency advisory check.
7. `npm audit` — production + dev dependency advisory check.
8. `node scripts/check-publication-content.mjs` — tracked-HEAD credential
   pattern tripwire.

The **unit/regression** step alone creates an ephemeral `open` permission
profile in the runner's temporary directory. Several tests intentionally
exercise filesystem access outside the checkout and unsafe runtime features;
this fixture is not a deployment setting. Dedicated secure-default tests still
remove the override and assert the fresh-checkout `workspace` policy.

The `timeout-minutes` bound and the self-contained test scripts (loopback
fixtures, mock transports, random local ports) keep the job deterministic and
non-flaky. No live tunnel, IdP, OAuth consent, or deployment is exercised.

## What `check-publication-content.mjs` checks

It scans only the **tracked blobs at the current `HEAD`** (`git ls-files` +
`git cat-file`) for high-confidence, real-looking credential patterns:

- AWS access key IDs (`AKIA`/`ASIA`)
- OpenAI-style secret keys (`sk-…`)
- GitHub PATs (classic `ghp_` and fine-grained `github_pat_`)
- Slack tokens (`xoxb`/`xoxa`/`xoxp`/`xoxr`/`xoxs`)
- Google API keys (`AIza…`)
- PEM private key headers
- Signed JWTs (three dotted base64url segments)

Patterns mirror the project's canonical redaction set in
`src/lib/sanitize-activity.ts`. Findings are reported **redacted** — category,
file, and line only; a detected value is never printed.

## False-positive handling

Known synthetic fixtures and documented examples are allowlisted by **exact
value** so the repo's own redaction tests and examples do not trip CI:

- A canonical public jwt.io example is assembled from separate synthetic
  segments in `scripts/synthetic-secret-fixtures.mjs` and used by
  `scripts/test-activity-log.mjs` and `scripts/test-sanitize-activity.mjs`.
  This avoids committing a JWT-shaped literal that GitHub scanners might flag.
- The placeholder values in `scripts/test-sanitize-activity.mjs`
  (documented synthetic OpenAI-style, GitHub, and Slack key examples).
- AWS's documented example access key id `AKIAIOSFODNN7EXAMPLE`.

Because matching is exact, adding a new real secret that resembles a fixture is
not silenced. If a change adds a new synthetic fixture, add its exact value to
the `ALLOWLIST` set in the script, not a loose pattern.

## Limitations (do not treat as a substitute)

- **HEAD-only.** This checks the current tracked tree, not staged/untracked
  content and **not** past Git history — reflogs, unreachable objects, old
  refs, or blobs removed between commits. A clean `HEAD` does not prove
  history is clean. Publishing an existing repository requires an independent
  full-history audit and, where necessary, a rewritten, sanitized history.
- **Pattern matching, not detection.** Strict patterns keep false positives
  low but miss obfuscated or low-signal secrets. This is a tripwire, not a
  general-purpose secret scanner.
- **No secret access by design.** The workflow has no repository secrets and
  cannot validate runtime credentials or OAuth flows; those remain manual,
  controlled validation gates (see `OPEN_SOURCE_RELEASE_SECURITY.md`).
- **`npm audit` reflects known advisories only.** Zero findings is not proof
  the supply chain is flawless; lockfile provenance and license attribution are
  reviewed separately.
