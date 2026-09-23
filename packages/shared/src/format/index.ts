import type { AttributeDefinition, Item } from "../types.js";
import type { Diagnostic } from "./ast.js";
import { checkProgram } from "./check.js";
import { Evaluator, runsToHtml, type RenderOptions } from "./evaluate.js";
import { parseProgram } from "./parser.js";

export type { Diagnostic, Pos } from "./ast.js";
export type { RenderOptions } from "./evaluate.js";
export { escapeHtml } from "./evaluate.js";
export { convertLegacyFormat, upgradeBoardRecord, upgradeListRecord } from "./legacy.js";
export { formatDurationShort, parseDurationText } from "./values.js";

/** Version of the format language stored in `FormatSpec.version`. */
export const FORMAT_VERSION = 2;

export interface RenderedFormat {
  html: string;
  tooltip?: string;
}

export interface CompiledFormat {
  diagnostics: Diagnostic[];
  hasErrors: boolean;
  render(item: Item, opts?: RenderOptions): RenderedFormat;
}

/**
 * Parse and check a format. Rendering works even when there are errors:
 * unknown attributes render as unset, and unparsable parts are skipped.
 */
export function compileFormat(text: string, schema: AttributeDefinition[] = []): CompiledFormat {
  const { program, diagnostics } = parseProgram(text);
  diagnostics.push(...checkProgram(program, schema));
  diagnostics.sort((a, b) => a.pos.line - b.pos.line || a.pos.col - b.pos.col);
  const schemaMap = new Map(schema.map((d) => [d.key, d]));
  return {
    diagnostics,
    hasErrors: diagnostics.some((d) => d.severity === "error"),
    render(item, opts = {}) {
      const html = runsToHtml(new Evaluator(program, item, schemaMap, opts).renderToplevel());
      const tooltip = new Evaluator(program, item, schemaMap, opts).renderTooltip();
      return { html, tooltip };
    },
  };
}

/** Escape text so it renders literally inside a double-quoted format string. */
export function escapeFormatText(text: string): string {
  return text.replace(/[\\[\]"]/g, "\\$&");
}

export function formatDiagnostic(d: Diagnostic): string {
  return `${d.pos.line}:${d.pos.col}: ${d.severity === "warning" ? "warning: " : ""}${d.message}`;
}
