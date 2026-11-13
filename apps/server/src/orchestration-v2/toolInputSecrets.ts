import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

/**
 * A tool argument named as a password, such as a statement password the owner typed in chat and
 * a lead passed on, is replaced before any copy of the call is stored or logged.
 */

const REDACTED = "[REDACTED]";
const isSecretKey = (key: string) =>
  key
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase()
    .endsWith("password");

export const redactSecretArguments = (value: unknown, depth = 0): unknown => {
  if (value === null || typeof value !== "object" || depth > 32) return value;
  if (Array.isArray(value)) {
    const next = value.map((one) => redactSecretArguments(one, depth + 1));
    return next.every((one, index) => one === value[index]) ? value : next;
  }
  let changed = false;
  const next = Object.fromEntries(
    Object.entries(value).map(([key, nested]) => {
      const kept =
        isSecretKey(key) && nested !== null && nested !== undefined
          ? REDACTED
          : redactSecretArguments(nested, depth + 1);
      if (kept !== nested) changed = true;
      return [key, kept];
    }),
  );
  return changed ? next : value;
};

export function redactToolInputSecrets(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "dynamic_tool") return item;
  const input = redactSecretArguments(item.input);
  return input === item.input ? item : { ...item, input };
}
