/**
 * Server-side activity sanitization boundary.
 *
 * Every MCP tool argument, command preview, error message and audit detail
 * that can reach the Admin API (HTTP `/api/activity*`) or the SSE stream
 * (`/api/activity/stream`) passes through here FIRST. Redaction therefore
 * happens before sensitive data is retained in memory or transmitted to the
 * frontend — never merely hidden in the browser.
 *
 * Design rule: prefer explicitly permitted fields over serializing arbitrary
 * tool arguments. Anything not on the safe allowlist is dropped, not echoed.
 */
import { boundDiagnosticValue } from "./bounded-value.js";

/** Keys whose values are treated as secrets regardless of content. */
const SENSITIVE_KEY =
  /(pass(word|phrase)?|secret|token|api[_-]?key|apikey|access[_ -]?key|private[_-]?key|authorization|auth|cookie|credential|refresh[_-]?token|id[_-]?token|access[_-]?token|x-api-key|bearer|iv|salt|otp|pin|pwd|client[_-]?secret)/i;

/** Known secret-looking value shapes, applied to any text. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, // JWT
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, // AWS access key
  /\bsk-[A-Za-z0-9]{16,}\b/g, // OpenAI-style secret key
  /\bghp_[A-Za-z0-9]{20,}\b/g, // GitHub PAT
  /\bgho_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY BLOCK-----/g, // raw key header must never persist
];

function hasSecretPrefix(value: string): boolean {
  return /^(sk-|ghp_|gho_|github_pat_|xox[baprs]-|AIza|AKIA|ASIA)/.test(value);
}

function isSecretLikeString(value: string): boolean {
  if (hasSecretPrefix(value)) return true;
  if (/\beyJ[A-Za-z0-9_-]{10,}/.test(value)) return true;
  return false;
}

/**
 * Redact known secret shapes embedded anywhere in free text (commands,
 * previews, error messages, JWT/API-key/token jobs).
 */
export function redactSecretsInText(text: string): string {
  if (!text) return text;
  let out = text;
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, (match) => `${match.slice(0, 6)}…[redacted]`);
  }
  // sensitive KEY=VALUE assignments, e.g. `--token abcd` / `KEY=secret`
  out = out.replace(/(\b[A-Za-z_][A-Za-z0-9_]*)\s*=\s*(["']?)([^\s"';]{4,})\2/g, (match, key, quote) => {
    if (SENSITIVE_KEY.test(key)) return `${key}=${quote}[redacted]${quote}`;
    return match;
  });
  return out;
}

/**
 * Generic recursive redactor for opaque `details` objects (e.g. per-tool
 * audit details). Redacts any sensitive-key value and secret-looking strings
 * without pre-shrinking the data — callers apply their OWN size bound via
 * `boundDiagnosticValue`, so a redactor must not shrink under that limit.
 * Keeps non-sensitive structure intact.
 */
export function sanitizeDetails(
  details: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!details || typeof details !== "object") return details as Record<string, unknown> | undefined;
  const seen = new WeakSet<object>();

  const walk = (value: unknown, keyHint?: string): unknown => {
    if (value === null || value === undefined) return value;
    if (typeof value === "string") {
      if (keyHint && SENSITIVE_KEY.test(keyHint)) return "[redacted]";
      if (isSecretLikeString(value)) return "[redacted]";
      return redactSecretsInText(value);
    }
    if (typeof value === "boolean" || typeof value === "number") return value;
    if (Array.isArray(value)) return value.map((item) => walk(item));
    if (typeof value === "object") {
      if (seen.has(value)) return "[circular]";
      seen.add(value);
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = walk(v, k);
      }
      return out;
    }
    return String(value);
  };

  return walk(details) as Record<string, unknown>;
}

/** Fields that are safe to surface generically across tools. */
const SAFE_GENERIC_KEYS: Record<string, true> = {
  path: true, pattern: true, files: true, query: true, limit: true, offset: true,
  cwd: true, working_directory: true, workspace: true, name: true, id: true,
  server_id: true, label: true, action: true, kind: true, concurrency: true,
  branch: true, worktree_path: true, extensions: true, ignore_case: true,
  hidden: true, gitignore: true, mode: true, root: true, source: true, target: true,
  url: true, tab_id: true, window_id: true, element: true, selector: true,
  region: true, estimated: true, phase: true, reason: true, checkpoint_id: true,
  loop_id: true, transaction_id: true, task_id: true, project_root: true,
  result_id: true, batch_id: true, stale_hours: true, scope: true, disable: true,
  max_attempts: true, now: true, timeout: true,
};

/** Command-like fields always redacted as free text. */
const COMMAND_KEYS: Record<string, true> = { command: true, commands: true, script: true };

/**
 * Build a bounded, allowed-only representation of tool arguments for the
 * activity feed. Anything not on the explicit allowlist is dropped — arbitrary
 * argument objects are never serialized wholesale.
 */
export function sanitizeToolArguments(
  tool: string,
  args: unknown
): Record<string, unknown> | undefined {
  if (!args || typeof args !== "object") return undefined;
  const a = args as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of Object.keys(COMMAND_KEYS)) {
    if (!(key in a)) continue;
    const value = a[key];
    if (typeof value === "string") out[key] = redactSecretsInText(value);
    else if (Array.isArray(value)) {
      out[key] = value.map((x) =>
        typeof x === "string" ? redactSecretsInText(x) : boundDiagnosticValue(x)
      );
    }
  }

  if (tool === "subagent") {
    if (typeof a.objective === "string") out.objective = redactSecretsInText(a.objective).slice(0, 140);
    else if (a.objective != null) out.objective = "[objective redacted]";
    if (typeof a.label === "string") out.label = a.label.slice(0, 60);
  }

  for (const key of Object.keys(SAFE_GENERIC_KEYS)) {
    if (!(key in a) || key in out) continue;
    const value = a[key];
    if (typeof value === "string") out[key] = redactSecretsInText(value);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value)) {
      out[key] = value.map((x) =>
        typeof x === "string" ? redactSecretsInText(x) : boundDiagnosticValue(x)
      );
    } else {
      out[key] = boundDiagnosticValue(value);
    }
  }

  return Object.keys(out).length ? out : undefined;
}