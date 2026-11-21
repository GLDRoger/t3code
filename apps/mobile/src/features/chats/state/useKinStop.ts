import { makeKinStopHooks } from "@t3tools/client-runtime/kin/react/kinStopHooks";

import { kinHookApp } from "./kinHookApp";

export const { useKinStop, useKinStopLine } = makeKinStopHooks(kinHookApp);
