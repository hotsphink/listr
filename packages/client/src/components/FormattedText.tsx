import { type Component, createEffect } from "solid-js";

const ALLOWED_ELEMENTS = ["b", "i", "em", "strong", "u", "s", "span"];

const FormattedText: Component<{ html: string; class?: string }> = (props) => {
  let el!: HTMLSpanElement;

  createEffect(() => {
    const h = props.html;
    if (typeof (el as any).setHTML === "function") {
      (el as any).setHTML(h, { sanitizer: new (window as any).Sanitizer({ allowElements: ALLOWED_ELEMENTS }) });
    } else {
      el.innerHTML = h;
    }
  });

  return <span ref={el} class={props.class} />;
};

export default FormattedText;
