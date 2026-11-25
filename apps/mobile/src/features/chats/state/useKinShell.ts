import { makeKinShellHooks } from "@t3tools/client-runtime/kin/react/kinShellHooks";

import { kinHookApp } from "./kinHookApp";

export const {
  useKinShell,
  useKinSectionOn,
  useKinSectionNamed,
  useKinSectionWords,
  useKinSectionCanSet,
  useKinSectionSet,
} = makeKinShellHooks(kinHookApp);
