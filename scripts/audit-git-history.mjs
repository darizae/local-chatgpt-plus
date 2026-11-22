#!/usr/bin/env node
/**
 * audit-git-history.mjs
 *
 * NON-DESTRUCTIVE historical Git secret/privacy scan over all refs and objects
 * reachable in this local repository, plus reflog-reachable and dangling
 * (unreachable) objects. Runs using `git` subprocesses only. No network.
 *
 * Output contract (never print secret values or PII):
 *   - category
 *   - blob / commit / tag object id
 *   - paths that ever held the object (for blobs)
 *   - refs / commits that reach the object
 *   - a SAFE reason label / match-type (no matched text)
 *
 * The scanner intentionally FAILS (non-zero exit) if a hardcoded secret pattern
 * matches, treating it as a real finding, while ALSO emitting a distinct
 * category for known synthetic fixtures so they can be triaged apart from
 * genuine leaks.
 *
 * Does not write, rewrite, or push any refs. Does not touch .env / profiles
 * untracked private files (they are not Git objects and are never scanned).
 */

import { execFileSync } from 'node:child_process';
import { SYNTHETIC_JWT } from './synthetic-secret-fixtures.mjs';

const REPO = process.cwd();

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Detection patterns. Each entry: key-name, human category, flags.
// `fixture` marks known synthetic test fixtures that are triaged separately.
// ---------------------------------------------------------------------------

// Known synthetic jwt.io sample token used by redaction tests (allowlisted in
// .gitguardian.yml). Detected explicitly so it is not mistaken for a leak.
const JWT_SAMPLE = SYNTHETIC_JWT;

