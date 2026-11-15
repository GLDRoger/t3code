import { useAtomValue } from "@effect/atom-react";
import { createKinPictures, kinPersonSeed } from "@t3tools/client-runtime/kin/kinProfiles";
import type { EnvironmentId, KinOrgId, KinPersonProfile } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useSyncExternalStore } from "react";

import { useAssetUrls } from "../assets/assetUrls";
import { kinClient } from "./kinClient";
import { useKinHost } from "./useKinHost";

/** The pictures people chose, by avatar seed. `KinPicturesHost` keeps it current. */
const kinPictures = createKinPictures();

export function useKinPicture(seed: string): string | undefined {
  return useSyncExternalStore(kinPictures.subscribe, () => kinPictures.get(seed));
}

const noProfilesAtom = Atom.make(null);

/** The org's profiles, as last read, for whoever this browser is in that org. */
export function useKinProfiles(environmentId: EnvironmentId | null, orgId: KinOrgId | null) {
  const result = useAtomValue(
    environmentId === null || orgId === null
      ? noProfilesAtom
      : kinClient.profiles({ environmentId, input: { orgId } }),
  );
  return result === null ? null : result;
}

/** Reads everyone's picture once for the Kin host, so every avatar slot can show it. */
export function KinPicturesHost() {
  const host = useKinHost();
  const ready = host._tag === "host" && host.probe._tag === "ready" ? host : null;
  const orgId =
    ready !== null && ready.probe._tag === "ready" ? (ready.probe.orgs.me[0]?.orgId ?? null) : null;
  const result = useKinProfiles(ready?.environmentId ?? null, orgId);
  const profiles =
    result === null ? [] : (Option.getOrNull(AsyncResult.value(result))?.profiles ?? []);
  if (ready === null) return null;
  return <PictureUrls environmentId={ready.environmentId} profiles={profiles} />;
}

function PictureUrls(props: {
  readonly environmentId: EnvironmentId;
  readonly profiles: ReadonlyArray<KinPersonProfile>;
}) {
  const pictured = props.profiles.filter((profile) => profile.pictureId !== null);
  const urls = useAssetUrls(
    props.environmentId,
    pictured.map((profile) => ({
      _tag: "attachment" as const,
      attachmentId: profile.pictureId ?? "",
      fileName: "picture",
    })),
  );
  const entries = pictured.flatMap((profile, index) => {
    const url = urls[index];
    return url == null ? [] : [[kinPersonSeed(profile.personId), url] as const];
  });
  const key = entries.map(([seed, url]) => `${seed}=${url}`).join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the signed picture URLs to the avatar store every avatar slot reads
  useEffect(() => {
    kinPictures.set(
      new Map(
        key === ""
          ? []
          : key.split("\n").map((line) => {
              const at = line.indexOf("=");
              return [line.slice(0, at), line.slice(at + 1)] as const;
            }),
      ),
    );
  }, [key]);
  return null;
}
