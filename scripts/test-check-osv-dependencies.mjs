import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { checkOsv, parsePnpmPackages } from "./check-osv-dependencies.mjs";

const fixture = `lockfileVersion: '9.0'
packages:
  '@scope/name@1.2.3':
    resolution: {integrity: sha512-good}

  ordinary@2.3.4:
    resolution: {integrity: sha512-also-good}

snapshots:
  '@scope/name@1.2.3': {}
`;
const expected = [
  { name: "@scope/name", version: "1.2.3" },
  { name: "ordinary", version: "2.3.4" },
];
assert.deepEqual(parsePnpmPackages(fixture), expected);
assert.throws(() => parsePnpmPackages(fixture.replace("sha512-good", "NOT_PRESENT")), /Missing integrity/);
assert.throws(() => parsePnpmPackages("packages:\n"), /no registry packages/);

const locked = parsePnpmPackages(await fs.readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"));
assert.ok(locked.length >= 150, "expected complete pnpm dependency graph");
assert.ok(locked.some((p) => p.name === "@simplewebauthn/server" && p.version === "14.1.0"));
assert.ok(locked.some((p) => p.name === "jose" && p.version === "6.2.17"));

const requests = [];
const mock = async (_url, options) => {
  const body = JSON.parse(options.body);
  requests.push(body.queries);
  return { ok: true, json: async () => ({
    results: body.queries.map((p) => p.package.name === "ordinary" ? { vulns: [{ id: "TEST-ADVISORY" }] } : {}),
  }) };
};
assert.deepEqual(await checkOsv(expected, { fetchImpl: mock, batchSize: 1 }), [
  { name: "ordinary", version: "2.3.4", id: "TEST-ADVISORY" },
]);
assert.equal(requests.length, 2);
await assert.rejects(checkOsv(expected, { fetchImpl: async () => ({ ok: true, json: async () => ({ results: [] }) }) }), /incomplete/);
console.log(`OSV audit: ${locked.length} pinned package entries and fail-closed fixtures passed`);