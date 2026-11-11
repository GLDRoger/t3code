import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_WORK_GONE,
  KIN_WORK_ITEM_FAILED,
  KIN_WORK_ONLY_OWNER,
  kinWorkItemState,
  kinWorkItemView,
  type KinWorkItemView,
  type KinWorkLinkView,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  EnvironmentId,
  KIN_RECORD_CHANGES_CAP,
  KinOrgId,
  KinRecordKey,
  type KinAgentId,
  type KinChatId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { appAtomRegistry } from "../../state/atom-registry";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { KinAvatar } from "./components/KinAvatar";
import { KinWorkStateSymbol } from "./components/KinWorkStateSymbol";
import { kinClient } from "./state/kinClient";
import { useKinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";

export type KinWorkItemParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The task's short handle, such as `W-12`. */
  readonly task: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

const LINK_SYMBOL: Record<KinWorkLinkView["kind"], AppSymbolName> = {
  pull_request: PullRequestGlyph.pullRequest,
  worker: "play",
  message: "bubble.left",
  task: "checkmark.circle",
  note: "doc.text",
  link: "link",
};

/** One task: where it stands, who has it, what it links to and how it got here. */
export function KinWorkItemScreen({ route }: StaticScreenProps<KinWorkItemParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const key = Option.getOrNull(decodeKey(route.params.task));
  if (environmentId === null || orgId === null || key === null) {
    return (
      <Frame title="Task" onClose={() => navigation.goBack()}>
        <EmptyState
          variant="plain"
          title="This link doesn't name a task"
          detail="Open Work from your Kin chats."
        />
      </Frame>
    );
  }
  return <KinWorkItemGate environmentId={environmentId} orgId={orgId} itemKey={key} />;
}

function Frame(props: {
  readonly title: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={props.title} onClose={props.onClose} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {props.children}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

type ItemTarget = KinWorkTarget & { readonly itemKey: KinRecordKey };

function KinWorkItemGate(props: ItemTarget) {
  const navigation = useNavigation();
  const allowed = useAtomValue(kinClient.workRead.permissionAtom(props.environmentId));
  // A teammate who follows a link asks the host nothing.
  if (!allowed) {
    return (
      <Frame title={props.itemKey} onClose={() => navigation.goBack()}>
        <EmptyState variant="plain" {...KIN_WORK_ONLY_OWNER} />
      </Frame>
    );
  }
  return <KinWorkItemBody {...props} />;
}

function KinWorkItemBody(props: ItemTarget) {
  const navigation = useNavigation();
  const { environmentId, orgId, itemKey } = props;
  const itemAtom = kinClient.workItem({ environmentId, input: { orgId, key: itemKey } });
  const state = kinWorkItemState(useAtomValue(itemAtom), null);
  const directory = useKinWorkDirectory(props, true);
  const canGive = useAtomValue(kinClient.workAssign.permissionAtom(environmentId));
  const now = new Date(useNowMinuteMs());
  const close = () => navigation.goBack();

  if (state._tag !== "ready") {
    return (
      <Frame title={itemKey} onClose={close}>
        {state._tag === "loading" ? (
          <View
            className="items-center py-12"
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Loading task"
          >
            <AppActivityIndicator />
          </View>
        ) : state._tag === "gone" ? (
          <EmptyState variant="plain" {...KIN_WORK_GONE} />
        ) : (
          <EmptyState
            variant="plain"
            {...KIN_WORK_ITEM_FAILED}
            action={
              <Button
                tone="secondary"
                label="Try again"
                onPress={() => appAtomRegistry.refresh(itemAtom)}
              />
            }
          />
        )}
      </Frame>
    );
  }
  const view = kinWorkItemView(state.item, directory.names, now, KIN_RECORD_CHANGES_CAP);
  const openChat = (chatId: KinChatId) => {
    navigation.goBack();
    navigation.navigate("KinChat", { environmentId, orgId, chatId });
  };
  return (
    <Frame title={view.heading} onClose={close}>
      <View className="gap-3 px-2">
        <Text textRole="headline" accessibilityRole="header" className="text-foreground">
          {view.title}
        </Text>
        <View className="flex-row flex-wrap items-center gap-2">
          <KinWorkStateSymbol state={view.state} />
          <Text textRole="body" className="text-foreground">
            {view.status}
          </Text>
          {view.late ? (
            <Text textRole="footnote" className="font-t3-medium text-danger-foreground">
              Late
            </Text>
          ) : null}
        </View>
        {[view.given, ...view.remarks].map((line) =>
          line === null ? null : (
            <Text key={line} textRole="footnote" className="text-foreground-muted">
              {line}
            </Text>
          ),
        )}
      </View>
      <ListSection>
        <ListRowLayout
          leading={<KinAvatar avatar={view.owner.avatar} size="mini" />}
          label={view.owner.name}
          detail="Has it"
        />
        {view.due === null ? null : <ListRowLayout icon="clock" label={view.due} detail="Due" />}
        {canGive ? (
          <ListActionRow
            label={view.assignLabel}
            onPress={() =>
              navigation.navigate("KinWorkAssign", { environmentId, orgId, task: itemKey })
            }
          />
        ) : null}
        {view.owner.principal._tag === "agent" ? (
          <KinWorkLeadChat
            {...props}
            agentId={view.owner.principal.agentId}
            name={view.owner.name}
            onOpen={openChat}
          />
        ) : null}
      </ListSection>
      {view.notes === null ? null : (
        <View className="gap-2 px-2">
          <Text textRole="footnote" className="text-foreground-muted">
            Notes
          </Text>
          <Text textRole="body" selectable className="text-foreground">
            {view.notes}
          </Text>
        </View>
      )}
      {view.links.length === 0 ? null : (
        <ListSection title="Links">
          {view.links.map((link) => (
            <KinWorkLink key={link.key} link={link} onOpenChat={openChat} />
          ))}
        </ListSection>
      )}
      <KinWorkHistory view={view} />
    </Frame>
  );
}

function KinWorkLink(props: {
  readonly link: KinWorkLinkView;
  readonly onOpenChat: (chatId: KinChatId) => void;
}) {
  const { link } = props;
  const content = {
    icon: LINK_SYMBOL[link.kind],
    label: link.label,
    ...(link.detail === null ? {} : { description: link.detail }),
  };
  const open = link.open;
  if (open === null) return <ListRowLayout {...content} />;
  return (
    <ListRow
      {...content}
      onPress={() =>
        open.type === "chat"
          ? props.onOpenChat(open.chatId)
          : void tryOpenExternalUrl(open.href, "markdown-link")
      }
    />
  );
}

function KinWorkLeadChat(
  props: KinWorkTarget & {
    readonly agentId: KinAgentId;
    readonly name: string;
    readonly onOpen: (chatId: KinChatId) => void;
  },
) {
  const { environmentId, orgId } = props;
  const result = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const lead = Option.getOrNull(AsyncResult.value(result))?.leads.find(
    (held) => held.agentId === props.agentId,
  );
  if (lead === undefined) return null;
  return (
    <ListActionRow
      label={`Chat with ${props.name}`}
      onPress={() => props.onOpen(lead.ownerChatId)}
    />
  );
}

function KinWorkHistory({ view }: { readonly view: KinWorkItemView }) {
  if (view.history.length === 0) return null;
  return (
    <View className="gap-2 px-2">
      <Text textRole="footnote" className="text-foreground-muted">
        History
      </Text>
      {view.history.map((line) => (
        <View key={line.key} className="flex-row gap-3">
          <Text textRole="footnote" className="w-16 text-foreground-muted">
            {line.when}
          </Text>
          <Text textRole="footnote" className="min-w-0 flex-1 text-foreground">
            {line.text}
          </Text>
        </View>
      ))}
      {view.historyNote === null ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {view.historyNote}
        </Text>
      )}
    </View>
  );
}
