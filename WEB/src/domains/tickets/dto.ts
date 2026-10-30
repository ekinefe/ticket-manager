import type { TaskUpdateBody } from "./actions/update";

// Request body shapes accepted by the routes of this domain (all fields optional;
// the actions validate them).
export interface CreateTaskBody { title?: string; description?: string; status?: string; assigneeId?: string; type?: string; priority?: string; sprintId?: string | null; labels?: string[]; dueDate?: string | null }

export interface BulkUpdateTasksBody { taskIds?: string[]; update?: TaskUpdateBody }

export interface BulkDeleteTasksBody { taskIds?: string[] }

export interface AddCommentBody { body?: string }

export interface SetTaskShareBody { mode?: string; regenerate?: boolean }
