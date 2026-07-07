import { describe, it, expect } from "vitest";
import { parseFormatString, renderFormatString, renderFormatStringHtml, parseAdvancedFormatText } from "./format-string.js";
import type { AttributeDefinition, Item, List } from "./types.js";

function makeItem(title: string, attrs: Record<string, unknown> = {}): Item {
  return {
    id: "test-id",
    list_id: "test-list",
    title,
    after_id: null,
    created_at: Date.now(),
    updated_at: Date.now(),
    attributes: attrs,
  };
}

describe("parseFormatString", () => {
  it("parses plain text", () => {
    const segments = parseFormatString("hello world");
    expect(segments).toEqual([{ kind: "literal", text: "hello world" }]);
  });

  it("parses a single placeholder", () => {
    const segments = parseFormatString("{title}");
    expect(segments).toEqual([{ kind: "placeholder", key: "title", modifier: undefined, modifierArg: undefined }]);
  });

  it("parses placeholder with modifier", () => {
    const segments = parseFormatString("{title:upper}");
    expect(segments).toEqual([{ kind: "placeholder", key: "title", modifier: "upper", modifierArg: undefined }]);
  });

  it("parses placeholder with modifier and arg", () => {
    const segments = parseFormatString("{rating:fallback=N/A}");
    expect(segments).toEqual([{ kind: "placeholder", key: "rating", modifier: "fallback", modifierArg: "N/A" }]);
  });

  it("parses mixed literal and placeholders", () => {
    const segments = parseFormatString("{rating} - {title}");
    expect(segments).toHaveLength(3);
    expect(segments[0]).toEqual({ kind: "placeholder", key: "rating", modifier: undefined, modifierArg: undefined });
    expect(segments[1]).toEqual({ kind: "literal", text: " - " });
    expect(segments[2]).toEqual({ kind: "placeholder", key: "title", modifier: undefined, modifierArg: undefined });
  });

  it("parses escaped braces", () => {
    const segments = parseFormatString("{{literal}}");
    expect(segments).toEqual([{ kind: "literal", text: "{literal}" }]);
  });

  it("parses conditional sections", () => {
    const segments = parseFormatString("{ ({duration})|}");
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("conditional");
  });
});

describe("renderFormatString", () => {
  it("renders title only", () => {
    const item = makeItem("Inception");
    expect(renderFormatString("{title}", item)).toBe("Inception");
  });

  it("renders mixed format", () => {
    const item = makeItem("Inception", { rating: 4.5, duration: 148 });
    expect(renderFormatString("{rating} - {title}", item)).toBe("4.5 - Inception");
  });

  it("renders empty for missing top-level placeholder", () => {
    const item = makeItem("Inception", {});
    expect(renderFormatString("{rating} - {title}", item)).toBe(" - Inception");
  });

  it("applies upper modifier", () => {
    const item = makeItem("Inception");
    expect(renderFormatString("{title:upper}", item)).toBe("INCEPTION");
  });

  it("applies lower modifier", () => {
    const item = makeItem("INCEPTION");
    expect(renderFormatString("{title:lower}", item)).toBe("inception");
  });

  it("applies url modifier to encode for use in URLs", () => {
    const item = makeItem("Edward Scissorhands");
    expect(renderFormatString("{title:url}", item)).toBe("Edward%20Scissorhands");
  });

  it("applies url modifier in a markdown link URL", () => {
    const item = makeItem("Edward Scissorhands");
    const result = renderFormatStringHtml("[IMDB](https://www.imdb.com/find/?q={title:url})", item);
    expect(result).toBe('<a href="https://www.imdb.com/find/?q=Edward%20Scissorhands">IMDB</a>');
  });

  it("applies fallback modifier for missing values", () => {
    const item = makeItem("Inception", {});
    expect(renderFormatString("{rating:fallback=N/A} - {title}", item)).toBe("N/A - Inception");
  });

  it("applies stars modifier", () => {
    const item = makeItem("Inception", { rating: 4 });
    expect(renderFormatString("{rating:stars}", item)).toBe("★★★★☆");
  });

  it("renders conditional section when value present", () => {
    const item = makeItem("Inception", { duration: 148 });
    const result = renderFormatString("{title}{ ({duration})| }", item);
    expect(result).toBe("Inception (148)");
  });

  it("renders conditional fallback when value missing", () => {
    const item = makeItem("Inception", {});
    const result = renderFormatString("{title}{ ({duration})| }", item);
    expect(result).toBe("Inception ");
  });

  it("renders conditional with empty fallback", () => {
    const item = makeItem("Inception", {});
    const result = renderFormatString("{title}{ ({duration})|}",item);
    expect(result).toBe("Inception");
  });

  it("applies short modifier to duration", () => {
    const item = makeItem("Inception", { duration: 148 });
    expect(renderFormatString("{duration:short}", item)).toBe("2h28m");
  });

  it("applies long modifier to duration", () => {
    const item = makeItem("Inception", { duration: 148 });
    expect(renderFormatString("{duration:long}", item)).toBe("2 hours 28 minutes");
  });

  it("handles escaped braces", () => {
    const item = makeItem("Test");
    expect(renderFormatString("{{hello}} {title}", item)).toBe("{hello} Test");
  });

  it("handles boolean values", () => {
    const item = makeItem("Test", { watched: true });
    expect(renderFormatString("{watched}", item)).toBe("yes");
  });

  it("renders unset boolean as 'no' when schema is provided", () => {
    const schema: AttributeDefinition[] = [
      { key: "watched", label: "Watched", type: "boolean", required: false, position: 0 },
    ];
    const item = makeItem("Test", {});
    expect(renderFormatString("{title} [{watched}]", item, schema)).toBe("Test [no]");
  });

  it("handles array values", () => {
    const item = makeItem("Test", { tags: ["action", "sci-fi"] });
    expect(renderFormatString("{tags}", item)).toBe("action, sci-fi");
  });

  it("supports custom modifiers", () => {
    const item = makeItem("Test", { name: "hello" });
    const customModifiers = {
      reverse: (v: unknown) => String(v).split("").reverse().join(""),
    };
    expect(renderFormatString("{name:reverse}", item, undefined, customModifiers)).toBe("olleh");
  });
});

