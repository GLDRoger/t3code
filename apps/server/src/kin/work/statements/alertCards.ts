/** Kin's own bank alert cards, by id. The server answers them, so a tap on one wakes no agent. */
export const SENDER_CARD = "kin-bank-alert-sender:";
export const PAY_CARD = "kin-bank-alert-pay:";
export const isAlertCard = (widgetId: string) =>
  widgetId.startsWith(SENDER_CARD) || widgetId.startsWith(PAY_CARD);