const RX = {
  aws_access_key_id: {
    re: /\b(?:AKIA|ASIA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/,
    cat: 'credential_aws_access_key_id',
  },
  aws_secret: {
    re: /[Aa][Ww][Ss][_\-]?[Ss][Ee][Cc][Rr][Ee][Tt][_\-]?[Aa][Cc][Cc][Ee][Ss][Ss][_\-]?[Kk][Ee][Yy]["']?\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/,
    cat: 'credential_aws_secret',
  },
  gcp_private_key: {
    re: /-----BEGIN (?:RSA |EC |)PRIVATE KEY-----/,
    cat: 'credential_private_key_pem',
  },
  rsa_pem: {
    re: new RegExp(['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' ')),
    cat: 'credential_rsa_pem',
  },
  ssh_key: {
    re: /-----BEGIN (?:OPENSSH|EC|DSA) PRIVATE KEY-----/,
    cat: 'credential_ssh_openssh_pem',
  },
  github_token: {
    re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/,
    cat: 'credential_github_token',
  },
  github_finegrained: {
    re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/,
    cat: 'credential_github_finegrained_pat',
  },
  slack_token: {
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,255}\b/,
    cat: 'credential_slack_token',
  },
  stripe_live: {
    re: /\bsk_live_[A-Za-z0-9]{24,255}\b/,
    cat: 'credential_stripe_live',
  },
  stripe_restricted_live: {
    re: /\brk_live_[A-Za-z0-9]{24,255}\b/,
    cat: 'credential_stripe_restricted_live',
  },
  google_api_key: {
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    cat: 'credential_google_api_key',
  },
  heroku_api_key: {
    re: /\b(?:heroku|HEROKU)[\s:=-]+[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/,
    cat: 'credential_heroku_api_key',
  },
  twilio_api_key: {
    re: /\bSK[0-9a-fA-F]{32}\b/,
    cat: 'credential_twilio_api_key',
  },
  sendgrid_api_key: {
    re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/,
    cat: 'credential_sendgrid_api_key',
  },
  openai_api_key: {
    re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,200}\b/,
    cat: 'credential_openai_api_key',
  },
  anthropic_api_key: {
    re: /\bsk-ant-(?:api03-)?[A-Za-z0-9_-]{20,200}\b/,
    cat: 'credential_anthropic_api_key',
  },
  jwt: {
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
    cat: 'credential_jwt_bearer_like',
  },
  bearer: {
    re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
    cat: 'credential_bearer',
  },
  basic_auth_uri: {
    re: /(?:https?|sql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\/\s:@]+:[^\/\s:@]+@/,
    cat: 'credential_uri_with_password',
  },
  private_key_pkcs8: {
    re: /-----BEGIN PRIVATE KEY-----/,
    cat: 'credential_private_key_pkcs8',
  },
  certificate: {
    re: /-----BEGIN (?:CERTIFICATE|CERTIFICATE REQUEST|X509 CRL)-----/,
    cat: 'credential_certificate_block',
  },
  // Generic high-entropy tokens: 40 hex (GitHub-style) or generic base64.
  high_entropy_base64: {
    re: /\b[A-Za-z0-9_\-]{40,}\b/,
    cat: 'possible_high_entropy_token',
    noisy: true,
  },
  // macOS / machine operational identifiers (aggregate category)
  home_abspath: {
    re: /\b\/Users\/[^\/\s"']{1,64}\b/,
    cat: 'machine_absolute_users_path',
  },
  private_ip: {
    re: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/,
    cat: 'machine_private_ip',
    noisy: true,
  },
  mac_serial_or_uuid_ish: {
    re: /\b[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}\b/,
    cat: 'machine_uuid_guid',
    noisy: true,
  },
  email: {
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    cat: 'pii_email',
    noisy: true,
  },
  // Generic .env-style KEY=value (aggregate privacy signal; triaged manually)
  env_assignment: {
    re: /^\s*[A-Za-z][A-Za-z0-9_]{2,}\s*=\s*["']?[^\s"']{4,}["']?\s*$/m,
    cat: 'env_assignment',
    noisy: true,
  },
};

// ---------------------------------------------------------------------------
// Object enumeration
// ---------------------------------------------------------------------------

function collectReachableSets() {
  // Map blob-sha -> { paths:Set, commits:Set (intro commit), refs:Set }
  const blobMeta = new Map();
  const commitBlobs = new Map(); // commit -> blob sha list (for blame scope)

  const allCommits = new Set(git(['rev-list', '--all']).trim().split(/\n/).filter(Boolean));

  // Compute ref -> commit reachability once.
  const refHeads = new Map(); // ref -> commit
  for (const line of git(['for-each-ref', '--format=%(refname) %(objectname)']).trim().split(/\n/).filter(Boolean)) {
    const sp = line.indexOf(' ');
    refHeads.set(line.slice(0, sp), line.slice(sp + 1));
  }

  // ability to know if a ref contains a given commit through rev-list
  const refContains = {};
  for (const [ref, head] of refHeads) {
    refContains[ref] = new Set(git(['rev-list', head]).trim().split(/\n/).filter(Boolean));
  }

  const blobsByCommit = new Map(); // commit -> array of {path, blob}
  const seenBlobCommitPath = new Set();

  const lines = git(['rev-list', '--objects', '--all']).trim().split(/\n/).filter(Boolean);
  for (const ln of lines) {
    const sp = ln.indexOf(' ');
    if (sp === -1) continue;
    const sha = ln.slice(0, sp);
    const path = ln.slice(sp + 1).trim();
    const type = git(['cat-file', '-t', sha]).trim();
    if (type !== 'blob') continue;
    if (!blobMeta.has(sha)) {
      blobMeta.set(sha, { paths: new Set(), commits: new Set(), refs: new Set() });
    }
    blobMeta.get(sha).paths.add(path);
    // mark blob reachable by every ref whose head reaches its commit — cheap:
    // we don't know the commit here, so defer: record blob->(path) and link via commit below
  }

  return { allCommits, blobsByCommit, blobMeta, refHeads, refContains };
}

// Simpler, fully correct approach: iterate over commits + their trees, keep
// blob->paths, and record which ref reaches each blob. We avoid the object-list
// path/commit ambiguity by walking `git ls-tree -r` per commit.

function buildBlobInventory() {
  const blobMeta = new Map(); // sha -> {paths:Set, commits:Set, refs:Set}
  const allCommits = new Set();

  const refs = git(['for-each-ref', '--format=%(refname) %(objectname)']).trim().split(/\n/).filter(Boolean);
  const refToHead = new Map();
  for (const ln of refs) {
    const sp = ln.indexOf(' ');
    refToHead.set(ln.slice(0, sp), ln.slice(sp + 1));
  }

  // All commits across all refs, dedup.
  const revLines = git(['rev-list', '--all']).trim().split(/\n/).filter(Boolean);
  revLines.forEach((c) => allCommits.add(c));

  // Precompute ref -> set of commits it contains.
  const refCommitSet = {};
  for (const [ref, head] of refToHead) {
    refCommitSet[ref] = new Set(
      git(['rev-list', head]).trim().split(/\n/).filter(Boolean)
    );
  }
  const refsOfCommit = new Map();
  for (const [ref, set] of Object.entries(refCommitSet)) {
    for (const c of set) {
      if (!refsOfCommit.has(c)) refsOfCommit.set(c, []);
      refsOfCommit.get(c).push(ref);
    }
  }

  for (const commit of allCommits) {
    const treeLines = git(['ls-tree', '-r', commit]).trim().split(/\n/).filter(Boolean);
    for (const ln of treeLines) {
      // <mode> <type> <sha>\t<path>
      const parts = ln.split('\t');
      if (parts.length < 2) continue;
      const path = parts[1];
      const meta = /^\S+\s+\S+\s+([0-9a-f]{40,})/.exec(parts[0]);
      if (!meta) continue;
      const sha = meta[1];
      if (!blobMeta.has(sha)) blobMeta.set(sha, { paths: new Set(), commits: new Set(), refs: new Set() });
      const rec = blobMeta.get(sha);
      rec.paths.add(path);
      rec.commits.add(commit);
      for (const r of refsOfCommit.get(commit) || []) rec.refs.add(r);
    }
  }

  return { blobMeta, allCommits };
}

function collectUnreachableBlobs() {
  // git fsck --unreachable + --lost-found style; we only want blob/tree content
  const out = git(['fsck', '--unreachable', '--no-reflogs']).trim().split(/\n/).filter(Boolean);
  const blobs = [];
  const commits = [];
  for (const ln of out) {
    const m = /\bunreachable\s+(blob|commit|tree)\s+([0-9a-f]{40,})/.exec(ln);
    if (m) {
      if (m[1] === 'blob') blobs.push(m[2]);
      else if (m[1] === 'commit') commits.push(m[2]);
    }
  }
  return { blobs, commits };
}

// ---------------------------------------------------------------------------
// Scan helpers
// ---------------------------------------------------------------------------

function matchesFor(fileContent, filename) {
  const hits = [];
  // Only these exact, deliberately published test examples are non-secrets.
  // Do not allowlist whole files: a new, unrelated credential in a test
  // fixture must still fail this scanner.
  const knownSyntheticValues = new Set([
    JWT_SAMPLE,
    ['AKIAIOS', 'FODNN7EXAMPLE'].join(''),
    ['sk-', 'abcdefghijklmnopqrstuvwxyz123456'].join(''),
    ['xoxb-', '1234567890-abcdefghijkl'].join(''),
    ['ghp_', '1234567890abcdefghijklmnopqrstuvwxyz'].join(''),
  ]);
  // Rebuild regexes cleanly (drop any shared /g state) per call.
  for (const [name, spec] of Object.entries(RX)) {
    const flags = (spec.re.flags || '').replace('g', '');
    const re = new RegExp(spec.re.source, flags + 'g');
    let m;
    let count = 0;
    while ((m = re.exec(fileContent)) !== null) {
      if (knownSyntheticValues.has(m[0])) continue;
      if (filename === 'scripts/audit-git-history.mjs') {
        // The scanner contains its own private-key detection *regex* in the
        // JS source. A regex definition is not PEM key material. Only discard
        // this syntactic scanner declaration, not the whole source file.
        const lineStart = fileContent.lastIndexOf('\n', m.index) + 1;
        const lineEnd = fileContent.indexOf('\n', m.index);
        const line = fileContent.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        if (/^\s*re:\s*\//.test(line)) continue;
      }
      count++;
      // Do not expose matched value; only record true/false per line+name
      if (count > 50) break;
    }
    if (count > 0) {
      hits.push({ name, cat: spec.cat, count, noisy: !!spec.noisy });
    }
  }
  return hits;
}

// Categories that are signals but not unambiguous credentials (triaged, not fail).
function catIsLow(cat) {
  return (
    cat.startsWith('machine_') ||
    cat === 'pii_email' ||
    cat === 'possible_high_entropy_token' ||
    cat === 'env_assignment'
  );
}

function isFixture(fileContent, filename) {
  // Detects known synthetic fixtures so they are reported separately, not as leaks.
  // Structural tests (never print the matched value): a value is demonstrably
  // synthetic if it embeds canonical placeholder markers, sequential alphabets,
  // the AWS sample key, or the generic "user:pass" URI-userinfo pair.
  const markers = [];
  if (fileContent.includes(JWT_SAMPLE)) markers.push('jwt.io-sample-token');
  if (/eyJhbGciOiJIUzI1NiJ9\.eyJzdWIiOiIxMjM0NTY3ODkwIn0\./.test(fileContent))
    markers.push('jwt.io-sample-signature');
  // Canonical AWS sample access key (AKIAIOSFODNN7EXAMPLE) used in docs/tests.
  if (/\bAKIAIOSFODNN7EXAMPLE\b/.test(fileContent)) markers.push('aws-sample-key');
  // GitHub sample PAT using the literal sequence "1234567890abcdef...".
  if (/gh[pousr]_1234567890abcdefghijklmnopqrstuvwxyz/.test(fileContent))
    markers.push('github-sample-pat');
  // OpenAPI sample key composed of the sequential alphabet.
  if (/sk-abcdefghijklmnopqrstuvwxyz123456/.test(fileContent))
    markers.push('openai-sample-key-sequential');
  // Slack sample token built from "1234567890"-style placeholders.
  if (/xoxb-1234567890-abcdefghijkl/.test(fileContent))
    markers.push('slack-sample-token');
  // Generic "user:pass@host" used to assert URL parsing/security (not real creds).
  if (/user:pass@(?:127\.0\.0\.1|localhost|0\.0\.0\.0|example\.(?:com|org))/.test(fileContent))
    markers.push('generic-userpass-uri-fixture');
  if (/fixture|synthetic|SAMPLE|sample[_-]?token|placeholder|dummy/i.test(filename))
    markers.push('fixture-file-name');
  return markers;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const { blobMeta, allCommits } = buildBlobInventory();
  const { blobs: unreachableBlobs, commits: unreachableCommits } = collectUnreachableBlobs();

  const report = {
    meta: {
      generatedAt: new Date().toISOString().slice(0, 16),
      reachableCommits: allCommits.size,
      reachableBlobs: blobMeta.size,
      unreachableCommits: unreachableCommits.length,
      unreachableBlobs: unreachableBlobs.length,
      refs: Array.from(new Set(git(['for-each-ref', '--format=%(refname)']).trim().split(/\n/).filter(Boolean))),
    },
    findings: [], // {category, objectId, kind, paths:[], refs:[], fixture:[], count}
    scannedBlobs: 0,
    fixtureOnlyBlobs: 0,
    realFindingBlobs: 0,
  };

  const scanBlob = (sha, paths, refs, kind) => {
    let content;
    try {
      content = git(['cat-file', '-p', sha]);
    } catch {
      return; // corrupt / missing — skip
    }
    report.scannedBlobs++;
    const fixture = isFixture(content, paths[0] || '');
    const hits = matchesFor(content, paths[0] || '');

    const credHits = hits.filter((h) => !h.noisy);
    const credCount = credHits.length;

    if (hits.length === 0) return;

    // Fixture override: every non-noisy credential hit corresponds to a
    // demonstrably synthetic value present in the content (never printed).
    let covered = 0;
    for (const h of credHits) {
      const cat = h.cat;
      if (
        (cat === 'credential_aws_access_key_id' && /AKIAIOSFODNN7EXAMPLE/.test(content)) ||
        (cat === 'credential_github_token' && /gh[pousr]_1234567890abcdefghijklmnopqrstuvwxyz/.test(content)) ||
        (cat === 'credential_openai_api_key' && /sk-abcdefghijklmnopqrstuvwxyz123456/.test(content)) ||
        (cat === 'credential_slack_token' && /xoxb-1234567890-abcdefghijkl/.test(content)) ||
        (cat === 'credential_jwt_bearer_like' && content.includes(JWT_SAMPLE)) ||
        (cat === 'credential_uri_with_password' && /user:pass@(?:127\.0\.0\.1|localhost|0\.0\.0\.0|example\.(?:com|org))/.test(content))
      ) {
        covered++;
      }
    }
    const allCredAreFixtures = credCount > 0 && covered === credCount;

    if ((fixture.length > 0 && credCount === 0) || allCredAreFixtures) {
      // Fixture-only: synthetic values, no genuine secret.
      report.fixtureOnlyBlobs++;
      report.findings.push({
        category: 'fixture-only',
        objectId: sha,
        kind,
        paths,
        refs,
        fixture,
        matchTypes: hits.map((h) => h.cat),
      });
      return;
    }

    report.realFindingBlobs++;
    const isHardcoded = credHits.some((h) => catIsLow(h.cat) === false);
    report.findings.push({
      category: hits
        .map((h) => (h.noisy ? h.cat + '(low)' : h.cat))
        .concat(isHardcoded ? ['HARDCODED_SECRET'] : []),
      objectId: sha,
      kind,
      paths: Array.from(paths).slice(0, 20),
      refs: Array.from(refs || []).slice(0, 30),
      fixture,
      matchTypes: hits.map((h) => h.cat),
      count: hits.reduce((a, h) => a + h.count, 0),
    });
  };

  for (const [sha, rec] of blobMeta) {
    scanBlob(sha, Array.from(rec.paths), Array.from(rec.refs), 'reachable');
  }

  // Unreachable/dangling blobs have no path/ref; flag them as such.
  for (const sha of unreachableBlobs) {
    scanBlob(sha, ['<unreachable-blob>'], [], 'unreachable');
  }

  const findings = report.findings;

  // Distinguish real hardcoded-secret findings from fixtures.
  const hardcoded = findings.filter((f) => f.category.includes('HARDCODED_SECRET'));
  const leakLike = findings.filter((f) => !f.category.includes('HARDCODED_SECRET') && !f.category.includes('fixture-only'));

  console.log('==== GIT HISTORY AUDIT (NON-DESTRUCTIVE) ====');
  console.log(JSON.stringify(report.meta, null, 2));
  console.log(`\nScanned blobs: ${report.scannedBlobs}`);
  console.log(`Fixture-only blobs (synthetic, safe): ${report.fixtureOnlyBlobs}`);
  console.log(`Blobs with at least one signal: ${report.realFindingBlobs}`);
  console.log(`\n-- HARDCODED SECRET candidates (fail) --`);
  for (const f of hardcoded) logFinding(f);
  console.log(`\n-- Other signal blobs (machine/PII/low, triage) --`);
  for (const f of leakLike) logFinding(f);
  console.log(`\n-- Fixture-only (known safe) --`);
  for (const f of findings.filter((x) => x.category.includes('fixture-only'))) logFinding(f);

  if (hardcoded.length > 0) {
    console.error(`\n[FAIL] ${hardcoded.length} hardcoded-secret candidate(s) found. Review before publication.`);
    process.exit(2);
  } else {
    console.log('\n[PASS] No unambiguous hardcoded-secret candidates. Low/uncertain signals are listed above for manual triage.');
  }
}

function logFinding(f) {
  const refs = (f.refs && f.refs.length ? f.refs.join(', ') : '');
  const paths = (f.paths && f.paths.length ? f.paths.join(', ') : '');
  const cat = Array.isArray(f.category) ? f.category.join('+') : String(f.category);
  console.log(`  [${cat}] ${f.objectId} (${f.kind})`);
  if (paths) console.log(`      paths: ${paths}`);
  if (refs) console.log(`      refs:  ${refs}`);
  if (f.fixture && f.fixture.length) console.log(`      fixture markers: ${f.fixture.join(', ')}`);
}

main();
