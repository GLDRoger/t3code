import { KIN_CANVAS } from "@t3tools/client-runtime/kin/kinCanvasView";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";

/** Ask about what is chosen: one item per agent this person can message. */
export function AskMenu(props: {
  readonly leads: ReadonlyArray<{
    readonly agentId: string;
    readonly name: string;
    readonly ownerChatId: string;
  }>;
  readonly onAsk: (agent: { readonly ownerChatId: string }) => void;
  readonly label?: string;
  readonly variant?: "default" | "outline";
}) {
  if (props.leads.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant={props.variant ?? "default"} />}>
        {props.label ?? KIN_CANVAS.ask}
      </MenuTrigger>
      <MenuPopup align="center">
        {props.leads.map((lead) => (
          <MenuItem key={lead.agentId} onClick={() => props.onAsk(lead)}>
            {lead.name}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
