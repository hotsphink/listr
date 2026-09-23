# Format strings for list items

The basic syntax is a single line:

    [attr] text [attr]

where `attr` is a list item attribute name (eg `title`) and `text` is literal
text. However, `[foo]` can also be a "derived attribute" defined on subsequent
lines.

The advanced format is a toplevel format string, a directives section, a blank
line, and a definitions section. The first line is the main format string, and
determines the main appearance.

## Examples

Say you have these attributes
- title
- notes
- imdb_id
- todo

You could define a complex format string like:

    [title_dpy][duration_dpy][imdb_dpy][rt_dpy] [notes]

    # define a keyword as a string. Strings are surrounded by quotes, which may
    # be single or double quotes, or see below.
    #
    # A limited set of HTML tags may be used, and strings may have embedded `[attr]`
    # replacements just like the toplevel string. These will be recursively expanded.
    #
    # `[attr:url]` URL-escapes the attribute.
    title_dpy='<a target=_blank href="https://www.imdb.com/find/?q=[title:url]">[title]</a>'

    # Strings may also be delimited by 'q' followed by any kind of open paren
    # (round, curly, square, angle, etc.) character or repeated sequence of
    # characters, then a space. The string will continue until a space followed
    # by the matching character(s) end it.
    #
    # A simple image link syntax is `![alt text](url)`.
    imdb_logo=q<< ![IMDB](https://www.svgrepo.com/show/349409/imdb.svg) >>

    # `ifdef: ...X... else: ...Y... end` means to use X as the replacement if all attributes
    # used directly in X are set, otherwise use Y instead. There is also the specifically
    # targeted version `if [?A,?B,?C]: ...X... else: ...Y... end` that specifies the exact attributes
    # to check.
    imdb_dpy=
      ifdef:
        q( <a target=_blank href="https://www.imdb.com/title/[imdb_id]/">[imdb_logo]</a> )
      else:
        ""
      end

    # Images can be uploaded and then linked to by their content hash.
    # This will be converted into a blob:... URL with the image data.
    rt_logo="![rotten-tomatoes-logo](hash://8a85299eaf266e83c46a.png)"

    # Ternaries `cond([?attr], yes-expr, no-expr)` are equivalent to
    # `if [?attr]: yes-expr else: no-expr end`
    rt_dpy=cond([?rotten], " [rt_logo][rotten]%", "")

    # Some attribute types are associated with different format syntaxes. A duration's
    # default format is something like "1 hour 26 minutes", `[duration:short]` will give "1h26m".
    #
    # `[attr:format/fallback]` or just `[attr/fallback]` is equivalent to
    # `ifdef: [attr:format] else: "fallback" end`.
    #
    # A space followed by ?[...] will suppress the space if the following [...]
    # expression resolves to the empty string.
    duration_dpy=" ?[duration:short]"

Each region of text output can also have associated styles. Styles are a set of
tokens that derive from CSS class names defined in
packages/client/src/styles/format.css, with the leading "fmt-" prefix stripped:
`subdued`, `bold`, `italic`, `underline`, `strikethrough`, `cancelled`, `code`,
`accent`, `warn`, and `small`. The formatting language does not (currently)
validate these names, so a misspelled style silently does nothing.

    [title][extra]

    extra=if [?notes]:
      # Comments are allowed outside of strings.
      #
      # Add the "subdued" style, remove the "bold" style.
      style(+subdued,-bold)
      " ([notes])"
      style(-subdued)
    else:
      ""
    end

The set of styles will be applied to all following text until the set of styles
is changed. `style: ... end` delimits a region where styles may be modified and
then restored, so a better version of the above is:

    [title][extra]

    extra=if [?notes]:
      style(+subdued,-bold):
        " ([notes])"
      end
    else:
      ""
    end

Wrapping can be used to set styles:

    [title]
    wrap as top:
      if @important:
        style(+bold):
          "!! [top] !!"
        end
      else:
        "[top]"
      end
    end

A match statement allows different styling depending on the value of an attribute:

    [title][notes_dpy]
    wrap as top:
      match "[todo:str]":
        "done" => style(+strikethrough) "[top]".
        "cancelled" => style(+cancelled) "[top]".
        "skip"* => style(+subdued) "([top])".
        else => "[top]".
      end
    end

    notes_dpy=cond([?notes], " ([notes])")

## Processing Model

The format string is parsed and converted into a sequence of ranges of text
with associated styles. The default set of styles is the empty set. Style
`name` maps to the CSS class name `fmt-name`. Each range becomes a `<span>`
with those classes. A style change inside an open literal HTML tag (eg between
`<a ...>` and `</a>`) produces tags that do not nest, and the result is
undefined.

The output is then sanitized. Only the tags listed below survive, with the
attributes `href`, `src`, `alt`, `target`, `rel`, and `class`. Classes that do
not start with `fmt-` are removed. URLs must use `http`, `https`, or `blob`
(`data` is also allowed for images). Links with a `target` get
`rel="noopener noreferrer"`.

Unknown attributes display an error when viewing or editing the format
string. At display time, they are treated as unset.

Shadowing is disallowed: you cannot create a derived attribute with the same
name as a builtin or schema attribute. Doing so will show an edit-time error
and be ignored at display time.

## Reference

### Toplevel (first line)

* `...text...` - most text is used verbatim
  * HTML is allowed, but with very limited tags defined in
    packages/client/src/components/FormattedText.tsx: "b", "i", "em", "strong",
    "u", "s", "span", "img", "a". Attribute values are always HTML-escaped.
    See "Processing Model" for the allowed attributes and URL schemes.
  * `\[` - literal open bracket. Quotes and parentheses can also be
    backslash-escaped, regardless of the surrounding quote style.
* `[name]` - default string form of an attribute named `name`
* `[name:variant]` - string form variant, some are type-specific
  * `:str` - plain string, no icons or anything. Durations use `:short` (see
    below), dates use ISO 8601, booleans are `true` or `false`, and todos are
    their state name (`unchecked`, `done`, `cancelled`, `skipped`).
  * `:url` - escapes special characters.
  * `:upper` - uppercase.
  * `:lower` - lowercase.
  * `<Numeric>:stars` - display as this many stars.
  * `<Duration>:short` - attributes with type `Duration` have a short form (eg
    "2h5m"). Dates have a short form too (eg "Sep 23").
  * An unknown variant, or one that does not apply to the attribute's type, is
    an error.
* `[name/fallback]` - like `[name]` if `name` is set, else `fallback` (expanded)
* ` ?[name]` - conditional space: if the `[...]` resolves to the empty string,
  suppress a single space. A backslash (`\?`) will suppress this special meaning.
* ` ?[name:variant/fallback]` - all of the above combined
* `[link text](url)` - HTML link, where the link text is processed first. Note
  that `[name](...)` is always a link, never an attribute name lookup. That can
  be achieved with `[name]\(...)`.
* `![alt text](url)` - image
  * the url can have a `hash` scheme, eg `hash://8a85299eaf266e83c46a.png` that
    will be rewritten to a `blob:...` url (using the extension to set the
    mime-type) by looking it up in a globally shared DB created from uploads.

### Directives (remaining lines before blank outside of a block)

A line of the form `name=...` directly after the toplevel line also ends the
directives and starts the definitions, even without a blank line.

* `wrap as name: ... end`

Overwrite the toplevel format string given in the first line. Specifically,
`name` is bound to the current toplevel format string, and the toplevel is set
to the value in the body. Multiple `wrap` expressions are an error.

This is used to do conditional wrapping, eg to surround the string in
parentheses or change its style if an attribute is present or set to some
specific value.

Useless example: `wrap as top: "[top][top]" end` would double up whatever would
otherwise be used as the formatted output.

* `tooltip: EXPRESSION end` - set the tooltip. This is plain text, with any
  styles ignored.

* `behavior: ... end` - future feature.

### Definitions (section after blank line outside block)

`name=EXPRESSION` - set the value of a derived attribute. If EXPRESSION is the
empty string (so the line ends with `=`), then use the whitespace at the
beginning of the following line as the amount to dedent it and following lines,
ending the expression at the first line that is less indented. A zero-width
indent ends itself immediately and produces the empty string as an expression.

Otherwise, `EXPRESSION` ends at the end of the first line it is syntactically
complete.

#### Values

This document tests for truthy values in some places, and whether a property is
set in others. The definition of unset is: `undefined`, `null`, `""`, `[]`, or
`NaN`. Everything else is set, including `0` and `false`.

#### Expressions

* `# comment` - comments are allowed anywhere but the first line.

* `"...text..."` or `'...text...'` - text, interpreted the same way as the
  toplevel line.

* `q( ...text... )`, `q< ...text... >`, `q{{ ...text... }}` - flexible quote
  text, where the `q` is followed by one or more identical bracket characters
  followed by a space, then the text, then a closing space, and the matched
  ending bracket characters. Unmatched characters can be used as well:
  `q/ ...text... /`. A single whitespace character is stripped from the
  beginning and end.

* `v( ...text... )` - flexible quoting again, but this is for verbatim text
  that is not processed further by the formatting engine (but HTML may be used
  and is not escaped but is still sanitized).

* `if CONDITION: ... end` - conditional text, see "Conditions" below for what
  condition to use. But it's probably gonna be `[?name]` to test whether an
  attribute is set.

* `if CONDITION: ... else: ... end` - conditional text with a false case.

* `cond(CONDITION, true-expr, false-expr)` - ternary

* `cond(CONDITION, true-expr)` - ternary with the empty string for the
  false-expr case.

* `ifdef: ...body... else: ...alternative... end` - if all attributes used in
  `body` are set, then use the `body`, otherwise fall back to `alternative`.
  "Used" means referenced as `[name]` directly in the body's strings, not
  inside a nested `if`, `match`, or `join`. References that carry their own
  fallback (`[name/...]`) or conditional space (` ?[name]`) are not checked.

* `match expr: case1 => ...text1... . case2 => ...text2... . end` - match
  expression. The cases are typed values whose type must match the match
  expression. Literal strings used as cases are not expanded (so quotes become
  verbatim even without v( ... )). A prefix or suffix (only) of `*` changes it
  to a glob match (eg `*"foo"` or `"foo"*`). The keyword `else` gives the
  fallback case. Note that each case body is terminated with a period. Match
  arms can also be a `case1,case2` list of alternatives.

* `join(SEPARATOR, EXPR1, EXPR2, ...)` - join the expressions together.
  SEPARATOR is expanded. Empty or whitespace-only values are dropped.

* `style(+name,...,-name,...): ...body... end` - create a scope for `body`
  where the given style names are added or removed from the current set, then
  restored at the end of the scope.

* `style(+name,...,-name,...)` - update the current set of styles being applied
  (note the lack of `:`). This is a permanent update and can leak out into
  containing expressions. The other form should be used if a limited scope is
  desired.

* `EXPRESSION EXPRESSION` - adjacent expression values are concatenated.

#### Conditions

* `@name` - test if the `name` attribute is truthy (non-empty, nonzero for a
  numeric direct attribute, non-false for a boolean). Unknown attributes are an
  error at edit-time, false as runtime. Attributes that aren't set to any value
  return false. The test is type-specific. Note that `@name` in a comparison
  resolves to the raw value; the truthiness test is only when used alone.
  `@derived` is an error.

* `[?name]` - test if the `name` attribute is set. For a derived attribute,
  this tests whether it renders as a non-empty string. Unknown attributes are
  an error at edit-time, false as runtime. Booleans are always set, so
  `[?flag]` gives a warning suggesting `@flag`.

* `[?name1,?name2,?name3]` - true only if all listed attributes are set.
  Equivalent to `[?name1] AND [?name2] AND [?name3]`.

* `EXPRESSION == EXPRESSION`, also `!=`, comparison operators like `<`,
  conjunctions like `AND` and `OR` (case insensitive). `NOT` as well, with high
  precedence. These use raw typed values, so eg `@name == "Bob"` and `@important
  == true` and `"[name]" == "Bob"`, not `[name] == "Bob"`. `@name` is the raw
  typed value; `"[name]"` is converted to a string. `AND`/`OR` have equal
  precedence and mixing them is an error.

* `(EXPRESSION)` - parentheses may be used for grouping ambiguous cases, eg
  `@a AND @b OR @c`.

* `"x" in @tags` - tag set membership. Also works as a substring test on text.

* `true`, `false` - constant conditions.

#### Literals

* `"..."`, `'...'`, `q( ... )`, `v( ... )` for strings.
* `10`, `-10.2` for numbers.
* `true`, `false` for booleans.
* `unchecked`, `done`, `cancelled`, `skipped` for todos.
* `1h3m`, `2h`, `90m` for durations. Also allow bare numbers, and interpret as
  minutes.
* There are no literals for dates.

## Overrides

Formats will normally be defined at a board level, though individual lists can
override. A list format always replaces the board's toplevel line. It inherits
all of the board's directives and definitions. Its own definitions add to them
or replace board definitions with the same name, and its own `wrap` or `tooltip`
replaces the board's.

Diagnostics for a list format cover only the list's own text. Changing or
removing a board definition that a list format uses can break the list format,
and that shows up only when viewing or editing the list format.

## Migration

* This is a flag day migration from previously defined format strings.

* Boards store the whole format as `format: { version: 2, text }`, and lists
  store an override in the same shape, or `null` to use the board's format.
  The old `format_string` and `macros` fields are gone. (Version 1 is the
  legacy `{...}` syntax.)

* This is a PROTOCOL_VERSION bump (to 6) and a Dexie upgrade (to version 6).
  The server converts its stored boards and lists in its migration 7. Both
  sides use the same converter (`convertLegacyFormat` in packages/shared) and
  leave `updated_at` alone, so they agree without resyncing. Imported export
  files that still use the old fields are converted the same way.

* The converter translates `{key}`, `{key:modifier}`, and
  `{key:fallback=X}` to `[key]`, `[key:modifier]`, and `[key/X]`.
  Conditionals `{body|fallback}` become `ifdef` definitions and ternaries
  `{key:?yes:no}` become `cond` definitions, named `legacy_1`, `legacy_2`,
  and so on. Macros become definitions. A literal `[` that is not part of a
  Markdown link is escaped. A list override replaced only the first line, which
  still matches, and it inherits the board's converted macros. Definitions
  generated for a list override are named `legacy_list_1`, `legacy_list_2`,
  and so on, so they do not replace the board's.

## Implementation Notes

* The language lives in packages/shared/src/format: `parser.ts` (with error
  recovery, so the editor can report every error with its line and column),
  `check.ts` (static checks against the schema), `evaluate.ts`, and
  `values.ts` (set, truthy, rendering, and comparison for each type).

* Rendering sanitizes with DOMPurify only (see "Processing Model").

* Recursive expansion is detected and results in an error.

* doc-examples.test.ts compiles every multi-line example in this document.
