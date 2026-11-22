/** Classify common failures without ever persisting raw provider error output. */
export function safeWorkerFailureReason(output: string, fallback: string): string {
  if (/\b401\b[\s\S]{0,100}(?:invalid api key|unauthori[sz]ed|authentication failed)/i.test(output) ||
      /(?:invalid api key|authentication failed)[\s\S]{0,80}\b401\b/i.test(output)) {
    return "Model provider authentication rejected (HTTP 401); check credentials before retry";
  }
  if (/\b429\b[\s\S]{0,100}(?:rate.limit|too many requests)/i.test(output)) {
    return "Model provider rate limit (HTTP 429); retry only after checking limits";
  }
  return fallback;
}
