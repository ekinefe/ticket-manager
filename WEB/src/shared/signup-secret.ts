// Public sign-up is closed: accounts are created only through invitations or
// the admin panel. Internal flows pass this per-process secret as the
// `x-internal-signup` header when calling auth.api.signUpEmail directly.
// Created lazily: Workers forbid random values in global scope, so a
// module-level crypto.randomUUID() fails the deploy validation.
let secret: string | undefined;
export function internalSignupSecret(): string {
  return (secret ??= crypto.randomUUID());
}
