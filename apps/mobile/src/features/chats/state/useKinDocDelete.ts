import { makeKinDocDeleteHooks } from "@t3tools/client-runtime/kin/react/kinDocDeleteHooks";

import { kinHookApp } from "./kinHookApp";

export const { useKinDocDelete } = makeKinDocDeleteHooks(kinHookApp);
