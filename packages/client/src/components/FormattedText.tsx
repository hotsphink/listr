import { type Component, createEffect } from "solid-js";
import DOMPurify from "dompurify";
import { assetUrls } from "../sync/assetStore.js";

// Format output is synced data that anyone sharing a sync key can write, so
// sanitize it to this small vocabulary (see doc/FORMAT.md).
const ALLOWED_TAGS = ["b", "i", "em", "strong", "u", "s", "span", "img", "a"];
const ALLOWED_ATTR = ["href", "src", "alt", "target", "rel", "class"];
// DOMPurify additionally admits data: URLs on img (its DATA_URI_TAGS).
const ALLOWED_URI_REGEXP = /^(?:https?:|blob:)/i;

// A private instance, so these hooks affect only format output.
const purify = DOMPurify(window);

purify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "class") {
    // Only format styles; app classes could restyle or cover the UI.
    data.attrValue = data.attrValue.split(/\s+/).filter((c) => c.startsWith("fmt-")).join(" ");
    if (!data.attrValue) data.keepAttr = false;
  } else if ((data.attrName === "src" || data.attrName === "href") && data.attrValue.startsWith("hash://")) {
    // Raw HTML can reference uploaded assets directly.
    data.attrValue = assetUrls()[data.attrValue] ?? "";
  }
});

purify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A" && node.hasAttribute("target")) node.setAttribute("rel", "noopener noreferrer");
});

export function sanitizeFormatHtml(html: string): DocumentFragment {
  return purify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOWED_URI_REGEXP, RETURN_DOM_FRAGMENT: true });
}

const FormattedText: Component<{ html: string; tooltip?: string; class?: string }> = (props) => {
  let el!: HTMLSpanElement;

  createEffect(() => {
    el.replaceChildren(sanitizeFormatHtml(props.html));
  });

  return <span ref={el} class={`formatted-text${props.class ? ` ${props.class}` : ""}`} title={props.tooltip} />;
};

export default FormattedText;
