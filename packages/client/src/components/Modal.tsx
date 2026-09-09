import { type Component, type JSX, Show, onMount, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";

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
      <Portal>
        <div
          class={props.class ? `overlay modal-overlay ${props.class}-overlay` : "overlay modal-overlay"}
          ref={overlayRef}
          onClick={(e) => { if (e.target === overlayRef) props.onClose(); }}
        >
          <div class={props.class ? `panel modal ${props.class}` : "panel modal"}>{props.children}</div>
        </div>
      </Portal>
    </Show>
  );
};

export default Modal;
