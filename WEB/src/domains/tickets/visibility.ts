import { ApiError } from "../../shared/http";
import type { ProjectAccess } from "../access/index";

// A MEMBER without VIEW_ALL_TICKETS only gets to see tickets that are theirs
// (assigned or created by them). 404, not 403: hides that the ticket exists
// at all, same as an unknown taskId would.
export function assertTaskVisible(
  access: ProjectAccess,
  u: { id: string },
  task: { assigneeId: string | null; createdBy: string | null }
): void {
  if (access.can("VIEW_ALL_TICKETS")) return;
  if (task.assigneeId === u.id || task.createdBy === u.id) return;
  throw new ApiError(404, "Task not found");
}
