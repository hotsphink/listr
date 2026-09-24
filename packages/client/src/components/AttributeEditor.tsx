import { type Component, Switch, Match, For, createSignal } from "solid-js";
import { formatDurationShort, parseDurationText, type AttributeDefinition } from "@listr/shared";

interface Props {
  definition: AttributeDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
  /**
   * id for the control a caller's <label for> points at. Types drawn as a
   * single control take it directly; duration and tags are several controls, so
   * they are grouped and named by labelledBy instead.
   */
  id?: string;
  /** id of the element naming this field, for the multi-control types. */
  labelledBy?: string;
  /** Shown while the field is empty, for the types that can show one. See showsPlaceholder. */
  placeholder?: string;
}

/** Whether an attribute type's control can show a placeholder in place of an empty value. */
export function showsPlaceholder(type: AttributeDefinition["type"]): boolean {
  return ["text", "url", "number", "integer", "duration", "enum"].includes(type);
}

const AttributeEditor: Component<Props> = (props) => {
  return (
    <Switch fallback={<TextInput id={props.id} value={props.value} onChange={props.onChange} />}>
      <Match when={props.definition.type === "text"}>
        <TextInput id={props.id} value={props.value} onChange={props.onChange} placeholder={props.placeholder} />
      </Match>
      <Match when={props.definition.type === "number"}>
        <NumberInput id={props.id} value={props.value} onChange={props.onChange} placeholder={props.placeholder} />
      </Match>
      <Match when={props.definition.type === "integer"}>
        <IntegerInput id={props.id} value={props.value} onChange={props.onChange} config={props.definition.config} placeholder={props.placeholder} />
      </Match>
      <Match when={props.definition.type === "boolean"}>
        <BooleanInput id={props.id} value={props.value} onChange={props.onChange} />
      </Match>
      <Match when={props.definition.type === "date"}>
        <DateInput id={props.id} value={props.value} onChange={props.onChange} />
      </Match>
      <Match when={props.definition.type === "datetime"}>
        <DateInput id={props.id} value={props.value} onChange={props.onChange} showTime />
      </Match>
      <Match when={props.definition.type === "enum"}>
        <EnumInput id={props.id} value={props.value} onChange={props.onChange} options={props.definition.options ?? []} placeholder={props.placeholder} />
      </Match>
      <Match when={props.definition.type === "tags"}>
        <TagsInput labelledBy={props.labelledBy} value={props.value} onChange={props.onChange} options={props.definition.options ?? []} />
      </Match>
      <Match when={props.definition.type === "url"}>
        <TextInput id={props.id} value={props.value} onChange={props.onChange} type="url" placeholder={props.placeholder} />
      </Match>
      <Match when={props.definition.type === "duration"}>
        <DurationInput labelledBy={props.labelledBy} value={props.value} onChange={props.onChange} placeholder={props.placeholder} />
      </Match>
      <Match when={props.definition.type === "todo"}>
        <TodoInput id={props.id} value={props.value} onChange={props.onChange} />
      </Match>
    </Switch>
  );
};

const TextInput: Component<{ value: unknown; onChange: (v: unknown) => void; type?: string; id?: string; placeholder?: string }> = (props) => (
  <input
    id={props.id}
    type={props.type ?? "text"}
    placeholder={props.placeholder}
    value={String(props.value ?? "")}
    onInput={(e) => props.onChange(e.currentTarget.value)}
  />
);

/**
 * Parse a decimal typed into a text field. Returns NaN for empty input and
 * null for text that is not a number.
 */
export function parseDecimal(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return NaN;
  const v = Number(trimmed);
  return Number.isFinite(v) ? v : null;
}

// A text field rather than type="number": up/down steppers make no sense for
// arbitrary decimals.
const NumberInput: Component<{ value: unknown; onChange: (v: unknown) => void; id?: string; placeholder?: string }> = (props) => (
  <input
    id={props.id}
    inputmode="decimal"
    placeholder={props.placeholder}
    value={props.value != null ? String(props.value) : ""}
    onBlur={(e) => {
      const v = parseDecimal(e.currentTarget.value);
      if (v !== null) props.onChange(Number.isNaN(v) ? null : v);
      else e.currentTarget.value = props.value != null ? String(props.value) : "";
    }}
  />
);

const IntegerInput: Component<{ value: unknown; onChange: (v: unknown) => void; config?: Record<string, unknown>; id?: string; placeholder?: string }> = (props) => (
  <input
    id={props.id}
    type="number"
    step="1"
    placeholder={props.placeholder}
    value={props.value != null ? Number(props.value) : ""}
    min={props.config?.min as number | undefined}
    max={props.config?.max as number | undefined}
    onBlur={(e) => {
      const v = e.currentTarget.valueAsNumber;
      props.onChange(Number.isNaN(v) ? null : Math.round(v));
    }}
  />
);

