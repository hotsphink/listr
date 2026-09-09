import { type Component, For, onMount, onCleanup } from "solid-js";

export interface MenuItem {
  label: string;
  action: () => void;
  danger?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /** Names the menu for screen readers, e.g. the board or item it acts on. */
  label?: string;
}

const ContextMenu: Component<Props> = (props) => {
  let menuRef: HTMLDivElement | undefined;
  // Whatever had focus when the menu opened, so closing can hand it back.
  const restoreTo = document.activeElement as HTMLElement | null;

  const buttons = (): HTMLButtonElement[] =>
    menuRef ? Array.from(menuRef.querySelectorAll<HTMLButtonElement>(".context-menu-item")) : [];

  const focusAt = (index: number) => {
    const items = buttons();
    if (items.length === 0) return;
    items[(index + items.length) % items.length].focus();
  };

  const currentIndex = () => buttons().indexOf(document.activeElement as HTMLButtonElement);

  const close = (restore: boolean) => {
    if (restore && restoreTo && document.contains(restoreTo)) restoreTo.focus();
    props.onClose();
  };

  const handleClickOutside = (e: MouseEvent) => {
    if (menuRef && !menuRef.contains(e.target as Node)) close(false);
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close(true);
        break;
      case "ArrowDown":
        e.preventDefault();
        focusAt(currentIndex() + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        focusAt(currentIndex() - 1);
        break;
      case "Home":
        e.preventDefault();
        focusAt(0);
        break;
      case "End":
        e.preventDefault();
        focusAt(buttons().length - 1);
        break;
      case "Tab":
        // A menu is a single stop: leaving it dismisses rather than walks out.
        e.preventDefault();
        close(true);
        break;
    }
  };

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown, true);
    focusAt(0);
  });

  onCleanup(() => {
    document.removeEventListener("mousedown", handleClickOutside);
    document.removeEventListener("keydown", handleKeyDown, true);
  });

  return (
    <div
      ref={menuRef}
      class="panel context-menu"
      role="menu"
      aria-label={props.label ?? "Actions"}
      style={`left: ${props.x}px; top: ${props.y}px`}
    >
      <For each={props.items}>
        {(item) => (
          <button
            type="button"
            role="menuitem"
            class="context-menu-item"
            classList={{ danger: item.danger }}
            onClick={() => {
              // Restore focus before acting: the action may open a dialog that
              // wants to capture and later return focus itself.
              close(true);
              item.action();
            }}
          >
            {item.label}
          </button>
        )}
      </For>
    </div>
  );
};

export default ContextMenu;
