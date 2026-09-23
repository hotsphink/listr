import type { AttributeDefinition, Item } from "../types.js";
import type { Diagnostic, Program } from "./ast.js";
import { checkProgram } from "./check.js";
import { Evaluator, runsToHtml, type RenderOptions } from "./evaluate.js";
import { parseProgram } from "./parser.js";

export type { Diagnostic, Pos } from "./ast.js";
export type { RenderOptions } from "./evaluate.js";
export { escapeHtml } from "./evaluate.js";
export { convertLegacyFormat, upgradeBoardRecord, upgradeListRecord } from "./legacy.js";
export { formatDurationShort, isSet, parseDurationText } from "./values.js";

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
 * Combine a list's format with its board's. The list's toplevel line always
 * wins. Its definitions add to and replace the board's, and a wrap or tooltip
 * in the list replaces the board's.
 */
function inherit(base: Program, own: Program): Program {
  return {
    toplevel: own.toplevel,
    wrap: own.wrap ?? base.wrap,
    tooltip: own.tooltip ?? base.tooltip,
    defs: new Map([...base.defs, ...own.defs]),
  };
}

/**
 * Parse and check a format. Pass `base` (the board's format text) to compile
 * a list override that inherits from it; diagnostics then cover only `text`.
 * Rendering works even when there are errors: unknown attributes render as
 * unset, and unparsable parts are skipped.
 */
export function compileFormat(text: string, schema: AttributeDefinition[] = [], base?: string): CompiledFormat {
  const parsed = parseProgram(text);
  const program = base === undefined ? parsed.program : inherit(parseProgram(base, true).program, parsed.program);
  const diagnostics = parsed.diagnostics;
  diagnostics.push(...checkProgram(program, schema).filter((d) => !d.pos.base));
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
