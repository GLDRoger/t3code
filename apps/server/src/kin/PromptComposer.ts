/**
 * Prompt order is fixed so the prefix stays byte-identical for agents that
 * share a profile and a house. The brief is last and is the only per-task part.
 * Nothing in this module reads the clock.
 */

export interface KinPromptParts {
  readonly runtimeInstructions: string;
  readonly kinBasePrompt: string;
  readonly profileBody: string;
  readonly userMdTexts: ReadonlyArray<string>;
  readonly stableHouseContext: string;
}

const normalize = (text: string): string => text.replaceAll("\r\n", "\n").trim();

const joinSections = (sections: ReadonlyArray<string>): string =>
  sections
    .map(normalize)
    .filter((section) => section.length > 0)
    .join("\n\n");

export function composeStablePrefix(parts: KinPromptParts): string {
  return joinSections([
    parts.runtimeInstructions,
    parts.kinBasePrompt,
    parts.profileBody,
    ...parts.userMdTexts,
    parts.stableHouseContext,
  ]);
}

function composeKinSuffix(
  parts: Omit<KinPromptParts, "runtimeInstructions"> & {
    readonly brief: string;
  },
): string {
  return joinSections([
    parts.kinBasePrompt,
    parts.profileBody,
    ...parts.userMdTexts,
    parts.stableHouseContext,
    parts.brief,
  ]);
}

export function composePrompt(parts: KinPromptParts & { readonly brief: string }): {
  readonly prefix: string;
  readonly text: string;
  readonly suffix: string;
} {
  const prefix = composeStablePrefix(parts);
  const suffix = composeKinSuffix(parts);
  const text = joinSections([prefix, parts.brief]);
  return { prefix, text, suffix };
}

/** House-line brief, then the keeper slot, then the task. The prefix is untouched. */
export function composeOrderedPrompt(input: {
  readonly prefix: string;
  readonly houseLine: string;
  readonly keeper: string;
  readonly task: string;
}): { readonly prefix: string; readonly brief: string; readonly prompt: string } {
  const brief = [input.houseLine.trim(), input.keeper.trim()]
    .filter((section) => section.length > 0)
    .join("\n\n");
  const prompt =
    brief.length === 0
      ? `${input.prefix}\n\n${input.task}`
      : `${input.prefix}\n\n${brief}\n\n${input.task}`;
  return { prefix: input.prefix, brief, prompt };
}