describe("custom attribute in display", () => {
  function makeBoard(schema: AttributeDefinition[], formatString: string) {
    return { schema, format_string: formatString };
  }

  it("renders a movie list with rating, title, and conditional duration", () => {
    const schema: AttributeDefinition[] = [
      { key: "rating", label: "Rating", type: "number", required: false, position: 0 },
      { key: "duration", label: "Duration", type: "duration", required: false, position: 1 },
      { key: "genre", label: "Genre", type: "enum", required: false, options: ["action", "sci-fi", "drama"], position: 2 },
    ];
    const cat = makeBoard(schema, "{rating:stars} {title}{ ({duration:short})|}{ [{genre:upper}]|}");

    const inception = makeItem("Inception", { rating: 5, duration: 148, genre: "sci-fi" });
    expect(renderFormatString(cat.format_string, inception, cat.schema))
      .toBe("★★★★★ Inception (2h28m) [SCI-FI]");

    const noGenre = makeItem("Memento", { rating: 4, duration: 113 });
    expect(renderFormatString(cat.format_string, noGenre, cat.schema))
      .toBe("★★★★☆ Memento (1h53m)");

    const titleOnly = makeItem("TBD", {});
    expect(renderFormatString(cat.format_string, titleOnly, cat.schema))
      .toBe(" TBD");
  });

  it("renders custom text attributes in format string", () => {
    const schema: AttributeDefinition[] = [
      { key: "director", label: "Director", type: "text", required: false, position: 0 },
      { key: "year", label: "Year", type: "number", required: false, position: 1 },
    ];
    const cat = makeBoard(schema, "{title} ({year}){ - dir. {director}|}");

    const item = makeItem("Blade Runner", { director: "Ridley Scott", year: 1982 });
    expect(renderFormatString(cat.format_string, item, cat.schema))
      .toBe("Blade Runner (1982) - dir. Ridley Scott");

    const noDirector = makeItem("Blade Runner", { year: 1982 });
    expect(renderFormatString(cat.format_string, noDirector, cat.schema))
      .toBe("Blade Runner (1982)");
  });

  it("renders tags attribute", () => {
    const schema: AttributeDefinition[] = [
      { key: "tags", label: "Tags", type: "tags", required: false, options: ["must-see", "classic", "rewatchable"], position: 0 },
    ];
    const cat = makeBoard(schema, "{title}{ - {tags}|}");

    const item = makeItem("The Matrix", { tags: ["must-see", "classic"] });
    expect(renderFormatString(cat.format_string, item, cat.schema))
      .toBe("The Matrix - must-see, classic");
  });

  it("renders boolean watched status with fallback", () => {
    const schema: AttributeDefinition[] = [
      { key: "watched", label: "Watched", type: "boolean", required: false, position: 0 },
    ];
    const cat = makeBoard(schema, "{title} [{watched:fallback=unwatched}]");

    const watched = makeItem("Inception", { watched: true });
    expect(renderFormatString(cat.format_string, watched, cat.schema))
      .toBe("Inception [yes]");

    const notSet = makeItem("Tenet", {});
    expect(renderFormatString(cat.format_string, notSet, cat.schema))
      .toBe("Tenet [no]");
  });
});

