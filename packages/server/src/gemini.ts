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
    lines.push('{ "boards": [ { "name": "items", "lists": [ { "name": "items", "items": [ { "title": "..." } ] } ] } ] }');
    lines.push("");
    lines.push("Extract every visible card or item into the single flat list. Do not split by board column or list name.");
    lines.push("");
  } else {
    lines.push("Extract structured data from this Trello board screenshot.");
    lines.push("");
    lines.push("Return a JSON object with this exact structure (no markdown fences):");
    lines.push('{ "boards": [ { "name": "...", "lists": [ { "name": "...", "items": [ { "title": "..." } ] } ] } ] }');
    lines.push("");

    if (scope.type === "board" && scope.name) {
      lines.push(`This board is named "${scope.name}". Use "${scope.name}" as the single board name.`);
    } else {
      lines.push("The board title becomes the board name. Each Trello list becomes a list within that board.");
    }
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
    lines.push("- Only include an attribute field when you are confident about its value.");
    lines.push("- When uncertain, leave the full text in the title and omit the attribute.");
    lines.push("- The title is the card text remaining after identified attribute values are removed.");
    lines.push("- Preserve parenthetical notes like (SC) or (CF) in the title — they are not attributes.");
    lines.push("- number attributes must be JSON numbers, not strings.");
  } else {
    lines.push("Extract only \"title\" from each card. Do not add any other fields.");
  }

  return lines.join("\n");
}

function apiUrl(model: string, apiKey: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
}

export async function extractFromImage(
  imageBase64: string,
  mimeType: string,
  scope: ImportScope,
  apiKey: string,
  model = "gemini-2.0-flash-lite",
): Promise<ImportResult> {
  console.log(`[gemini] POST ${apiUrl(model, "<key>")}`);
  const response = await fetch(apiUrl(model, apiKey), {
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
    throw new Error(`Gemini API ${response.status}: ${await response.text()}`);
  }

  const result = await response.json() as any;
  const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
  console.log(`[gemini] response text length ${text?.length ?? 0}`);
  if (!text) throw new Error("Empty response from Gemini");

  // Strip markdown fences if present (v1 models sometimes wrap JSON in ```json ... ```)
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  try {
    return JSON.parse(cleaned) as ImportResult;
  } catch {
    throw new Error(`Gemini returned invalid JSON: ${cleaned.slice(0, 300)}`);
  }
}
