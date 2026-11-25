import { kinIsDealKey } from "@t3tools/client-runtime/kin/kinDeals";
import { useNavigation } from "@react-navigation/native";
import {
  kinBodyMarkdown,
  kinImageSource,
  kinImageText,
} from "@t3tools/client-runtime/kin/kinChatFeed";
import { kinDocPieceKey, kinDocPieces } from "@t3tools/client-runtime/kin/kinDocs";
import {
  kinLinkedMarkdown,
  kinLinkOf,
  kinPageCut,
  kinPageView,
} from "@t3tools/client-runtime/kin/kinMessagePage";
import {
  KinOrgId,
  type EnvironmentId,
  type KinEmbed,
  type KinMessageLink,
  type KinMessageLinkTarget,
} from "@t3tools/contracts";
import { Fragment, useState, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import {
  SelectableMarkdownText,
  type MarkdownFileContextMenu,
  type MarkdownImageRenderer,
  type NativeMarkdownTextStyle,
} from "../../../native/SelectableMarkdownText";
import { KinEmbedView } from "../widgets/KinEmbedView";

// A system serif that reads as chosen on each platform, with no font to ship.
const GREETING_FONT = Platform.select({ ios: "Georgia", default: "serif" });
const COLLAPSED_HEIGHT = 520;

const renderImageAsText: MarkdownImageRenderer = (image) => (
  <Text textRole="body" className="italic text-foreground-muted">
    {kinImageText(image)}
  </Text>
);

/** Opens what a name in a message points at, in the app's own screens. */
export function useKinOpenTarget(environmentId: EnvironmentId, orgId: string) {
  const navigation = useNavigation();
  return (to: KinMessageLinkTarget) => {
    const where = { environmentId, orgId };
    switch (to._tag) {
      case "chat":
        return navigation.navigate("KinChat", { ...where, chatId: to.chatId });
      case "person":
        return navigation.navigate("KinProfile", { ...where, personId: to.personId });
      case "settings":
        return navigation.navigate("SettingsKin");
      case "record":
        return to.kind === "client"
          ? navigation.navigate("KinClient", { ...where, party: to.key })
          : to.kind === "project"
            ? navigation.navigate("KinProject", { ...where, project: to.key })
            : to.kind === "doc"
              ? navigation.navigate("KinDoc", { ...where, doc: to.key })
              : kinIsDealKey(to.key)
                ? navigation.navigate("KinDeal", { ...where, deal: to.key })
                : navigation.navigate("KinWorkItem", { ...where, task: to.key });
    }
  };
}

/** Markdown whose names open in the app; a long press on one shows its entry's line first. */
export function KinLinkedText(props: {
  readonly markdown: string;
  readonly links: ReadonlyArray<KinMessageLink> | undefined;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress: (href: string) => void;
  readonly onOpenTarget: (to: KinMessageLinkTarget) => void;
  readonly selectable?: boolean;
}) {
  const { links } = props;
  const fileContextMenu = (href: string): MarkdownFileContextMenu | undefined => {
    const link = kinLinkOf(href, links);
    if (link === null) return undefined;
    return {
      title: link.note ?? link.text,
      actions: [
        ...(link.note === null ? [] : [{ id: "kin-note", title: link.note, disabled: true }]),
        { id: "enriched-open-link", title: "Open" },
      ],
    };
  };
  return (
    <SelectableMarkdownText
      markdown={kinLinkedMarkdown(kinBodyMarkdown(props.markdown), links, "plain")}
      textStyle={props.textStyle}
      {...(props.selectable === undefined ? {} : { selectable: props.selectable })}
      preserveSoftBreaks
      inlineWebLinks
      onLinkPress={(href) => {
        const link = kinLinkOf(href, links);
        if (link === null) props.onLinkPress(href);
        else props.onOpenTarget(link.to);
      }}
      fileContextMenu={fileContextMenu}
      renderImage={renderImageAsText}
      resolveImageSource={kinImageSource}
    />
  );
}

type PageText = Omit<Parameters<typeof KinLinkedText>[0], "markdown"> & {
  /** The whole body and its figures, so a block in any part finds the figure drawn for it. */
  readonly body: string;
  readonly embeds: ReadonlyArray<KinEmbed> | undefined;
  /** Where a figure's file is; null draws figures as their titles, as a draft does. */
  readonly where: { readonly environmentId: EnvironmentId; readonly orgId: string } | null;
};

/** A stretch of a page: its words with their links, and each figure in its place. */
function KinPageText(props: PageText & { readonly markdown: string }) {
  const { where } = props;
  return kinDocPieces(props.markdown, props).map((piece, index) => (
    <Fragment key={kinDocPieceKey(piece, index)}>
      {piece.type === "text" ? (
        <KinLinkedText {...props} markdown={piece.text} />
      ) : where === null ? null : (
        <KinEmbedView
          environmentId={where.environmentId}
          orgId={KinOrgId.make(where.orgId)}
          embed={piece.embed}
        />
      )}
    </Fragment>
  ));
}

/** One titled part of a page; tapping its heading folds it away and back. */
function KinPageSection(props: PageText & { readonly title: string; readonly markdown: string }) {
  const [open, setOpen] = useState(true);
  return (
    <View className="gap-1.5 border-t border-border-subtle pt-3">
      <Pressable
        accessibilityRole="header"
        accessibilityLabel={props.title}
        accessibilityState={{ expanded: open }}
        accessibilityHint={open ? "Folds this part away." : "Shows this part."}
        onPress={() => setOpen(!open)}
        hitSlop={8}
        className="min-h-8 flex-row items-center justify-between gap-2 active:opacity-60"
      >
        <Text textRole="body" className="font-t3-bold text-foreground">
          {props.title}
        </Text>
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </Pressable>
      {open ? <KinPageText {...props} /> : null}
    </View>
  );
}

/**
 * An agent's long or structured message as a page across the chat: no bubble, its sections under
 * real headings, each folding on its own, its figures in place, a long one cut between sections
 * with a Read more naming the rest. A brief opens with its greeting set large in a serif italic,
 * and the date. The turn's card, when it has one, closes the page.
 */
export function KinMessagePage(
  props: PageText & {
    readonly head: { readonly greeting: string; readonly date: string } | null;
    readonly foot?: ReactNode;
  },
) {
  const { head, foot, ...text } = props;
  const [expanded, setExpanded] = useState(false);
  const view = kinPageView(props.body, head !== null);
  const cut = expanded ? null : kinPageCut(props.body, head !== null);
  // Sections below the cut aren't mounted, so no frame loads there.
  const sections = cut === null ? view.sections : view.sections.slice(0, cut.shown);
  return (
    <View className="w-full gap-3">
      <View
        className="gap-3 overflow-hidden"
        style={cut?.clip ? { maxHeight: COLLAPSED_HEIGHT } : undefined}
      >
        {head === null ? null : (
          <View className="gap-0.5">
            <Text
              accessibilityRole="header"
              className="text-foreground"
              style={{
                fontFamily: GREETING_FONT,
                fontStyle: "italic",
                fontSize: 30,
                lineHeight: 36,
              }}
            >
              {head.greeting}
            </Text>
            <Text textRole="caption" className="text-foreground-muted">
              {head.date}
            </Text>
          </View>
        )}
        {view.lead === null ? null : <KinPageText {...text} markdown={view.lead} />}
        {sections.map((section) => (
          <KinPageSection
            key={`${section.title}:${section.markdown.slice(0, 48)}`}
            {...text}
            title={section.title}
            markdown={section.markdown}
          />
        ))}
      </View>
      {cut === null ? null : (
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded(true)}
          hitSlop={8}
          className="min-h-11 justify-center self-start active:opacity-60"
        >
          <Text textRole="body" className="font-t3-medium text-primary">
            {cut.label}
          </Text>
        </Pressable>
      )}
      {foot === undefined || foot === null ? null : <View className="pt-1">{foot}</View>}
    </View>
  );
}
