/** Vite's dev server swaps modules in place; a page it serves never reloads for a build. */
export const devBundle = import.meta.env.DEV;

/** The entry script this page booted from; the server names the one it serves the same way. */
export function pageBuild(): string | null {
  return document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? null;
}

export function reloadPage() {
  window.location.reload();
}
