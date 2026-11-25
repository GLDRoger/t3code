import { makeKinTaskStepsHooks } from "@t3tools/client-runtime/kin/react/kinTaskStepsHooks";

import { kinHookApp } from "./kinHookApp";

export const { useKinTaskSteps } = makeKinTaskStepsHooks(kinHookApp);
