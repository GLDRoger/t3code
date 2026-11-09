// Metro folds this condition before collecting dependencies, excluding the log from release bundles.
if (__DEV__ && process.env.EXPO_PUBLIC_KIN_DEV_LOG === "1") {
  require("./kinDevLog").installKinDevLog();
}
