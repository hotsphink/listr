/// <reference types="vite/client" />

// Injected by Vite's `define` (see vite.config.ts). ISO timestamp of the build
// (or dev-server start time in development).
declare const __BUILD_TIME__: string;

// Injected by Vite's `define` (see vite.config.ts). Which world this client
// build belongs to ("dev" or "prod"), compared against the server's `variant`
// on connect.
declare const __VARIANT__: string;
