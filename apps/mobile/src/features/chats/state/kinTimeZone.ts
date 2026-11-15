import { createKinOwnerTimeZoneSync } from "@t3tools/client-runtime/kin/kinTimeZone";

import { connectionAtomRuntime } from "../../../connection/runtime";

export const syncKinOwnerTimeZone = createKinOwnerTimeZoneSync(connectionAtomRuntime);
