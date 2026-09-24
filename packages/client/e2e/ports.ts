// The e2e run serves the app on its own port, so it never reuses or disturbs a
// developer's dev server on 3000. E2E_PORT overrides it.
export const E2E_PORT = Number(process.env.E2E_PORT ?? 3100);
export const E2E_APP_URL = `https://localhost:${E2E_PORT}`;
