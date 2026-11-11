import type { ProjectId } from "@t3tools/contracts";

/** A project in the worker environment that has a repository: somewhere a worker can run. */
export interface Checkout {
  readonly projectId: ProjectId;
  readonly title: string;
  /** The repository's canonical key, such as `github.com/acme/app`. */
  readonly repositoryKey: string;
  /** `owner/name`, when the repository's host reports one. */
  readonly slug: string | undefined;
}

/** A project on this host, which a lead may name instead of the repository. */
export interface HostProject {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly repositoryKey: string | undefined;
  /** Its folder on this host, where a worker on this server would branch from. */
  readonly root?: string;
}

export type Resolution =
  | {
      readonly _tag: "resolved";
      readonly checkout: Checkout;
      readonly hostProjectId: ProjectId | null;
    }
  /** Known on this host, but the worker environment has no checkout of it. */
  | { readonly _tag: "no_checkout"; readonly label: string }
  /** Not among the projects this request is held to, whether or not it exists. */
  | { readonly _tag: "outside" }
  | { readonly _tag: "ambiguous"; readonly labels: ReadonlyArray<string> }
  | { readonly _tag: "unknown"; readonly labels: ReadonlyArray<string> };

const MAX_LISTED = 20;

export const labelOf = (checkout: Checkout) => checkout.slug ?? checkout.title;

/**
 * What a name is shaped like. Only a bare name may mean a project's title; anything with a slash
 * names a repository, so a title spelled like a URL or a path never stands in for one.
 */
const shapeOf = (value: string) => {
  const trimmed = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || /^[^\s@/]+@[^\s:/]+:/.test(trimmed))
    return "url" as const;
  if (/^(?:[~/\\]|[a-z]:[\\/])/i.test(trimmed) || /(?:^|[/\\])\.\.?(?:[/\\]|$)/.test(trimmed))
    return "path" as const;
  if (trimmed.includes("\\")) return "path" as const;
  return trimmed.includes("/") ? ("qualified" as const) : ("bare" as const);
};

/** A name as a lead or a person writes it: a URL, `owner/name`, a bare name or an id. */
const normalize = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?/, "")
    .replace(/^[^\s@/]+@([^\s:/]+):/, "$1/")
    .replace(/^www\./, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");

const lastSegment = (value: string) => value.slice(value.lastIndexOf("/") + 1);
/** `acme/app` from `github.com/acme/app`. */
const withoutHost = (key: string) => key.slice(key.indexOf("/") + 1);

/**
 * The repositories a request may reach, by canonical key in lower case. `allowed` undefined is
 * the owner's reach: this host's projects' repositories and its connected repositories, never
 * whatever else the worker environment happens to have checked out. Else the listed projects'.
 */
export const reachableKeys = (input: {
  readonly hostProjects: ReadonlyArray<HostProject>;
  readonly connectedRepos: ReadonlyArray<string>;
  readonly allowed: ReadonlyArray<ProjectId> | undefined;
}): ReadonlySet<string> => {
  const hosts =
    input.allowed === undefined
      ? input.hostProjects
      : input.hostProjects.filter((project) => input.allowed!.includes(project.projectId));
  return new Set([
    ...hosts.flatMap((project) =>
      project.repositoryKey === undefined ? [] : [project.repositoryKey.toLowerCase()],
    ),
    ...(input.allowed === undefined
      ? input.connectedRepos.map((repo) => `github.com/${repo.toLowerCase()}`)
      : []),
  ]);
};

/**
 * The checkout a plainly named project or repository means. An id or a full `owner/name` outranks
 * a bare name, so `app` never beats `acme/app`; a name that fits several checkouts at the same
 * rank is ambiguous rather than guessed. `allowed` limits what the request may reach, as
 * `reachableKeys` reads it.
 */
export const resolveProject = (input: {
  readonly named: string;
  readonly checkouts: ReadonlyArray<Checkout>;
  readonly hostProjects: ReadonlyArray<HostProject>;
  /** `owner/name` of each repository the host has connected. */
  readonly connectedRepos: ReadonlyArray<string>;
  readonly allowed: ReadonlyArray<ProjectId> | undefined;
}): Resolution => {
  const shape = shapeOf(input.named);
  const wanted = normalize(input.named);
  const hostFor = (key: string) =>
    input.hostProjects.filter((project) => project.repositoryKey?.toLowerCase() === key);
  const reachable = reachableKeys(input);
  // A URL or a path names one repository by its key; `owner/name` may also leave the host off.
  const repositoryNames = (key: string, slug: string | undefined) =>
    shape === "bare" || shape === "qualified"
      ? [key, withoutHost(key), ...(slug === undefined ? [] : [slug])]
      : [key];
  const has = (names: ReadonlyArray<string>) => names.some((name) => name.toLowerCase() === wanted);
  const ranked = input.checkouts.map((checkout) => {
    const key = checkout.repositoryKey.toLowerCase();
    const hosts = hostFor(key);
    const exact =
      shape === "bare" ? [checkout.projectId, ...hosts.map((project) => project.projectId)] : [];
    const bare =
      shape === "bare"
        ? [lastSegment(key), checkout.title, ...hosts.map((project) => project.title)]
        : [];
    return {
      checkout,
      hosts,
      rank: has(exact)
        ? 0
        : has(repositoryNames(key, checkout.slug))
          ? 1
          : has(bare)
            ? 2
            : undefined,
      open: reachable.has(key),
    };
  });
  const open = ranked.filter((entry) => entry.open);
  const labels = (entries: ReadonlyArray<{ readonly checkout: Checkout }>) =>
    [...new Set(entries.map((entry) => labelOf(entry.checkout)))].toSorted().slice(0, MAX_LISTED);
  for (const rank of [0, 1, 2]) {
    const matches = open.filter((entry) => entry.rank === rank);
    if (matches.length === 1) {
      const [match] = matches;
      const host =
        match!.hosts.find((project) => input.allowed?.includes(project.projectId) ?? true) ?? null;
      return {
        _tag: "resolved",
        checkout: match!.checkout,
        hostProjectId: host?.projectId ?? null,
      };
    }
    if (matches.length > 1) return { _tag: "ambiguous", labels: labels(matches) };
  }
  // One answer for everything a listed request can't reach, so it can't probe what else exists.
  if (input.allowed !== undefined) return { _tag: "outside" };
  // Named something this host knows, which nobody has checked out for workers yet.
  const known =
    input.connectedRepos.find((repo) => has(repositoryNames(`github.com/${repo}`, repo))) ??
    input.hostProjects.find(
      (project) =>
        project.repositoryKey !== undefined &&
        has([
          ...repositoryNames(project.repositoryKey, undefined),
          ...(shape === "bare" ? [project.projectId, project.title] : []),
        ]),
    )?.title;
  return known === undefined
    ? { _tag: "unknown", labels: labels(open) }
    : { _tag: "no_checkout", label: known };
};
