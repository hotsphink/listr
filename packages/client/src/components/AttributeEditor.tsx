import { type Component, Switch, Match, For, createSignal } from "solid-js";
import type { AttributeDefinition } from "@listr/shared";

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
}

const AttributeEditor: Component<Props> = (props) => {
  return (
    <Switch fallback={<TextInput id={props.id} value={props.value} onChange={props.onChange} />}>
      <Match when={props.definition.type === "text"}>
        <TextInput id={props.id} value={props.value} onChange={props.onChange} />
      </Match>
      <Match when={props.definition.type === "number"}>
        <NumberInput id={props.id} value={props.value} onChange={props.onChange} config={props.definition.config} />
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
        <EnumInput id={props.id} value={props.value} onChange={props.onChange} options={props.definition.options ?? []} />
      </Match>
      <Match when={props.definition.type === "tags"}>
        <TagsInput labelledBy={props.labelledBy} value={props.value} onChange={props.onChange} options={props.definition.options ?? []} />
      </Match>
      <Match when={props.definition.type === "url"}>
        <TextInput id={props.id} value={props.value} onChange={props.onChange} type="url" />
      </Match>
      <Match when={props.definition.type === "duration"}>
        <DurationInput labelledBy={props.labelledBy} value={props.value} onChange={props.onChange} />
      </Match>
      <Match when={props.definition.type === "todo"}>
        <TodoInput id={props.id} value={props.value} onChange={props.onChange} />
      </Match>
    </Switch>
  );
};

const TextInput: Component<{ value: unknown; onChange: (v: unknown) => void; type?: string; id?: string }> = (props) => (
  <input
    id={props.id}
    type={props.type ?? "text"}
    value={String(props.value ?? "")}
    onInput={(e) => props.onChange(e.currentTarget.value)}
  />
);

const NumberInput: Component<{ value: unknown; onChange: (v: unknown) => void; config?: Record<string, unknown>; id?: string }> = (props) => (
  <input
    id={props.id}
    type="number"
    value={props.value != null ? Number(props.value) : ""}
    min={props.config?.min as number | undefined}
    max={props.config?.max as number | undefined}
    step={props.config?.step as number | undefined ?? "any"}
    onBlur={(e) => {
      const v = e.currentTarget.valueAsNumber;
      props.onChange(isNaN(v) ? null : v);
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

const EnumInput: Component<{ value: unknown; onChange: (v: unknown) => void; options: string[]; id?: string }> = (props) => (
  <select
    id={props.id}
    value={String(props.value ?? "")}
    onChange={(e) => props.onChange(e.currentTarget.value || null)}
  >
    <option value="">—</option>
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

function parseDurationText(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(?:(\d+)\s*h)?\s*(\d+)?\s*m?$/i);
  if (match) {
    const h = match[1] ? parseInt(match[1], 10) : 0;
    const m = match[2] ? parseInt(match[2], 10) : 0;
    if (h > 0 || m > 0) return h * 60 + m;
  }

  const justMinutes = trimmed.match(/^(\d+)$/);
  if (justMinutes) return parseInt(justMinutes[1], 10);

  return null;
}

function formatDurationShort(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0 && m > 0) return `${h}h${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

const DurationInput: Component<{ value: unknown; onChange: (v: unknown) => void; labelledBy?: string }> = (props) => {
  const totalMinutes = () => Number(props.value ?? 0);
  const hours = () => Math.floor(totalMinutes() / 60);
  const minutes = () => totalMinutes() % 60;

  return (
    <div class="duration-input" role="group" aria-labelledby={props.labelledBy}>
      <input
        type="number"
        min="0"
        class="duration-num"
        aria-label="Hours"
        value={hours()}
        onInput={(e) => props.onChange(e.currentTarget.valueAsNumber * 60 + minutes())}
      />
      <span class="duration-unit" aria-hidden="true">h</span>
      <input
        type="number"
        min="0"
        max="59"
        class="duration-num"
        aria-label="Minutes"
        value={minutes()}
        onInput={(e) => props.onChange(hours() * 60 + (e.currentTarget.valueAsNumber || 0))}
      />
      <span class="duration-unit" aria-hidden="true">m</span>
      <input
        type="text"
        class="duration-text"
        aria-label="Duration, as text"
        placeholder="e.g. 1h42m"
        value={totalMinutes() > 0 ? formatDurationShort(totalMinutes()) : ""}
        onBlur={(e) => {
          const parsed = parseDurationText(e.currentTarget.value);
          if (parsed !== null) props.onChange(parsed);
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
