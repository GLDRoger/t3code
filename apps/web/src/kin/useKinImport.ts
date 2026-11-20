import { makeKinImportHooks } from "@t3tools/client-runtime/kin/react/kinImportHooks";

import { kinHookApp } from "./kinHookApp";

export const { useKinImportRuns, useKinImportSend } = makeKinImportHooks(kinHookApp);
