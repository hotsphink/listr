import { type Component, createEffect } from "solid-js";

const ALLOWED_ELEMENTS = ["b", "i", "em", "strong", "u", "s", "span", "img", "a"];
const ALLOWED_ATTRIBUTES = { src: ["img"], alt: ["img"], href: ["a"], target: ["a"], rel: ["a"] };

const FormattedText: Component<{ html: string; class?: string }> = (props) => {
  let el!: HTMLSpanElement;

  createEffect(() => {
    const h = props.html;
    if (typeof (el as any).setHTML === "function") {
      (el as any).setHTML(h, { sanitizer: new (window as any).Sanitizer({ allowElements: ALLOWED_ELEMENTS, allowAttributes: ALLOWED_ATTRIBUTES }) });
    } else {
      el.innerHTML = h;
    }
  });

  return <span ref={el} class={`formatted-text${props.class ? ` ${props.class}` : ""}`} />;
};

export default FormattedText;
