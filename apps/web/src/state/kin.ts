import { WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const kinProfiles = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:kin:profiles",
  tag: WS_METHODS.kinProfilesList,
});

export const kinProfileSource = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:kin:profile-source",
  tag: WS_METHODS.kinProfilesRead,
});

export const kinBasePrompt = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:kin:base-prompt",
  tag: WS_METHODS.kinBasePromptGet,
});

export const kinMdFiles = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:kin:md",
  tag: WS_METHODS.kinMdList,
});

export const kinMdSource = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:kin:md-source",
  tag: WS_METHODS.kinMdRead,
});

export const kinPromptPreview = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:kin:prompt-preview",
  tag: WS_METHODS.kinPromptPreview,
});

export const kinRouting = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:kin:routing",
  tag: WS_METHODS.kinRoutingGet,
});

export const writeKinProfile = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:kin:write-profile",
  tag: WS_METHODS.kinProfilesWrite,
});

export const writeKinBasePrompt = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:kin:write-base-prompt",
  tag: WS_METHODS.kinBasePromptSet,
});

export const writeKinMd = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:kin:write-md",
  tag: WS_METHODS.kinMdWrite,
});

export const deleteKinMd = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:kin:delete-md",
  tag: WS_METHODS.kinMdDelete,
});

export const updateKinRouting = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:kin:update-routing",
  tag: WS_METHODS.kinRoutingUpdate,
});
