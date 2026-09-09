import { type Component, type JSX, Show, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";

interface Props {
  open: boolean;
  onClose: () => void;
  children: JSX.Element;
  class?: string;
  /** Accessible name, when the dialog has no heading of its own to borrow. */
  label?: string;
}

// Selector for everything a Tab press can reach. Used for the focus trap and to
// pick the element that receives focus when a dialog opens.
const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

// Open dialogs, innermost last. Escape acts on the last one so a dialog stacked
// over another does not close both at once.
const openStack: object[] = [];

let dialogSeq = 0;

const Modal: Component<Props> = (props) => {
  let overlayRef: HTMLDivElement | undefined;
  let panelRef: HTMLDivElement | undefined;
  const token = {};
  const headingId = `modal-heading-${++dialogSeq}`;

  const focusable = (): HTMLElement[] =>
    panelRef
      ? Array.from(panelRef.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
          // getClientRects, not offsetParent: the overlay is fixed-positioned.
          (el) => el.getClientRects().length > 0,
        )
      : [];

  const handleKeyDown = (e: KeyboardEvent) => {
    if (openStack[openStack.length - 1] !== token) return;

    if (e.key === "Escape") {
      props.onClose();
      return;
    }

    if (e.key !== "Tab" || !panelRef) return;

    // Keep Tab inside the dialog by wrapping at both ends.
    const items = focusable();
    if (items.length === 0) {
      e.preventDefault();
      panelRef.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (!panelRef.contains(active)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  createEffect(() => {
    if (!props.open) return;

    const restoreTo = document.activeElement as HTMLElement | null;
    openStack.push(token);
    document.addEventListener("keydown", handleKeyDown, true);

    // Name the dialog after its own heading when it has one, so screen readers
    // announce what opened.
    queueMicrotask(() => {
      if (!panelRef) return;
      const heading = panelRef.querySelector("h1, h2, h3");
      if (heading) {
        if (!heading.id) heading.id = headingId;
        panelRef.setAttribute("aria-labelledby", heading.id);
      }
      // Anything marked autofocus wins; otherwise start at the first control,
      // falling back to the panel so focus never stays behind on the page.
      const preferred = panelRef.querySelector<HTMLElement>("[autofocus]");
      (preferred ?? focusable()[0] ?? panelRef).focus();
    });

    onCleanup(() => {
      document.removeEventListener("keydown", handleKeyDown, true);
      const i = openStack.lastIndexOf(token);
      if (i !== -1) openStack.splice(i, 1);
      // Hand focus back to whatever opened the dialog.
      if (restoreTo && document.contains(restoreTo)) restoreTo.focus();
    });
  });

  return (
    <Show when={props.open}>
      <Portal>
        <div
          class={props.class ? `overlay modal-overlay ${props.class}-overlay` : "overlay modal-overlay"}
          ref={overlayRef}
          onClick={(e) => { if (e.target === overlayRef) props.onClose(); }}
        >
          <div
            class={props.class ? `panel modal ${props.class}` : "panel modal"}
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-label={props.label}
            tabindex={-1}
          >
            {props.children}
          </div>
        </div>
      </Portal>
    </Show>
  );
};

export default Modal;
