import { type Component, Switch, Match, For, createSignal } from "solid-js";
import type { AttributeDefinition } from "@listr/shared";

interface Props {
  definition: AttributeDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}

const AttributeEditor: Component<Props> = (props) => {
  return (
    <Switch fallback={<TextInput value={props.value} onChange={props.onChange} />}>
      <Match when={props.definition.type === "text"}>
        <TextInput value={props.value} onChange={props.onChange} />
      </Match>
      <Match when={props.definition.type === "number"}>
        <NumberInput value={props.value} onChange={props.onChange} config={props.definition.config} />
      </Match>
      <Match when={props.definition.type === "rating"}>
        <RatingInput value={props.value} onChange={props.onChange} config={props.definition.config} />
      </Match>
      <Match when={props.definition.type === "boolean"}>
        <BooleanInput value={props.value} onChange={props.onChange} />
      </Match>
      <Match when={props.definition.type === "date"}>
        <DateInput value={props.value} onChange={props.onChange} />
      </Match>
      <Match when={props.definition.type === "datetime"}>
        <DateInput value={props.value} onChange={props.onChange} showTime />
      </Match>
      <Match when={props.definition.type === "enum"}>
        <EnumInput value={props.value} onChange={props.onChange} options={props.definition.options ?? []} />
      </Match>
      <Match when={props.definition.type === "tags"}>
        <TagsInput value={props.value} onChange={props.onChange} options={props.definition.options ?? []} />
      </Match>
      <Match when={props.definition.type === "url"}>
        <TextInput value={props.value} onChange={props.onChange} type="url" />
      </Match>
      <Match when={props.definition.type === "duration"}>
        <DurationInput value={props.value} onChange={props.onChange} />
      </Match>
    </Switch>
  );
};

const TextInput: Component<{ value: unknown; onChange: (v: unknown) => void; type?: string }> = (props) => (
  <input
    type={props.type ?? "text"}
    value={String(props.value ?? "")}
    onInput={(e) => props.onChange(e.currentTarget.value)}
  />
);

const NumberInput: Component<{ value: unknown; onChange: (v: unknown) => void; config?: Record<string, unknown> }> = (props) => (
  <input
    type="number"
    value={props.value != null ? Number(props.value) : ""}
    min={props.config?.min as number | undefined}
    max={props.config?.max as number | undefined}
    step={props.config?.step as number | undefined ?? "any"}
    onInput={(e) => {
      const v = e.currentTarget.valueAsNumber;
      props.onChange(isNaN(v) ? null : v);
    }}
  />
);

const RatingInput: Component<{ value: unknown; onChange: (v: unknown) => void; config?: Record<string, unknown> }> = (props) => {
  const max = () => (props.config?.max as number) ?? 5;
  const current = () => Number(props.value ?? 0);

  return (
    <span class="stars" style="cursor: pointer; font-size: 18px">
      <For each={Array.from({ length: max() }, (_, i) => i + 1)}>
        {(n) => (
          <span onClick={() => props.onChange(current() === n ? 0 : n)}>
            {n <= current() ? "★" : "☆"}
          </span>
        )}
      </For>
    </span>
  );
};

const BooleanInput: Component<{ value: unknown; onChange: (v: unknown) => void }> = (props) => (
  <input
    type="checkbox"
    checked={Boolean(props.value)}
    onChange={(e) => props.onChange(e.currentTarget.checked)}
    style="width: auto"
  />
);

const DateInput: Component<{ value: unknown; onChange: (v: unknown) => void; showTime?: boolean }> = (props) => (
  <input
    type={props.showTime ? "datetime-local" : "date"}
    value={String(props.value ?? "")}
    onInput={(e) => props.onChange(e.currentTarget.value || null)}
  />
);

const EnumInput: Component<{ value: unknown; onChange: (v: unknown) => void; options: string[] }> = (props) => (
  <select
    value={String(props.value ?? "")}
    onChange={(e) => props.onChange(e.currentTarget.value || null)}
  >
    <option value="">—</option>
    <For each={props.options}>{(opt) => <option value={opt}>{opt}</option>}</For>
  </select>
);

const TagsInput: Component<{ value: unknown; onChange: (v: unknown) => void; options: string[] }> = (props) => {
  const selected = (): string[] => Array.isArray(props.value) ? props.value : [];
  const toggle = (tag: string) => {
    const current = selected();
    props.onChange(
      current.includes(tag) ? current.filter((t) => t !== tag) : [...current, tag],
    );
  };

  return (
    <div style="display: flex; flex-wrap: wrap; gap: 4px">
      <For each={props.options}>
        {(opt) => (
          <span
            class="tag"
            style={selected().includes(opt) ? "opacity: 1; cursor: pointer" : "opacity: 0.4; cursor: pointer"}
            onClick={() => toggle(opt)}
          >
            {opt}
          </span>
        )}
      </For>
    </div>
  );
};

const DurationInput: Component<{ value: unknown; onChange: (v: unknown) => void }> = (props) => {
  const totalMinutes = () => Number(props.value ?? 0);
  const hours = () => Math.floor(totalMinutes() / 60);
  const minutes = () => totalMinutes() % 60;

  return (
    <div style="display: flex; gap: 4px; align-items: center">
      <input
        type="number"
        min="0"
        value={hours()}
        style="width: 60px"
        onInput={(e) => props.onChange(e.currentTarget.valueAsNumber * 60 + minutes())}
      />
      <span style="color: var(--text-muted); font-size: 12px">h</span>
      <input
        type="number"
        min="0"
        max="59"
        value={minutes()}
        style="width: 60px"
        onInput={(e) => props.onChange(hours() * 60 + (e.currentTarget.valueAsNumber || 0))}
      />
      <span style="color: var(--text-muted); font-size: 12px">m</span>
    </div>
  );
};

export default AttributeEditor;
