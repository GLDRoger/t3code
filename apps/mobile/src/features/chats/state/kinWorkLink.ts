import { CommonActions, StackActions, useNavigation } from "@react-navigation/native";

type Params = ReactNavigation.RootParamList;
type RecordRoute = "KinWorkItem" | "KinClient" | "KinProject" | "KinDoc";

const RECORDS: ReadonlySet<string> = new Set<RecordRoute>([
  "KinWorkItem",
  "KinClient",
  "KinProject",
  "KinDoc",
]);

/**
 * Opens a task, client, project or doc. Followed from inside one, it takes the place of every
 * record above the place it was opened from, so Work never stacks more than a place, one record
 * and a form, and Back returns to where the person started.
 */
export function useKinWorkLink() {
  const navigation = useNavigation();
  return <Name extends RecordRoute | "KinWork">(name: Name, params: Params[Name]) => {
    const state = navigation.getState();
    const routes = state?.routes ?? [];
    let keep = routes.length;
    while (keep > 0 && RECORDS.has(routes[keep - 1]?.name ?? "")) keep -= 1;
    if (state === undefined || keep === routes.length) {
      navigation.dispatch(StackActions.push(name, params));
      return;
    }
    navigation.dispatch(
      CommonActions.reset({
        ...state,
        index: keep,
        routes: [...routes.slice(0, keep), { name, params }],
      }),
    );
  };
}
