/**
 * The sales seat's tools in a turn others read (`SharedTools.ts`) and after outside text
 * (`OutsideContent.ts`). `pipeline_read` shapes every figure to the turn's people; `web_page`
 * reads only public pages, marks the turn outside-read, and changes nothing.
 */
export const SALES_SHARED_TOOLS = { pipeline_read: "view", web_page: "allowed" } as const;
export const SALES_OUTSIDE_TOOLS = { pipeline_read: "allowed", web_page: "allowed" } as const;
