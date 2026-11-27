import type { KinPromiseView } from "@t3tools/client-runtime/kin/kinPromises";
import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { Button } from "../components/ui/button";

/**
 * Where a promise was made, under its row: the chat message opens where the reader may read it;
 * a meeting, a mail or typed words read as words.
 */
export function KinPromiseFrom(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly promise: KinPromiseView | null;
}) {
  const navigate = useNavigate();
  const { promise } = props;
  if (promise === null || promise.from === null) return null;
  const { open } = promise;
  return (
    <p className="ps-10 pb-1 text-xs text-muted-foreground">
      {open === null ? (
        promise.from
      ) : (
        <Button
          size="xs"
          variant="link"
          onClick={() =>
            void navigate({
              to: "/kin/$environmentId/$orgId/$chatId",
              params: {
                environmentId: props.environmentId,
                orgId: props.orgId,
                chatId: open.chatId,
              },
              search: { message: open.messageId },
            })
          }
        >
          {promise.from}
        </Button>
      )}
    </p>
  );
}
