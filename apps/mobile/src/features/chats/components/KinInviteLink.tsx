import { useAtomValue } from "@effect/atom-react";
import {
  KIN_INVITE_LOCAL_ONLY_NOTE,
  KIN_INVITE_PHONE_NOTE,
  kinInviteLink,
  kinInviteLinkCopy,
  kinInviteLinkLocalOnly,
  type KinMadeInvite,
} from "@t3tools/client-runtime/kin/kinTeam";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useState } from "react";
import { Share, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { ListSection } from "../../../components/ui/ListSection";
import { tryCopyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { environmentSession } from "../../../state/session";

/**
 * A teammate's link, shown once with copy and the share sheet. The caller holds the invite in
 * its own state, so leaving the screen is the last anyone sees of it.
 */
export function KinInviteLink(props: {
  readonly invite: KinMadeInvite;
  readonly environmentId: EnvironmentId;
}) {
  const { invite } = props;
  const connection = Option.getOrNull(
    useAtomValue(environmentSession.preparedConnectionValueAtom(props.environmentId)),
  );
  const [copied, setCopied] = useState(false);
  const copy = kinInviteLinkCopy(invite);
  if (connection === null) {
    return (
      <ErrorBanner
        message={`The connection dropped before the link could be shown. Make a new link for ${invite.displayName} from Team once you're back online.`}
      />
    );
  }
  const link = kinInviteLink(connection.httpBaseUrl, invite.secret);
  return (
    <>
      <View className="gap-2 px-2">
        <Text textRole="title" accessibilityRole="header" className="font-t3-bold text-foreground">
          {copy.title}
        </Text>
        <Text textRole="body" className="text-foreground-muted">
          {copy.detail}
        </Text>
      </View>
      <ListSection footer={KIN_INVITE_PHONE_NOTE}>
        <View className="px-4 py-3">
          <Text
            textRole="body"
            selectable
            accessibilityLabel={`Invite link for ${invite.displayName}`}
            className="text-foreground"
          >
            {link}
          </Text>
        </View>
      </ListSection>
      {kinInviteLinkLocalOnly(connection.httpBaseUrl) ? (
        <Text textRole="footnote" className="px-4 text-warning-foreground">
          {KIN_INVITE_LOCAL_ONLY_NOTE}
        </Text>
      ) : null}
      <View className="gap-3">
        <Button
          tone="primary"
          icon="square.and.arrow.up"
          label="Share link"
          // Closing the share sheet without sending is not a failure.
          onPress={() => void Share.share({ message: link }).catch(() => undefined)}
        />
        <Button
          tone="secondary"
          icon={copied ? "checkmark" : "doc.on.doc"}
          label={copied ? "Copied" : "Copy link"}
          onPress={() =>
            void tryCopyTextWithHaptic(link, { target: "invite link" }).then(setCopied)
          }
        />
      </View>
    </>
  );
}
