interface AttributeHint {
  key: string;
  label: string;
  type: string;
}

export interface ImportScope {
  type: "global" | "board" | "list";
  name?: string;
  schema?: AttributeHint[];
}

export interface ImportedItem {
  title: string;
  attributes: Record<string, unknown>;
}

export interface ImportedList {
  name: string;
  items: ImportedItem[];
}

export interface ImportedBoard {
  name: string;
  lists: ImportedList[];
}

export interface ImportResult {
  boards: ImportedBoard[];
}

function typeHint(type: string, key: string, label: string): string {
  if (type === "duration") return `duration string like "2h21" or "1h30m" or "45m"`;
  if (type === "number") {
    const l = label.toLowerCase();
    if (l.includes("imdb")) return "decimal 0.0–10.0";
    if (l.includes("rotten") || l.includes(" rt")) return "integer 0–100";
    return "number";
  }
  if (type === "boolean") return `"yes" or "no"`;
  if (type === "date") return "date string";
  if (type === "tags") return "array of strings";
  return "string";
}

function buildPrompt(scope: ImportScope): string {
  const lines: string[] = [];

  if (scope.type === "list") {
    lines.push("Extract all visible items from this screenshot.");
    lines.push("");
    lines.push("Return a JSON object with this exact structure (no markdown fences):");
    lines.push('{ "items": [ { "title": "..." } ] }');
    lines.push("");
    lines.push("Extract every visible card or item into the single flat list. Do not split by board column or list name.");
    lines.push("");
  } else {
    lines.push("Extract structured data from this screenshot of a set of lists.");
    lines.push("");
    lines.push("Return a JSON object with this exact structure (no markdown fences):");
    lines.push('{ "lists": [ { "name": "...", "items": [ { "title": "..." } ] } ] }');
    lines.push("");
  }

  if (scope.schema && scope.schema.length > 0) {
    lines.push("In addition to \"title\", each item object may include these typed attribute fields extracted from the card text:");
    lines.push("");
    for (const a of scope.schema) {
      lines.push(`  "${a.key}" — ${a.label}: ${typeHint(a.type, a.key, a.label)}`);
    }
    lines.push("");
    lines.push("Card text often encodes multiple attributes inline after the title.");
    lines.push('Example: the card "Poor things 2h21 7.8" → { "title": "Poor things", "duration": "2h21", "imdb": 7.8 }');
    lines.push("");
    lines.push("Rules:");
    lines.push("- Include an attribute field when you are somewhat confident about its value.");
    lines.push("- When too uncertain, leave the full text in the title and omit the attribute.");
    lines.push("- The title is the card text remaining after identified attribute values are removed.");
    lines.push("- number attributes must be JSON numbers, not strings.");
  } else {
    lines.push("Extract only \"title\" from each card. Do not add any other fields.");
  }

  return lines.join("\n");
}

/** Endpoint template used when a family does not supply one. Placeholders name
 * fields of the entry, so a provider with a different URL shape or auth field
 * joins the chain by setting its own template. */
export const DEFAULT_MODEL_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}";

/** One link in the ordered fallback chain. `fields` holds the model's own keys
 * merged over its family's, and `url` expands against those same fields. */
export interface ModelConfig {
  model: string;
  url: string;
  fields: Record<string, string>;
}

function expandUrl(entry: ModelConfig, fields: Record<string, string>): string {
  return entry.url.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = fields[key];
    if (value === undefined) {
      throw new Error(`model '${entry.model}' url references unknown key '${key}'`);
    }
    return value;
  });
}

// Return a copy of a dict with all secret values replaced with "<redacted>".
function sanitize(fields: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = { ...fields };
  for (const key of Object.keys(safe)) {
    if (/key|token|secret|password/i.test(key)) safe[key] = "<redacted>";
  }
  return safe;
}

// Credentials ride in the URL and in provider error bodies, so redact them in
// anything headed for a log or for the browser. index.ts forwards error text to
// the client.
function redact(err: unknown, fields: Record<string, string>): string {
  let message = err instanceof Error ? err.message : String(err);
  for (const [k, v] of Object.entries(sanitize(fields))) {
    if (v === "<redacted>" && fields[k]) {
      message = message.replaceAll(fields[k], v);
    }
  }
  return message;
}

async function requestExtraction(
  entry: ModelConfig,
  imageBase64: string,
  mimeType: string,
  scope: ImportScope,
  signal: AbortSignal,
): Promise<ImportResult> {
  console.log(`[gemini] POST ${expandUrl(entry, sanitize(entry.fields))}`);
  const response = await fetch(expandUrl(entry, entry.fields), {
    signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: mimeType, data: imageBase64 } },
        { text: buildPrompt(scope) },
      ]}],
      generationConfig: { responseMimeType: "application/json" },
    }),
  });

  console.log(`[gemini] response status ${response.status}`);
  if (!response.ok) {
    throw new Error(`${entry.model} API ${response.status}: ${await response.text()}`);
  }

  const result = await response.json() as any;
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  console.log(`[gemini] response text length ${text?.length ?? 0}`);
  if (!text) throw new Error(`Empty response from ${entry.model}`);

  // Strip markdown fences if present (v1 models sometimes wrap JSON in ```json ... ```)
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned) as ImportResult;
  } catch {
    throw new Error(`${entry.model} returned invalid JSON: ${cleaned.slice(0, 300)}`);
  }
}

// Run a tier's models against each other and keep the first usable answer.
// Abort the rest, so a slow straggler neither holds up the import nor burns
// quota once the result is already in hand.
async function runTier(
  tier: ModelConfig[],
  imageBase64: string,
  mimeType: string,
  scope: ImportScope,
  failures: string[],
): Promise<ImportResult> {
  const controller = new AbortController();
  const attempts = tier.map(async (entry) => {
    try {
      return await requestExtraction(entry, imageBase64, mimeType, scope, controller.signal);
    } catch (err) {
      // Losing a race is not a failure worth reporting.
      if (controller.signal.aborted) throw err;
      const message = redact(err, entry.fields);
      console.error(`[gemini] ${entry.model} failed: ${message}`);
      failures.push(`${entry.model}: ${message}`);
      throw err;
    }
  });

  try {
    const result = await Promise.any(attempts);
    console.log(`[gemini] tier answered from ${tier.length} model(s)`);
    return result;
  } finally {
    controller.abort();
  }
}

/** Try each tier in order, racing the models within a tier, and return the
 * first usable answer. */
export async function extractFromImage(
  imageBase64: string,
  mimeType: string,
  scope: ImportScope,
  tiers: ModelConfig[][],
): Promise<ImportResult> {
  const usable = tiers.filter((tier) => tier.length > 0);
  if (usable.length === 0) throw new Error("No import model configured");

  const failures: string[] = [];
  for (const tier of usable) {
    try {
      return await runTier(tier, imageBase64, mimeType, scope, failures);
    } catch {
      // Whole tier failed, so drop to the next one.
    }
  }
  throw new Error(`All models failed. ${failures.join("; ")}`);
}
