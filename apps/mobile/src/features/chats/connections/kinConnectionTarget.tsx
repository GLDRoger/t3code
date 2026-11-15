import { useNavigation } from "@react-navigation/native";
import { KIN_CONNECTIONS_COPY } from "@t3tools/client-runtime/kin/kinConnections";
import { EnvironmentId, KinConnectionId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { View } from "react-native";

import { AppBar } from "../../../components/ui/AppBar";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ScreenContent } from "../../../components/ui/ScreenContent";

export type KinConnectionsParams = { readonly environmentId: string; readonly orgId: string };
export type KinConnectionParams = KinConnectionsParams & { readonly connectionId: string };

export type KinConnectionsTarget = {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeId = Schema.decodeUnknownOption(KinConnectionId);

export function decodeConnectionsTarget(params: KinConnectionsParams): KinConnectionsTarget | null {
  const environmentId = Option.getOrNull(decodeEnvironmentId(params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(params.orgId));
  return environmentId === null || orgId === null ? null : { environmentId, orgId };
}

export function decodeConnectionId(params: KinConnectionParams): KinConnectionId | null {
  return Option.getOrNull(decodeId(params.connectionId));
}

/** A Connections screen opened with params that name nothing. */
export function KinConnectionsMissing(props: { readonly title: string; readonly sheet?: boolean }) {
  const navigation = useNavigation();
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={props.title}
        {...(props.sheet === true
          ? { onClose: () => navigation.goBack() }
          : { onBack: () => navigation.goBack() })}
      />
      <ScreenContent surface="screen">
        <View className="p-4">
          <EmptyState
            variant="plain"
            title="This link doesn't open anything"
            detail={KIN_CONNECTIONS_COPY.onlyOwner}
          />
        </View>
      </ScreenContent>
    </View>
  );
}
