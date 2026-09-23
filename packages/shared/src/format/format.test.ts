import { describe, it, expect } from "vitest";
import { compileFormat, convertLegacyFormat, escapeFormatText, formatDiagnostic, upgradeBoardRecord, upgradeListRecord } from "./index.js";
import type { AttributeDefinition, AttributeType, Item } from "../types.js";

function item(title: string, attributes: Record<string, unknown> = {}): Item {
  return { id: "i", list_id: "l", title, after_id: null, created_at: 0, updated_at: 0, attributes };
}

function schema(types: Record<string, AttributeType>): AttributeDefinition[] {
  return Object.entries(types).map(([key, type], position) => ({ key, label: key, type, required: false, position }));
}

const S = schema({
  notes: "text",
  imdb_id: "text",
  todo: "todo",
  rotten: "number",
  rating: "number",
  duration: "duration",
  important: "boolean",
  tags: "tags",
  due: "date",
});

function render(text: string, attrs: Record<string, unknown> = {}, title = "Alien") {
  const f = compileFormat(text, S);
  return f.render(item(title, attrs), { urlResolver: (u) => u.replace(/^hash:\/\//, "blob:") });
}

function html(text: string, attrs: Record<string, unknown> = {}, title = "Alien"): string {
  return render(text, attrs, title).html;
}

function errors(text: string): string[] {
  return compileFormat(text, S).diagnostics.map(formatDiagnostic);
}

describe("text mode", () => {
  it("renders attributes and literal text", () => {
    expect(html("[title] (rated [rating])", { rating: 4 })).toBe("Alien (rated 4)");
  });

  it("escapes attribute values but passes literal HTML through", () => {
    expect(html("<b>[title]</b>", {}, "a<b>")).toBe("<b>a&lt;b&gt;</b>");
  });

  it("supports variants", () => {
    expect(html("[title:upper] [duration:short] [duration] [rating:stars]", { duration: 148, rating: 4 }))
      .toBe("ALIEN 2h28m 2 hours 28 minutes \u2605\u2605\u2605\u2605\u2606");
    expect(html("[title:url]", {}, "a b")).toBe("a%20b");
  });

  it("uses the fallback only when unset, so 0 still renders", () => {
    expect(html("[rating/none]", { rating: 0 })).toBe("0");
    expect(html("[rating/none]", {})).toBe("none");
    expect(html("[rating/[title]]", {})).toBe("Alien");
  });

  it("suppresses the space before ?[x] when x is empty", () => {
    expect(html("[title] ?[duration:short]!", { duration: 90 })).toBe("Alien 1h30m!");
    expect(html("[title] ?[duration:short]!", {})).toBe("Alien!");
    expect(html("[title] \\?[duration:short]", {})).toBe("Alien ?");
  });

  it("renders links and images, resolving hash URLs", () => {
    expect(html("[IMDB](https://imdb.com/find?q=[title:url])")).toBe('<a href="https://imdb.com/find?q=Alien">IMDB</a>');
    expect(html("![logo](hash://abc.png)")).toBe('<img src="blob:abc.png" alt="logo">');
    expect(html("[title]\\(x)")).toBe("Alien(x)");
  });

  it("reports stray brackets", () => {
    expect(errors("a [b c] d")[0]).toMatch(/invalid reference/);
    expect(errors("a \\[b c] d")).toEqual([]);
  });

  it("renders unchecked todos as an icon and their :str form", () => {
    expect(html("[todo] [todo:str]")).toBe("\u2610 unchecked");
    expect(html("[todo] [todo:str]", { todo: "done" })).toBe("\u2611 done");
  });
});

describe("definitions and strings", () => {
  it("expands derived attributes recursively", () => {
    expect(html("[a]\n\na=\"<[b]>\"\nb='[title]'")).toBe("<Alien>");
  });

  it("supports flexible and verbatim quotes", () => {
    expect(html("[a][b][c]\n\na=q( x \"y\" )\nb=q<< [title] >>\nc=v( [title] )")).toBe('x "y"Alien[title]');
  });

  it("strips only one space inside flexible quotes", () => {
    expect(html("|[a]|\n\na=q(  x  )")).toBe("| x |");
  });

  it("supports indented multi-line definitions", () => {
    const text = [
      "[d]",
      "",
      "d=",
      "  ifdef:",
      '    "has [notes]"',
      "  else:",
      '    "none"',
      "  end",
      "e=\"unused\"",
    ].join("\n");
    expect(html(text, { notes: "n" })).toBe("has n");
    expect(html(text)).toBe("none");
  });

  it("treats a zero-width indent as an empty definition", () => {
    expect(html("x[d]x\n\nd=\ne=\"y\"")).toBe("xx");
  });

  it("allows comments outside strings", () => {
    expect(html("[a]\n\n# comment\na=\"#x\" # trailing")).toBe("#x");
  });
});

describe("conditionals", () => {
  it("distinguishes set from truthy", () => {
    const text = "[a]\n\na=cond([?rating], \"set\", \"unset\") \"/\" cond(@rating, \"truthy\", \"falsy\")";
    expect(html(text, { rating: 0 })).toBe("set/falsy");
    expect(html(text, { rating: 3 })).toBe("set/truthy");
    expect(html(text, {})).toBe("unset/falsy");
  });

  it("treats absent booleans as false", () => {
    expect(html("[a]\n\na=cond(@important, \"!\", \"-\")")).toBe("-");
    expect(html("[a]\n\na=cond(@important == false, \"f\")")).toBe("f");
  });

  it("supports if/else blocks that span lines", () => {
    const text = "[t]\n\nt=if [?notes]:\n  \" ([notes])\"\nelse:\n  \"\"\nend";
    expect(html(text, { notes: "hi" })).toBe(" (hi)");
    expect(html(text)).toBe("");
  });

  it("checks direct references in ifdef", () => {
    const text = "[t]\n\nt=ifdef: q( [imdb_id] [notes/-] ) else: \"no\" end";
    expect(html(text, { imdb_id: "tt1" })).toBe("tt1 -");
    expect(html(text, { notes: "n" })).toBe("no");
  });

  it("supports comparisons, NOT, parentheses, and tag membership", () => {
    const text = "[t]\n\nt=cond((@rating >= 4 AND NOT @important) OR \"x\" in @tags, \"yes\", \"no\")";
    expect(html(text, { rating: 5 })).toBe("yes");
    expect(html(text, { rating: 5, important: true })).toBe("no");
    expect(html(text, { tags: ["x"] })).toBe("yes");
    expect(html("[t]\n\nt=cond(@duration > 1h30m, \"long\", \"short\")", { duration: 100 })).toBe("long");
    expect(html("[t]\n\nt=cond(\"[title]\" == \"Alien\", \"yes\")")).toBe("yes");
  });

  it("rejects mixing AND and OR without parentheses", () => {
    expect(errors("[t]\n\nt=cond(@a AND @b OR @c, \"x\")").join("\n")).toMatch(/mixing AND and OR/);
  });

  it("matches strings, globs, alternatives, and todo values", () => {
    const text = "[t]\n\nt=match \"[todo:str]\":\n  \"done\" => \"D\".\n  \"skip\"*, \"cancelled\" => \"S\".\n  else => \"-\".\nend";
    expect(html(text, { todo: "done" })).toBe("D");
    expect(html(text, { todo: "skipped" })).toBe("S");
    expect(html(text, { todo: "cancelled" })).toBe("S");
    expect(html(text)).toBe("-");
    const typed = "[t]\n\nt=match @todo: done => \"D\". unchecked => \"U\". end";
    expect(html(typed)).toBe("U");
    expect(html(typed, { todo: "done" })).toBe("D");
  });

  it("joins non-empty values", () => {
    expect(html("[t]\n\nt=join(\" \u00b7 \", \"[notes]\", \"[imdb_id]\", \"[rating]\")", { notes: "n", rating: 2 }))
      .toBe("n \u00b7 2");
  });
});

describe("styles, wrap, and tooltip", () => {
  it("wraps styled text in fmt- spans", () => {
    expect(html("[title][x]\n\nx=style(+subdued): \" [notes]\" end", { notes: "n" }))
      .toBe('Alien<span class="fmt-subdued"> n</span>');
  });

  it("lets the permanent form leak out of a derived attribute", () => {
    expect(html("[x] [title]\n\nx=style(+bold) \"a\"")).toBe('<span class="fmt-bold">a Alien</span>');
  });

  it("restores styles after a scoped block", () => {
    expect(html("[x]\n\nx=style(+a): \"1\" style(+b) \"2\" end \"3\""))
      .toBe('<span class="fmt-a">1</span><span class="fmt-a fmt-b">2</span>3');
  });

  it("wraps the toplevel", () => {
    const text = [
      "[title]",
      "wrap as top:",
      "  match \"[todo:str]\":",
      "    \"done\" => style(+strikethrough) \"[top]\".",
      "    else => \"[top]\".",
      "  end",
      "end",
    ].join("\n");
    expect(html(text, { todo: "done" })).toBe('<span class="fmt-strikethrough">Alien</span>');
    expect(html(text)).toBe("Alien");
  });

  it("renders a plain-text tooltip", () => {
    expect(render("[title]\ntooltip: style(+bold): \"<b>[notes]</b>\" end end", { notes: "n" }).tooltip).toBe("n");
    expect(render("[title]").tooltip).toBeUndefined();
  });

  it("rejects a second wrap", () => {
    expect(errors("[title]\nwrap as a: \"\" end\nwrap as b: \"\" end")[0]).toMatch(/only one wrap/);
  });
});

describe("diagnostics", () => {
  it("reports unknown attributes and renders them as unset", () => {
    expect(errors("[nope]")).toEqual(["1:1: unknown attribute 'nope'"]);
    expect(html("a[nope/b]")).toBe("ab");
  });

  it("reports shadowing, @derived, cycles, bad variants, and type errors", () => {
    expect(errors("[x]\n\nnotes=\"\"\nx=\"\"")[0]).toMatch(/cannot shadow/);
    expect(errors("[x]\n\nx=cond(@y, \"a\")\ny=\"b\"")[0]).toMatch(/@y is a derived attribute/);
    expect(errors("[x]\n\nx=\"[y]\"\ny=\"[x]\"")).toHaveLength(2);
    expect(errors("[title:stars]")[0]).toMatch(/does not apply/);
    expect(errors("[x]\n\nx=cond(@rating == \"a\", \"b\")")[0]).toMatch(/cannot compare/);
    expect(errors("[x]\n\nx=match @todo: \"done\" => \"\". end")[0]).toMatch(/can never match/);
  });

  it("warns about [?bool] and reports positions", () => {
    const d = compileFormat("[x]\n\nx=cond([?important], \"a\")", S).diagnostics;
    expect(d).toHaveLength(1);
    expect(d[0].severity).toBe("warning");
    expect(d[0].pos).toEqual({ line: 3, col: 8 });
  });

  it("recovers after an error to report later ones", () => {
    const d = errors("[x][y]\n\nx=if\ny=\"[nope]\"");
    expect(d.length).toBeGreaterThanOrEqual(2);
  });
});

describe("FORMAT.md examples", () => {
  const movie = [
    "[title_dpy][duration_dpy][imdb_dpy][rt_dpy] [notes]",
    "",
    "title_dpy='<a target=_blank href=\"https://www.imdb.com/find/?q=[title:url]\">[title]</a>'",
    "imdb_logo=q<< ![IMDB](https://example.com/imdb.svg) >>",
    "imdb_dpy=",
    "  ifdef:",
    "    q( <a href=\"https://www.imdb.com/title/[imdb_id]/\">[imdb_logo]</a> )",
    "  else:",
    "    \"\"",
    "  end",
    "rt_logo=\"![rt](hash://8a85299eaf266e83c46a.png)\"",
    "rt_dpy=cond([?rotten], \" [rt_logo][rotten]%\", \"\")",
    "duration_dpy=\" ?[duration:short]\"",
  ].join("\n");

  it("has no diagnostics", () => {
    expect(errors(movie)).toEqual([]);
  });

  it("renders all parts when set", () => {
    expect(html(movie, { imdb_id: "tt1", rotten: 97, duration: 117, notes: "classic" })).toBe(
      '<a target=_blank href="https://www.imdb.com/find/?q=Alien">Alien</a> 1h57m' +
      '<a href="https://www.imdb.com/title/tt1/"><img src="https://example.com/imdb.svg" alt="IMDB"></a>' +
      ' <img src="blob:8a85299eaf266e83c46a.png" alt="rt">97% classic',
    );
  });

  it("drops unset parts", () => {
    expect(html(movie)).toBe('<a target=_blank href="https://www.imdb.com/find/?q=Alien">Alien</a> ');
  });
});

describe("convertLegacyFormat", () => {
  const convert = (fmt: string, macros?: Record<string, string>) => convertLegacyFormat(fmt, macros);
  const legacy = (fmt: string, attrs: Record<string, unknown>, macros?: Record<string, string>, title = "Alien") =>
    html(convert(fmt, macros), attrs, title);

  it("converts placeholders, modifiers, and escapes", () => {
    expect(convert("{title} - {rating:stars}")).toBe("[title] - [rating:stars]");
    expect(convert("{rating:fallback=N/A}")).toBe("[rating/N/A]");
    expect(convert("{{literal}} [x] ?[")).toBe("{literal} \\[x] \\?\\[");
    expect(convert("{duration:long}")).toBe("[duration]");
    expect(convert("")).toBe("[title]");
  });

  it("keeps Markdown links and images", () => {
    expect(convert("[IMDB](https://imdb.com/?q={title:url}) ![x](hash://a.png)"))
      .toBe("[IMDB](https://imdb.com/?q=[title:url]) ![x](hash://a.png)");
  });

  it("converts conditionals to ifdef definitions", () => {
    const fmt = "{title}{ ({duration})| (no duration)}";
    expect(errors(convert(fmt))).toEqual([]);
    expect(legacy(fmt, { duration: 90 })).toBe("Alien (1 hour 30 minutes)");
    expect(legacy(fmt, {})).toBe("Alien (no duration)");
  });

  it("converts ternaries to cond", () => {
    const fmt = "{title} {rating:?({rating:stars}):unrated}";
    expect(errors(convert(fmt))).toEqual([]);
    expect(legacy(fmt, { rating: 3 })).toBe("Alien (\u2605\u2605\u2605\u2606\u2606)");
    expect(legacy(fmt, {})).toBe("Alien unrated");
  });

  it("converts macros to definitions", () => {
    const macros = {
      imdb_dpy: "{imdb_id:? <b><i>{imdb_id}</i></b>![IMDB](https://example.com/imdb.svg):}",
      rt_dpy: "{rotten:? {rotten}% RT:}",
      duration_dpy: "{duration:? ({duration:short}):}",
    };
    const text = convert("{title}{duration_dpy}{imdb_dpy}{rt_dpy}", macros);
    expect(errors(text)).toEqual([]);
    expect(html(text, { imdb_id: "tt1", rotten: 74, duration: 148 })).toBe(
      'Alien (2h28m) <b><i>tt1</i></b><img src="https://example.com/imdb.svg" alt="IMDB"> 74% RT',
    );
    expect(html(text, {})).toBe("Alien");
  });

  it("converts the old movie list format", () => {
    const fmt = "{rating:stars} {title}{ ({duration:short})|}{ [{tags:upper}]|}";
    expect(errors(convert(fmt))).toEqual([]);
    expect(legacy(fmt, { rating: 5, duration: 148, tags: ["sci-fi"] })).toBe("\u2605\u2605\u2605\u2605\u2605 Alien (2h28m) [SCI-FI]");
    expect(legacy(fmt, {})).toBe(" Alien");
  });

  it("chooses a quote delimiter the content cannot close", () => {
    const fmt = "{ a ) b|x}";
    const text = convert(fmt);
    expect(errors(text)).toEqual([]);
    expect(text).toContain("ifdef: q<  a ) b > else");
  });
});

describe("record upgrades", () => {
  it("upgrades boards and lists, carrying board macros into list overrides", () => {
    const board = upgradeBoardRecord({ id: "b", format_string: "{title}{m}", macros: { m: "!" } });
    expect(board).toEqual({ id: "b", format: { version: 2, text: "[title][m]\n\nm=q( ! )" } });
    expect(upgradeBoardRecord(board)).toBe(board);
    expect(upgradeBoardRecord({ id: "b" })).toEqual({ id: "b", format: { version: 2, text: "[title]" } });
    const list = upgradeListRecord({ id: "l", format_string: "{m}" }, { m: "!" });
    expect(list).toEqual({ id: "l", format: { version: 2, text: "[m]\n\nm=q( ! )" } });
    expect(upgradeListRecord({ id: "l", format_string: null })).toEqual({ id: "l", format: null });
  });
});

describe("escapeFormatText", () => {
  it("round-trips brackets, quotes, and backslashes through a quoted string", () => {
    const alt = 'poster [2024] "final" \\ ?[x]';
    const text = `[img]\n\nimg="![${escapeFormatText(alt)}](hash://abc.png)"`;
    expect(errors(text)).toEqual([]);
    expect(html(text)).toBe(`<img src="blob:abc.png" alt="${alt.replace(/"/g, "&quot;")}">`);
  });
});
