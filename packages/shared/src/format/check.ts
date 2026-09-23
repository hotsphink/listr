// Static checks of a parsed format program against a board schema.

import type { AttributeDefinition, AttributeType } from "../types.js";
import type { Cond, Diagnostic, Expr, Operand, Pos, Program, TextPart } from "./ast.js";
import { attrType, typesComparable, valueTypeOf, variantError, isTextVariant, type ValueType } from "./values.js";

interface Scope {
  locals: Set<string>;
  /** Derived attributes referenced, for cycle detection. */
  deps: Set<string>;
}

export function checkProgram(program: Program, schemaList: AttributeDefinition[]): Diagnostic[] {
  const schema = new Map(schemaList.map((d) => [d.key, d]));
  const diags: Diagnostic[] = [];
  const error = (message: string, pos: Pos) => diags.push({ severity: "error", message, pos });
  const warn = (message: string, pos: Pos) => diags.push({ severity: "warning", message, pos });

  const typeOf = (name: string): AttributeType | undefined => attrType(name, schema);
  const isDerived = (name: string, scope: Scope) =>
    typeOf(name) === undefined && (scope.locals.has(name) || program.defs.has(name));

  for (const def of program.defs.values()) {
    if (typeOf(def.name) !== undefined) {
      error(`'${def.name}' is already an attribute; a derived attribute cannot shadow it`, def.pos);
    }
    for (const p of def.params) {
      if (typeOf(p) !== undefined || program.defs.has(p)) {
        error(`parameter '${p}' of '${def.name}' shadows an attribute or definition`, def.pos);
      }
    }
  }
  if (program.wrap && (typeOf(program.wrap.name) !== undefined || program.defs.has(program.wrap.name))) {
    error(`wrap name '${program.wrap.name}' shadows an attribute or definition`, program.wrap.pos);
  }

  const checkName = (name: string, pos: Pos, scope: Scope): boolean => {
    if (typeOf(name) !== undefined) return true;
    if (scope.locals.has(name)) return true;
    if (program.defs.has(name)) {
      scope.deps.add(name);
      return true;
    }
    error(`unknown attribute '${name}'`, pos);
    return false;
  };

  /** Check that a reference passes a definition the arguments it takes. */
  const checkArity = (ref: Extract<TextPart, { k: "ref" }>, scope: Scope): void => {
    const nargs = ref.args?.length ?? 0;
    const def = typeOf(ref.name) === undefined && !scope.locals.has(ref.name) ? program.defs.get(ref.name) : undefined;
    const nparams = def?.params.length ?? 0;
    if (nargs > 0 && nparams === 0) {
      error(`'${ref.name}' is not a parameterized definition and takes no arguments`, ref.pos);
    } else if (def && nargs !== nparams) {
      error(`'${ref.name}' takes ${nparams} argument${nparams === 1 ? "" : "s"} (${def.params.join(", ")}) but got ${nargs}`, ref.pos);
    }
  };

  const checkText = (parts: TextPart[], scope: Scope): void => {
    for (const p of parts) {
      if (p.k === "ref") {
        if (!checkName(p.name, p.pos, scope)) continue;
        checkArity(p, scope);
        for (const arg of p.args ?? []) checkExpr(arg, scope);
        if (p.variant) {
          const type = typeOf(p.name);
          const err = type !== undefined
            ? variantError(p.variant, type)
            : isTextVariant(p.variant) ? null : `':${p.variant}' does not apply to derived values`;
          if (err) error(err, p.pos);
        }
        if (p.fallback) checkText(p.fallback, scope);
      } else if (p.k === "link") {
        checkText(p.text, scope);
        checkText(p.url, scope);
      } else if (p.k === "img") {
        checkText(p.alt, scope);
        checkText(p.url, scope);
      }
    }
  };

  const operandType = (op: Operand, scope: Scope): ValueType | undefined => {
    switch (op.k) {
      case "attr": {
        const type = typeOf(op.name);
        if (type !== undefined) return valueTypeOf(type);
        if (isDerived(op.name, scope)) error(`@${op.name} is a derived attribute; use [?${op.name}] or "[${op.name}]"`, op.pos);
        else error(`unknown attribute '${op.name}'`, op.pos);
        return undefined;
      }
      case "lit":
        return op.value.t;
      case "text":
        checkExpr(op.expr, scope);
        return "str";
    }
  };

  const checkCond = (cond: Cond, scope: Scope): void => {
    switch (cond.k) {
      case "truthy":
        operandType({ k: "attr", name: cond.name, pos: cond.pos }, scope);
        break;
      case "set":
        for (const n of cond.names) {
          if (!checkName(n, cond.pos, scope)) continue;
          if (typeOf(n) === "boolean") {
            warn(`booleans are always set, so [?${n}] is always true; use @${n} to test the value`, cond.pos);
          }
          const nparams = scope.locals.has(n) ? 0 : program.defs.get(n)?.params.length ?? 0;
          if (nparams > 0) error(`'${n}' needs arguments; test "[${n}(...)]" != "" instead`, cond.pos);
        }
        break;
      case "cmp": {
        const a = operandType(cond.left, scope);
        const b = operandType(cond.right, scope);
        if (a && b && !typesComparable(a, b, cond.op)) {
          error(`cannot compare ${a} ${cond.op} ${b}`, cond.pos);
        }
        break;
      }
      case "in": {
        operandType(cond.needle, scope);
        const hay = operandType(cond.hay, scope);
        if (hay && hay !== "tags" && hay !== "str") error(`'in' needs tags or text on the right, not ${hay}`, cond.pos);
        break;
      }
      case "not":
        checkCond(cond.c, scope);
        break;
      case "and":
      case "or":
        cond.items.forEach((c) => checkCond(c, scope));
        break;
      case "lit":
        break;
    }
  };

  const checkExpr = (expr: Expr, scope: Scope): void => {
    switch (expr.k) {
      case "text":
        checkText(expr.parts, scope);
        break;
      case "verbatim":
        break;
      case "seq":
        expr.items.forEach((e) => checkExpr(e, scope));
        break;
      case "if":
        checkCond(expr.cond, scope);
        checkExpr(expr.then, scope);
        if (expr.else) checkExpr(expr.else, scope);
        break;
      case "ifdef":
        checkExpr(expr.body, scope);
        if (expr.else) checkExpr(expr.else, scope);
        break;
      case "match": {
        const subject = operandType(expr.subject, scope);
        for (const arm of expr.arms) {
          for (const p of arm.patterns) {
            if (subject && p.value.t !== subject) {
              error(`pattern of type ${p.value.t} can never match a ${subject} value`, p.pos);
            }
          }
          checkExpr(arm.body, scope);
        }
        if (expr.elseArm) checkExpr(expr.elseArm, scope);
        break;
      }
      case "join":
        checkExpr(expr.sep, scope);
        expr.items.forEach((e) => checkExpr(e, scope));
        break;
      case "style":
        if (expr.body) checkExpr(expr.body, scope);
        break;
    }
  };

  checkText(program.toplevel, { locals: new Set(), deps: new Set() });
  if (program.wrap) {
    checkExpr(program.wrap.body, { locals: new Set([program.wrap.name]), deps: new Set() });
  }
  if (program.tooltip) checkExpr(program.tooltip, { locals: new Set(), deps: new Set() });

  const deps = new Map<string, Set<string>>();
  for (const def of program.defs.values()) {
    const scope: Scope = { locals: new Set(def.params), deps: new Set() };
    checkExpr(def.expr, scope);
    deps.set(def.name, scope.deps);
  }

  // Report each derived attribute that is part of a cycle.
  const state = new Map<string, "visiting" | "done">();
  const inCycle = new Set<string>();
  const visit = (name: string, stack: string[]): void => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      stack.slice(stack.indexOf(name)).forEach((n) => inCycle.add(n));
      return;
    }
    state.set(name, "visiting");
    for (const d of deps.get(name) ?? []) visit(d, [...stack, name]);
    state.set(name, "done");
  };
  for (const name of deps.keys()) visit(name, []);
  for (const name of inCycle) {
    error(`'${name}' refers to itself through other definitions`, program.defs.get(name)!.pos);
  }

  return diags;
}