describe("ternary format syntax", () => {
  function makeList(schema: AttributeDefinition[], formatString: string): List {
    return {
      id: "list-1",
      board_id: "test-board",
      name: "Test",
      icon: "",
      position: 0,
      format_string: formatString,
      view_mode: "list",
      schema,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
  }

  const boolSchema: AttributeDefinition[] = [
    { key: "watched", label: "Watched", type: "boolean", required: false, position: 0 },
  ];

  it("renders true branch when value is truthy", () => {
    const item = makeItem("Inception", { watched: true });
    expect(renderFormatString("{title} - {watched:?Watched:Not yet watched}", item, boolSchema))
      .toBe("Inception - Watched");
  });

  it("renders false branch when value is falsy", () => {
    const item = makeItem("Inception", { watched: false });
    expect(renderFormatString("{title} - {watched:?Watched:Not yet watched}", item, boolSchema))
      .toBe("Inception - Not yet watched");
  });

  it("renders false branch for unset boolean", () => {
    const item = makeItem("Inception", {});
    expect(renderFormatString("{title} - {watched:?Watched:Not yet watched}", item, boolSchema))
      .toBe("Inception - Not yet watched");
  });

  it("supports nested placeholders in branches", () => {
    const schema: AttributeDefinition[] = [
      { key: "watched", label: "Watched", type: "boolean", required: false, position: 0 },
      { key: "year", label: "Year", type: "number", required: false, position: 1 },
    ];
    const item = makeItem("Inception", { watched: true, year: 2010 });
    expect(renderFormatString("{watched:?Watched in {year}:Unwatched}", item, schema))
      .toBe("Watched in 2010");
  });

  it("supports nested placeholders in false branch", () => {
    const schema: AttributeDefinition[] = [
      { key: "watched", label: "Watched", type: "boolean", required: false, position: 0 },
      { key: "year", label: "Year", type: "number", required: false, position: 1 },
    ];
    const item = makeItem("Inception", { watched: false, year: 2010 });
    expect(renderFormatString("{watched:?Seen it:Released {year}, not watched}", item, schema))
      .toBe("Released 2010, not watched");
  });

  it("works with non-boolean truthy values", () => {
    const schema: AttributeDefinition[] = [
      { key: "rating", label: "Rating", type: "number", required: false, position: 0 },
    ];
    const rated = makeItem("Inception", { rating: 5 });
    expect(renderFormatString("{title} {rating:?({rating:stars}):unrated}", rated, schema))
      .toBe("Inception (★★★★★)");

    const unrated = makeItem("TBD", {});
    expect(renderFormatString("{title} {rating:?({rating:stars}):unrated}", unrated, schema))
      .toBe("TBD unrated");
  });

  it("handles empty true branch", () => {
    const item = makeItem("Test", { watched: true });
    expect(renderFormatString("{title}{watched:?:, not watched}", item, boolSchema))
      .toBe("Test");
  });

  it("handles empty false branch", () => {
    const item = makeItem("Test", { watched: false });
    expect(renderFormatString("{title}{watched:? (seen):}", item, boolSchema))
      .toBe("Test");

    const seen = makeItem("Test", { watched: true });
    expect(renderFormatString("{title}{watched:? (seen):}", seen, boolSchema))
      .toBe("Test (seen)");
  });

  it("works inside conditional sections", () => {
    const schema: AttributeDefinition[] = [
      { key: "watched", label: "Watched", type: "boolean", required: false, position: 0 },
      { key: "year", label: "Year", type: "number", required: false, position: 1 },
    ];
    const item = makeItem("Inception", { watched: true, year: 2010 });
    expect(renderFormatString("{title}{ ({year}) {watched:?Seen:Unseen}|}", item, schema))
      .toBe("Inception (2010) Seen");

    const noYear = makeItem("TBD", { watched: false });
    expect(renderFormatString("{title}{ ({year}) {watched:?Seen:Unseen}|}", noYear, schema))
      .toBe("TBD");
  });
});

describe("image syntax", () => {
  it("parses image segment", () => {
    const segments = parseFormatString("![Logo](https://example.com/logo.png)");
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe("image");
  });

  it("renders image as <img> in html mode", () => {
    const item = makeItem("Test");
    expect(renderFormatStringHtml("![Logo](https://example.com/logo.png)", item))
      .toBe('<img src="https://example.com/logo.png" alt="Logo">');
  });

  it("renders image as alt text in plain mode", () => {
    const item = makeItem("Test");
    expect(renderFormatString("![Logo](https://example.com/logo.png)", item))
      .toBe("Logo");
  });

  it("renders image with placeholder in alt", () => {
    const item = makeItem("Inception");
    expect(renderFormatStringHtml("![{title}](https://example.com/logo.png)", item))
      .toBe('<img src="https://example.com/logo.png" alt="Inception">');
  });

  it("renders image with placeholder in url", () => {
    const item = makeItem("Test", { img: "https://example.com/pic.jpg" });
    expect(renderFormatStringHtml("![Logo]({img})", item))
      .toBe('<img src="https://example.com/pic.jpg" alt="Logo">');
  });

  it("html-escapes placeholder values in alt and url", () => {
    const item = makeItem("A & B", { img: "https://x.com/?a=1&b=2" });
    expect(renderFormatStringHtml("![{title}]({img})", item))
      .toBe('<img src="https://x.com/?a=1&amp;b=2" alt="A &amp; B">');
  });

  it("renders image inside ternary true branch", () => {
    const item = makeItem("Test", { imdb: "tt1234567" });
    expect(renderFormatStringHtml("{imdb:? ![IMDB](https://example.com/imdb.svg):}", item))
      .toBe(' <img src="https://example.com/imdb.svg" alt="IMDB">');
  });

  it("renders nothing for ternary false branch when imdb unset", () => {
    const item = makeItem("Test", {});
    expect(renderFormatStringHtml("{imdb:? ![IMDB](https://example.com/imdb.svg):}", item))
      .toBe('');
  });

  it("renders image inside macro ternary (user scenario)", () => {
    const item = makeItem("Inception", { imdb: "tt1375666" });
    const macros = {
      imdb_dpy: "{imdb:? <b><i>{imdb}</i></b>![IMDB](https://example.com/imdb.svg):}",
    };
    expect(renderFormatStringHtml("{title}{imdb_dpy}", item, undefined, undefined, macros))
      .toBe('Inception <b><i>tt1375666</i></b><img src="https://example.com/imdb.svg" alt="IMDB">');
  });

  it("renders exact user format string via parseAdvancedFormatText", () => {
    const advText = [
      "{title}{duration_dpy}{imdb_dpy}{rt_dpy}",
      "imdb_dpy={imdb:? <b><i>{imdb}</i></b>![IMDB](https://www.svgrepo.com/show/349409/imdb.svg):}",
      "rt_dpy={rotten:? {rotten}% RT:}",
      "duration_dpy={duration:? ({duration:short}):}",
    ].join("\n");

    const { format, macros, error } = parseAdvancedFormatText(advText);
    expect(error).toBeNull();

    const item = makeItem("Inception", { imdb: "tt1375666", rotten: 74, duration: 148 });
    const result = renderFormatStringHtml(format, item, undefined, undefined, macros);
    expect(result).toContain('<img src="https://www.svgrepo.com/show/349409/imdb.svg" alt="IMDB">');
    expect(result).toContain('<b><i>tt1375666</i></b>');
    expect(result).toContain('(2h28m)');
    expect(result).toContain('74% RT');
  });
});

describe("links in format strings", () => {
  const item = makeItem("Test");

  it("renders markdown link as <a> in HTML mode", () => {
    const result = renderFormatStringHtml("[IMDB](https://imdb.com)", item);
    expect(result).toBe('<a href="https://imdb.com">IMDB</a>');
  });

  it("renders markdown link with placeholder in text", () => {
    const result = renderFormatStringHtml("[{title}](https://example.com)", item);
    expect(result).toBe('<a href="https://example.com">Test</a>');
  });

  it("leaves markdown link as-is in plain text mode", () => {
    const result = renderFormatString("[IMDB](https://imdb.com)", item);
    expect(result).toBe("[IMDB](https://imdb.com)");
  });

  it("passes through <a> tag written directly in format string", () => {
    const result = renderFormatStringHtml('<a href="https://imdb.com">IMDB</a>', item);
    expect(result).toBe('<a href="https://imdb.com">IMDB</a>');
  });

  it("escapes double quotes in markdown link URL", () => {
    const result = renderFormatStringHtml('[x](https://example.com/q?a="b")', item);
    expect(result).toContain('href="https://example.com/q?a=&quot;b&quot;"');
  });

  it("renders markdown link mixed with other content", () => {
    const result = renderFormatStringHtml("{title} — [details](https://example.com)", item);
    expect(result).toBe('Test — <a href="https://example.com">details</a>');
  });
});
