import { AsyncResult, Atom } from "effect/reactivity";

import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { serverEnvironment } from "../state/server";

/** Vite's dev server swaps modules in place; a page it serves never reloads for a build. */
export const devBundle = import.meta.env.DEV;

/** The entry script this page booted from; the server names the one it serves the same way. */
export function pageBuild(): string | null {
  return document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src ?? null;
}

/**
 * The web build the server that served this page states now. Only a live snapshot counts: the
 * cached one is from before the last reload. Teammates get the config too, not the lifecycle.
 */
export const serverBuildAtom = Atom.make((get) => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return undefined;
  const projection = AsyncResult.getOrElse(
    get(serverEnvironment.configProjection({ environmentId, input: {} })),
    () => null,
  );
  return projection?.source === "live" ? projection.config.environment.webBuild : undefined;
}).pipe(Atom.withLabel("kin:server-web-build"));

export function reloadPage() {
  window.location.reload();
}
