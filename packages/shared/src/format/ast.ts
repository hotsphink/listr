// AST for the format language described in doc/FORMAT.md.

/** 1-based source position. */
export interface Pos {
  line: number;
  col: number;
  /** Set when the position is in an inherited base format (a list's board). */
  base?: true;
}

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  pos: Pos;
}

// -- Text mode (toplevel line and the inside of strings) ---------------------

export type TextPart =
  | { k: "lit"; text: string }
  | {
      k: "ref";
      name: string;
      /** Arguments of a call to a parameterized definition. */
      args?: Expr[];
      variant?: string;
      fallback?: TextPart[];
      optSpace: boolean;
      pos: Pos;
    }
  | { k: "link"; text: TextPart[]; url: TextPart[] }
  | { k: "img"; alt: TextPart[]; url: TextPart[] };

// -- Values and conditions ----------------------------------------------------

export type LiteralValue =
  | { t: "str"; v: string }
  | { t: "num"; v: number }
  | { t: "bool"; v: boolean }
  | { t: "todo"; v: string };

export type Operand =
  | { k: "attr"; name: string; pos: Pos }
  | { k: "lit"; value: LiteralValue; pos: Pos }
  | { k: "text"; expr: Expr; pos: Pos };

export type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

export type Cond =
  | { k: "truthy"; name: string; pos: Pos }
  | { k: "set"; names: string[]; pos: Pos }
  | { k: "lit"; value: boolean }
  | { k: "cmp"; op: CmpOp; left: Operand; right: Operand; pos: Pos }
  | { k: "in"; needle: Operand; hay: Operand; pos: Pos }
  | { k: "not"; c: Cond }
  | { k: "and" | "or"; items: Cond[] };

// -- Expressions --------------------------------------------------------------

export interface MatchPattern {
  value: LiteralValue;
  /** Glob anchors for string patterns: `*"x"` is suffix, `"x"*` is prefix. */
  globStart: boolean;
  globEnd: boolean;
  pos: Pos;
}

export interface MatchArm {
  patterns: MatchPattern[];
  body: Expr;
}

export interface StyleChange {
  add: boolean;
  name: string;
}

export type Expr =
  | { k: "text"; parts: TextPart[] }
  | { k: "verbatim"; text: string }
  | { k: "seq"; items: Expr[] }
  | { k: "if"; cond: Cond; then: Expr; else?: Expr }
  | { k: "ifdef"; body: Expr; else?: Expr }
  | { k: "match"; subject: Operand; arms: MatchArm[]; elseArm?: Expr; pos: Pos }
  | { k: "join"; sep: Expr; items: Expr[] }
  | { k: "style"; changes: StyleChange[]; body?: Expr };

export interface Definition {
  name: string;
  /** Parameter names, bound to the call's arguments within `expr`. */
  params: string[];
  expr: Expr;
  pos: Pos;
}

export interface Program {
  toplevel: TextPart[];
  wrap?: { name: string; body: Expr; pos: Pos };
  tooltip?: Expr;
  defs: Map<string, Definition>;
}
