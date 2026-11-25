import { makeKinTaskStepsHooks } from "@t3tools/client-runtime/kin/react/kinTaskStepsHooks";

import { kinHookApp } from "./kinHookApp";

export type { KinTaskStepStatus } from "@t3tools/client-runtime/kin/kinTaskSteps";

export const { useKinTaskSteps } = makeKinTaskStepsHooks(kinHookApp);
