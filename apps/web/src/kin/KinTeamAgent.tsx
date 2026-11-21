import { useAtomValue } from "@effect/atom-react";
import {
  KIN_COMPANY_CHAT_COPY,
  KIN_TEAM_AGENT_COPY,
  kinTeamAgentChoices,
} from "@t3tools/client-runtime/kin/kinProfiles";
import { kinTeamAgentDetail } from "@t3tools/client-runtime/kin/kinReach";
import { KIN_TEAM_PAGE } from "@t3tools/client-runtime/kin/kinTeam";
import { KinAgentId, type EnvironmentId, type KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { KinSettingsChoice, useKinSettingsSave } from "./settings/KinSettingsControls";
import { KinSettingsRow, KinSettingsSection } from "./settings/KinSettingsLayout";

const OFF = "off";

/**
 * Settings → Team's "Talk to": the agent everyone can chat with, and the company chat with the
 * agent that answers in it. Each choice saves the moment it is picked.
 */
export function KinTalkToSection(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const { environmentId, orgId } = props;
  const leadsAtom = kinClient.leads({ environmentId, input: { orgId } });
  const held = Option.getOrNull(AsyncResult.value(useAtomValue(leadsAtom)));
  const reach = useAtomValue(kinClient.reach({ environmentId, input: { orgId } }));
  const setTeamAgent = useAtomCommand(kinClient.teamAgentSet, { reportFailure: false });
  const setCompany = useAtomCommand(kinClient.groupSetCompany, { reportFailure: false });
  const save = useKinSettingsSave();
  // What was just picked, shown until the host's next read agrees or refuses.
  const [picked, setPicked] = useState<{ readonly key: string; readonly value: string } | null>(
    null,
  );
  if (held === null) return null;
  const choices = kinTeamAgentChoices(held.leads);
  const teamAgent = held.teamAgentId ?? null;
  const companyAgent = held.companyChat?.leadAgentId ?? null;
  const shown = (key: string, current: string | null) =>
    picked?.key === key ? picked.value : (current ?? OFF);
  const options = (current: string | null, suggest: boolean) =>
    choices.map((choice) => ({
      value: choice.agentId ?? OFF,
      label:
        suggest && choice.suggested && choice.agentId !== current
          ? KIN_TEAM_PAGE.suggested(choice.label)
          : choice.label,
    }));
  const pick = async (
    key: string,
    value: string,
    failed: string,
    sent: Parameters<typeof save.run>[2],
  ) => {
    setPicked({ key, value });
    await save.run(key, failed, sent);
    appAtomRegistry.refresh(leadsAtom);
    setPicked(null);
  };
  const restricted =
    kinTeamAgentDetail(Option.getOrNull(AsyncResult.value(reach)), teamAgent) !==
    KIN_TEAM_AGENT_COPY.detail;
  return (
    <KinSettingsSection title={KIN_TEAM_PAGE.talkTo} problem={save.problem}>
      <KinSettingsRow
        title={KIN_TEAM_AGENT_COPY.label}
        wrap
        detail={restricted ? KIN_TEAM_PAGE.teamAgentRestricted : KIN_TEAM_PAGE.teamAgentDetail}
        control={
          <KinSettingsChoice
            label={KIN_TEAM_AGENT_COPY.label}
            value={shown("team-agent", teamAgent)}
            options={options(teamAgent, true)}
            disabled={save.busy !== null}
            onChange={(value) =>
              void pick("team-agent", value, KIN_TEAM_AGENT_COPY.failed, () =>
                setTeamAgent({
                  environmentId,
                  input: { orgId, agentId: value === OFF ? null : KinAgentId.make(value) },
                }),
              )
            }
          />
        }
      />
      <KinSettingsRow
        title={KIN_COMPANY_CHAT_COPY.label}
        wrap
        detail={KIN_TEAM_PAGE.companyChatDetail}
        control={
          <KinSettingsChoice
            label={KIN_COMPANY_CHAT_COPY.label}
            value={shown("company-chat", companyAgent)}
            options={options(companyAgent, false)}
            disabled={save.busy !== null}
            onChange={(value) =>
              void pick("company-chat", value, KIN_COMPANY_CHAT_COPY.failed, () =>
                setCompany({
                  environmentId,
                  input: { orgId, leadAgentId: value === OFF ? null : KinAgentId.make(value) },
                }),
              )
            }
          />
        }
      />
    </KinSettingsSection>
  );
}
