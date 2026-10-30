// Request body shapes accepted by the routes of this domain (all fields optional;
// the actions validate them).
export interface CreateUserBody { name?: string; email?: string; password?: string; role?: string }

export interface SetUserRoleBody { role?: string }

export interface SetUserPasswordBody { password?: string }

export interface AddUserToProjectBody { projectId?: string; role?: string }

export interface SetUserProjectPermissionsBody { permissions?: string[] }

export interface SetMemberPermissionsAdminBody { permissions?: string[] }

export interface AddProjectMemberBody { userId?: string; role?: string }
