import { makeKinCanvasHooks } from "@t3tools/client-runtime/kin/react/kinCanvasHooks";

import { kinHookApp } from "../kinHookApp";
import { useNowMinuteMs } from "../useKinClock";
import { useKinDocsList, useKinDocsLive } from "../useKinDocs";
import { useKinHostAt } from "../useKinHost";
import {
  kinWorkLiveAtom,
  useKinPagedList,
  useKinProjectsList,
  useKinWork,
  useKinWorkDirectory,
} from "../useKinWork";

export type { KinCanvasTasks } from "@t3tools/client-runtime/kin/react/kinCanvasHooks";

export const { useKinCanvas } = makeKinCanvasHooks(kinHookApp, {
  work: { useKinWork, useKinWorkDirectory, useKinPagedList, useKinProjectsList, kinWorkLiveAtom },
  docs: { useKinDocsLive, useKinDocsList },
  useKinHostAt,
  useNowMinuteMs,
});
