// Credential redaction for anything headed for a log, the browser, or the
// console. Credentials ride in URLs and echo back in provider error bodies, so
// redaction replaces values wherever they appear rather than by position.

const SECRET_FIELD = /key|token|secret|password/i;
const REDACTED = "<redacted>";

/** A copy of `fields` with every credential-named value replaced. */
export function sanitize(fields: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = { ...fields };
  for (const key of Object.keys(safe)) {
    if (SECRET_FIELD.test(key)) safe[key] = REDACTED;
  }
  return safe;
}

/** The credential values in `fields`, raw and URL-encoded, longest first. */
function secretValues(fields: Record<string, unknown>): string[] {
  const values = new Set<string>();
  for (const [key, value] of Object.entries(fields)) {
    if (!SECRET_FIELD.test(key) || typeof value !== "string" || !value) continue;
    values.add(value);
    values.add(encodeURIComponent(value));
  }
  return [...values].sort((a, b) => b.length - a.length);
}

/** Replace every credential value from `fields` that appears in `text`. */
export function redactText(text: string, fields: Record<string, unknown>): string {
  let out = text;
  for (const v of secretValues(fields)) out = out.replaceAll(v, REDACTED);
  return out;
}

/** An error's message with credentials from `fields` redacted. */
export function redact(err: unknown, fields: Record<string, unknown>): string {
  return redactText(err instanceof Error ? err.message : String(err), fields);
}
