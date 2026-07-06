import { type Component, type JSX, Show, onMount, onCleanup } from "solid-js";

interface Props {
  open: boolean;
  onClose: () => void;
  children: JSX.Element;
  class?: string;
}

const Modal: Component<Props> = (props) => {
  let overlayRef: HTMLDivElement | undefined;

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };

  onMount(() => document.addEventListener("keydown", handleKeyDown));
  onCleanup(() => document.removeEventListener("keydown", handleKeyDown));

  return (
    <Show when={props.open}>
      <div
        class={props.class ? `modal-overlay ${props.class}-overlay` : "modal-overlay"}
        ref={overlayRef}
        onClick={(e) => { if (e.target === overlayRef) props.onClose(); }}
      >
        <div class={props.class ? `modal ${props.class}` : "modal"}>{props.children}</div>
      </div>
    </Show>
  );
};

export default Modal;