const BooleanInput: Component<{ value: unknown; onChange: (v: unknown) => void; id?: string }> = (props) => (
  <input
    id={props.id}
    type="checkbox"
    checked={Boolean(props.value)}
    onChange={(e) => props.onChange(e.currentTarget.checked)}
  />
);

const DateInput: Component<{ value: unknown; onChange: (v: unknown) => void; showTime?: boolean; id?: string }> = (props) => (
  <input
    id={props.id}
    type={props.showTime ? "datetime-local" : "date"}
    value={String(props.value ?? "")}
    onInput={(e) => props.onChange(e.currentTarget.value || null)}
  />
);

const EnumInput: Component<{ value: unknown; onChange: (v: unknown) => void; options: string[]; id?: string; placeholder?: string }> = (props) => (
  <select
    id={props.id}
    value={String(props.value ?? "")}
    onChange={(e) => props.onChange(e.currentTarget.value || null)}
  >
    <option value="">{props.placeholder ?? "\u2014"}</option>
    <For each={props.options}>{(opt) => <option value={opt}>{opt}</option>}</For>
  </select>
);

const TagsInput: Component<{ value: unknown; onChange: (v: unknown) => void; options: string[]; labelledBy?: string }> = (props) => {
  const selected = (): string[] => Array.isArray(props.value) ? props.value : [];
  const toggle = (tag: string) => {
    const current = selected();
    props.onChange(
      current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag],
    );
  };

  return (
    <div class="tag-list" role="group" aria-labelledby={props.labelledBy}>
      <For each={props.options}>
        {(opt) => (
          <button
            type="button"
            class="btn-bare tag"
            classList={{ "tag-off": !selected().includes(opt) }}
            aria-pressed={selected().includes(opt)}
            onClick={() => toggle(opt)}
          >
            {opt}
          </button>
        )}
      </For>
    </div>
  );
};

const DurationInput: Component<{ value: unknown; onChange: (v: unknown) => void; labelledBy?: string; placeholder?: string }> = (props) => {
  let hoursRef!: HTMLInputElement;
  let minutesRef!: HTMLInputElement;
  const total = () => (typeof props.value === "number" && !Number.isNaN(props.value) ? props.value : null);
  const hours = () => { const t = total(); return t === null || t < 60 ? "" : Math.floor(t / 60); };
  const minutes = () => { const t = total(); return t === null ? "" : t % 60; };
  // Both boxes empty means unset.
  const update = () => {
    const h = hoursRef.valueAsNumber;
    const m = minutesRef.valueAsNumber;
    if (Number.isNaN(h) && Number.isNaN(m)) props.onChange(null);
    else props.onChange((Number.isNaN(h) ? 0 : h) * 60 + (Number.isNaN(m) ? 0 : m));
  };

  return (
    <div class="duration-input" role="group" aria-labelledby={props.labelledBy}>
      <input
        ref={hoursRef}
        type="number"
        min="0"
        class="duration-num"
        aria-label="Hours"
        value={hours()}
        onInput={update}
      />
      <span class="duration-unit" aria-hidden="true">h</span>
      <input
        ref={minutesRef}
        type="number"
        min="0"
        max="59"
        class="duration-num"
        aria-label="Minutes"
        value={minutes()}
        onInput={update}
      />
      <span class="duration-unit" aria-hidden="true">m</span>
      <input
        type="text"
        class="duration-text"
        aria-label="Duration, as text"
        placeholder={props.placeholder ?? "e.g. 1h42m"}
        value={total() ? formatDurationShort(total()!) : ""}
        onBlur={(e) => {
          const text = e.currentTarget.value;
          const parsed = parseDurationText(text);
          if (parsed !== null) props.onChange(parsed);
          else if (text.trim() === "" && total() !== null) props.onChange(null);
        }}
      />
    </div>
  );
};

const TodoInput: Component<{ value: unknown; onChange: (v: unknown) => void; id?: string }> = (props) => (
  <select
    id={props.id}
    value={typeof props.value === "string" ? props.value : "default"}
    onChange={(e) => props.onChange(e.currentTarget.value === "default" ? undefined : e.currentTarget.value)}
  >
    <option value="default">Todo</option>
    <option value="done">Done</option>
    <option value="cancelled">Cancel</option>
    <option value="skipped">Skip</option>
  </select>
);

export default AttributeEditor;
