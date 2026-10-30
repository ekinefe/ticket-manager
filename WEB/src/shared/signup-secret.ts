// Public sign-up is closed: accounts are created only through invitations or
// the admin panel. Internal flows pass this per-process secret as the
// `x-internal-signup` header when calling auth.api.signUpEmail directly.
export const INTERNAL_SIGNUP_SECRET = crypto.randomUUID();
