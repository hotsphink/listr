import { type Component, type JSX, For, Show, createSignal, onMount, onCleanup } from "solid-js";

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
}

const ContextMenu: Component<Props> = (props) => {
  let menuRef: HTMLDivElement | undefined;

  const handleClickOutside = (e: MouseEvent) => {
    if (menuRef && !menuRef.contains(e.target as Node)) {
      props.onClose();
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };

  onMount(() => {
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
  });

  onCleanup(() => {
    document.removeEventListener("mousedown", handleClickOutside);
    document.removeEventListener("keydown", handleKeyDown);
  });

  return (
    <div
      ref={menuRef}
      class="context-menu"
      style={`left: ${props.x}px; top: ${props.y}px`}
    >
      <For each={props.items}>
        {(item) => (
          <div
            class="context-menu-item"
            classList={{ danger: item.danger }}
            onClick={() => {
              item.action();
              props.onClose();
            }}
          >
            {item.label}
          </div>
        )}
      </For>
    </div>
  );
};

export default ContextMenu;
