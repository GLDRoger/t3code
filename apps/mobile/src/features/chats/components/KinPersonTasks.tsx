import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { KIN_PERSON_TASKS, kinTaskLine } from "@t3tools/client-runtime/kin/kinTasksList";
import type { KinPersonId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { ListRow } from "../../../components/ui/ListRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { ListSection } from "../../../components/ui/ListSection";
import { useNowMinuteMs } from "../../../lib/clock";
import { kinClient } from "../state/kinClient";
import { useKinWorkDirectory, type KinWorkTarget } from "../state/useKinWork";

/**
 * A person's page lists what they hold or are on: the five most urgent open tasks the reader sees, in
 * Tasks' own order, then the way to all of them in Tasks. `children` follow, such as Give all.
 */
export function KinPersonTasks(
  props: KinWorkTarget & {
    readonly personId: KinPersonId;
    readonly footer?: string;
    readonly children?: ReactNode;
  },
) {
  const navigation = useNavigation();
  const { environmentId, orgId } = props;
  const result = useAtomValue(
    kinClient.personTasks({ environmentId, input: { orgId, person: props.personId } }),
  );
  const { names } = useKinWorkDirectory(props, true);
  const now = new Date(useNowMinuteMs());
  const base = { environmentId: String(environmentId), orgId: String(orgId) };
  const held = AsyncResult.isSuccess(result) ? result.value : null;
  return (
    <ListSection
      title={KIN_PERSON_TASKS.title}
      {...(props.footer === undefined ? {} : { footer: props.footer })}
    >
      {AsyncResult.isFailure(result) ? (
        <ListRowLayout label={KIN_PERSON_TASKS.failed} />
      ) : held === null ? (
        <View className="items-center py-4">
          <AppActivityIndicator />
        </View>
      ) : held.total === 0 ? (
        <ListRowLayout label={KIN_PERSON_TASKS.none} />
      ) : (
        <>
          {held.records.map((record) => {
            const line = kinTaskLine(record, names, now);
            const said = [line.lead?.text ?? null, line.rest === "" ? null : line.rest]
              .filter((part) => part !== null)
              .join(" · ");
            return (
              <ListRow
                key={record.key}
                label={record.title}
                {...(said === "" ? {} : { description: said })}
                onPress={() => navigation.navigate("KinWorkItem", { ...base, task: record.key })}
              />
            );
          })}
          <ListRow
            icon="checkmark.circle"
            label={KIN_PERSON_TASKS.seeAll}
            detail={held.count}
            onPress={() =>
              navigation.navigate("KinWork", { ...base, show: "tasks", person: props.personId })
            }
          />
        </>
      )}
      {props.children}
    </ListSection>
  );
}
