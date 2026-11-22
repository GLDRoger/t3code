import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_CONNECTIONS_COPY as COPY,
  kinConnectionProvider,
  kinConnectionStatus,
} from "@t3tools/client-runtime/kin/kinConnections";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppBar } from "../../../components/ui/AppBar";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { Notice } from "../../../components/ui/Notice";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { kinClient } from "../state/kinClient";
import {
  decodeConnectionsTarget,
  KinConnectionsMissing,
  type KinConnectionsParams,
  type KinConnectionsTarget,
} from "./kinConnectionTarget";
import { KinVisualHosts } from "../KinVisualHosts";
import { KinGitHubSection } from "./KinGitHubConnect";
import { KinSocialSection } from "./KinSocialConnect";
import { KinPicturesSection } from "./KinPicturesConnect";

/** Settings → Connections: the owner's connections; one opens as its record. */
export function KinConnectionsScreen({ route }: StaticScreenProps<KinConnectionsParams>) {
  const target = decodeConnectionsTarget(route.params);
  return target === null ? (
    <KinConnectionsMissing title={COPY.title} />
  ) : (
    <ConnectionsList params={route.params} target={target} />
  );
}

function ConnectionsList(props: {
  readonly params: KinConnectionsParams;
  readonly target: KinConnectionsTarget;
}) {
  const navigation = useNavigation();
  const { target } = props;
  const route = { params: props.params };
  const listAtom = kinClient.connections({
    environmentId: target.environmentId,
    input: { orgId: target.orgId },
  });
  const result = useAtomValue(listAtom);
  const reload = useAtomRefresh(listAtom);
  const view = Option.getOrNull(AsyncResult.value(result));
  const add = () => navigation.navigate("KinConnectionAdd", route.params);

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={COPY.title} onBack={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          <KinGitHubSection params={props.params} target={target} />
          <KinSocialSection params={props.params} target={target} />
          <KinPicturesSection target={target} />
          {view === null ? (
            AsyncResult.isFailure(result) ? (
              <Notice
                tone="danger"
                message={COPY.loadFailed}
                action={{ label: KIN_RETRY, onPress: reload }}
              />
            ) : (
              <AppActivityIndicator />
            )
          ) : view.connections.length === 0 ? (
            <>
              <EmptyState variant="plain" title={COPY.emptyTitle} detail={COPY.emptyDetail} />
              <ListSection>
                <ListActionRow label={COPY.add} onPress={add} />
              </ListSection>
            </>
          ) : (
            <>
              <ListSection footer={COPY.intro}>
                {view.connections.map((connection) => {
                  const status = kinConnectionStatus(connection);
                  return (
                    <ListRow
                      key={connection.connectionId}
                      icon={
                        status.tone === "error"
                          ? "exclamationmark.triangle"
                          : status.tone === "attention"
                            ? "exclamationmark.circle"
                            : connection.paused
                              ? "pause"
                              : "link"
                      }
                      label={connection.label}
                      description={`${kinConnectionProvider(connection)} · ${status.detail}`}
                      detail={status.label}
                      onPress={() =>
                        navigation.navigate("KinConnection", {
                          ...route.params,
                          connectionId: connection.connectionId,
                        })
                      }
                    />
                  );
                })}
              </ListSection>
              <ListSection>
                <ListActionRow label={COPY.add} onPress={add} />
              </ListSection>
            </>
          )}
          <KinVisualHosts environmentId={target.environmentId} orgId={target.orgId} />
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
