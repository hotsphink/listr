import type { Component } from "solid-js";

const ShareIcon: Component<{ class?: string }> = (props) => (
  <svg class={props.class} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-label="Shared board">
    <circle cx="12" cy="4" r="1.5"/><circle cx="4" cy="8" r="1.5"/><circle cx="12" cy="12" r="1.5"/>
    <line x1="5.4" y1="7.2" x2="10.6" y2="4.8"/><line x1="5.4" y1="8.8" x2="10.6" y2="11.2"/>
  </svg>
);

export default ShareIcon;
