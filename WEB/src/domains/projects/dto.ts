import type { SyncOptions } from "./project-sync";

// Request body shapes accepted by the routes of this domain (all fields optional;
// the actions validate them).
export interface InviteToProjectBody { email?: string; role?: "ADMIN" | "MEMBER" }

export interface CreateProjectBody { name?: string; prefix?: string }

export interface UpdateProjectBody { name?: string; prefix?: string; defaultAssigneeId?: string | null }

export interface SyncProjectBody { data?: unknown; options?: Partial<SyncOptions> & { fields?: Partial<SyncOptions["fields"]> }; apply?: boolean }

export interface ImportProjectBody {
    project?: { name?: string; prefix?: string };
    sprints?: { name?: string }[];
    tasks?: {
      title?: string;
      description?: string;
      status?: string;
      type?: string;
      priority?: string;
      sprint?: number | null;
      assigneeId?: string;
      labels?: string[];
      dueDate?: string | null;
    }[];
  }
