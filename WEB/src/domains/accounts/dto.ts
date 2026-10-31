// Request body shapes accepted by the routes of this domain (all fields optional;
// the actions validate them).
export interface RequestPasswordResetBody { email?: string }

export interface ResetPasswordBody { token?: string; password?: string }

export interface ChangeOwnPasswordBody { currentPassword?: string; newPassword?: string }

export interface UpdateProfileBody { name?: string }

export interface SetLanguageBody { language?: string }

export interface CompleteSetupBody { email?: string; name?: string; password?: string }

export interface AcceptInvitationBody { token?: string; name?: string; password?: string }

export interface InviteAccountBody { email?: string }
