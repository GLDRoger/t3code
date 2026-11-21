import type { OrchestratorToolkit } from "../../mcp/toolkits/orchestrator/tools.ts";
import type { ProjectToolkit } from "../../mcp/toolkits/project/tools.ts";
import type { PullRequestsToolkit } from "../../mcp/toolkits/pullRequests/tools.ts";
import type { WorktreeToolkit } from "../../mcp/toolkits/worktree/tools.ts";
import type { PreviewToolkit } from "../../mcp/toolkits/preview/tools.ts";
import type { PreviewControlsToolkit } from "../../mcp/toolkits/previewControls/tools.ts";
import type { DeviceToolkit } from "../../mcp/toolkits/device/tools.ts";
import type { HtmlToolkit } from "../../mcp/toolkits/html/tools.ts";
import type { AttachmentToolkit } from "../../mcp/toolkits/attachment/tools.ts";
import type { EnvironmentToolkit } from "../../mcp/toolkits/environment/tools.ts";
import type { ThreadToolkit } from "../../mcp/toolkits/thread/tools.ts";

type T3Tool =
  | keyof (typeof OrchestratorToolkit)["tools"]
  | keyof (typeof ProjectToolkit)["tools"]
  | keyof (typeof PullRequestsToolkit)["tools"]
  | keyof (typeof WorktreeToolkit)["tools"]
  | keyof (typeof PreviewToolkit)["tools"]
  | keyof (typeof PreviewControlsToolkit)["tools"]
  | keyof (typeof DeviceToolkit)["tools"]
  | keyof (typeof HtmlToolkit)["tools"]
  | keyof (typeof AttachmentToolkit)["tools"]
  | keyof (typeof EnvironmentToolkit)["tools"]
  | keyof (typeof ThreadToolkit)["tools"];

/**
 * The T3 tools a Kin agent gets in a turn only the owner reads, once his GitHub is connected:
 * projects, clone, worktrees, delegated tasks, PR links and watches, browser and devices. Not
 * scheduling, new top-level threads, secret requests or environment links: those start or change
 * work outside Kin's chats, where no reply or audience check follows them.
 */
export const LEAD_T3_TOOLS = [
  "orchestrator_capabilities",
  "delegate_task",
  "task_status",
  "task_cancel",
  "t3_workflow_stop",
  "t3_background_wait",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_send",
  "t3_thread_wait",
  "t3_thread_interrupt",
  "t3_pending_request",
  "t3_environment_links",
  "t3_environment_read",
  "t3_project_list",
  "t3_project_read",
  "t3_project_create",
  "t3_project_update",
  "t3_project_delete",
  "t3_project_clone",
  "t3_worktree_handoff",
  "t3_worktree_status",
  "t3_worktree_list",
  "link_pull_request",
  "link_pull_requests",
  "unlink_pull_request",
  "unlink_pull_requests",
  "list_thread_pull_requests",
  "watch_pull_request",
  "unwatch_pull_request",
  "write_pull_request_guides",
  "read_pull_request_guide",
  "preview_status",
  "preview_open",
  "preview_dialog",
  "preview_navigate",
  "preview_resize",
  "preview_set_appearance",
  "preview_snapshot",
  "preview_act",
  "preview_evaluate",
  "preview_wait_for",
  "preview_recording_start",
  "preview_recording_stop",
  "t3_preview_list",
  "t3_preview_close",
  "device_list",
  "device_open",
  "device_screenshot",
  "device_close",
  "html_preview",
  "html_render",
  "t3_attachment_prepare_upload",
  "t3_attachment_discard",
  "t3_thread_send_attachments",
] as const satisfies ReadonlyArray<T3Tool>;

/**
 * The lead T3 tools that only write and ship code: listed to an engineering lead alone. Every
 * other lead delegates code with delegate_task, and its tasks keep all of `LEAD_T3_TOOLS`.
 */
export const CODING_T3_TOOLS = [
  "t3_project_create",
  "t3_project_update",
  "t3_project_delete",
  "t3_project_clone",
  "t3_worktree_handoff",
  "t3_worktree_status",
  "t3_worktree_list",
  "link_pull_request",
  "link_pull_requests",
  "unlink_pull_request",
  "unlink_pull_requests",
  "list_thread_pull_requests",
  "watch_pull_request",
  "unwatch_pull_request",
  "write_pull_request_guides",
  "read_pull_request_guide",
  "preview_status",
  "preview_open",
  "preview_dialog",
  "preview_navigate",
  "preview_resize",
  "preview_set_appearance",
  "preview_snapshot",
  "preview_act",
  "preview_evaluate",
  "preview_wait_for",
  "preview_recording_start",
  "preview_recording_stop",
  "t3_preview_list",
  "t3_preview_close",
  "device_list",
  "device_open",
  "device_screenshot",
  "device_close",
] as const satisfies ReadonlyArray<(typeof LEAD_T3_TOOLS)[number]>;

/** A remit that builds software: the leads that see `CODING_T3_TOOLS`. */
export const isEngineeringDomain = (domain: string) =>
  /^(engineering|tech|dev|software)/.test(domain);
