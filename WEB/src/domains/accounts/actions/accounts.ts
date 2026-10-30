import { and, eq, or } from "drizzle-orm";
import { user } from "../../../db/schema";
import { ApiError } from "../../../shared/http";
import { EMAIL_RE } from "../../../shared/validate";
import { renderTemplate, htmlToText, getTransport } from "../../notifications/index";
import { applyPasswordReset, createPasswordReset, findUserIdByEmail, hasPendingPasswordReset, validatePasswordReset, changePassword, verifyUserPassword } from "../password-reset";
import type { Ctx, PublicCtx } from "../../access/index";
import type { Input } from "../../../shared/route";
import type { RequestPasswordResetBody, ResetPasswordBody, ChangeOwnPasswordBody, SetLanguageBody } from "../dto";

// Self-service account actions: password reset (public), password change, UI language.
export async function requestPasswordReset(ctx: PublicCtx, input: Input) {
  const body = await input.body<RequestPasswordResetBody>();
  const email = body.email?.trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) throw new ApiError(400, "A valid e-mail address is required");

  // No account enumeration: the response is identical whether or not the
  // account exists and whether or not a reset is already pending.
  const userId = await findUserIdByEmail(ctx.db, email);
  if (userId && !(await hasPendingPasswordReset(ctx.db, userId))) {
    const { token } = await createPasswordReset(ctx.db, userId);
    const resetUrl = `${ctx.env.APP_URL}/reset-password?token=${token}`;
    const html = renderTemplate("reset-password", {
      name: email.split("@")[0],
      reset_url: resetUrl,
    });
    const transport = await getTransport(ctx.env);
    await transport.send({
      to: email,
      subject: "Reset your Ticket Manager password",
      html,
      text: htmlToText(html),
    });
  }
  return { ok: true };
}

export async function resetPassword(ctx: PublicCtx, input: Input) {
  const body = await input.body<ResetPasswordBody>();
  const userId = await validatePasswordReset(ctx.db, body.token ?? "");
  await applyPasswordReset(ctx.db, userId, body.password ?? "");
  await ctx.db.update(user).set({ mustChangePassword: false, updatedAt: new Date() }).where(eq(user.id, userId));
  return { ok: true };
}

export async function changeOwnPassword(ctx: Ctx, input: Input) {
  const u = ctx.user;
  const body = await input.body<ChangeOwnPasswordBody>();
  if (!body.currentPassword) throw new ApiError(400, "Current password is required");
  if (!body.newPassword || body.newPassword.length < 8) {
    throw new ApiError(400, "New password must be at least 8 characters");
  }
  const ok = await verifyUserPassword(ctx.db, u.id, body.currentPassword);
  if (!ok) throw new ApiError(400, "Current password is incorrect");
  await changePassword(ctx.db, u.id, body.newPassword);
  await ctx.db.update(user).set({ mustChangePassword: false, updatedAt: new Date() }).where(eq(user.id, u.id));
  return { ok: true };
}

export async function setLanguage(ctx: Ctx, input: Input) {
  const u = ctx.user;
  const body = await input.body<SetLanguageBody>();
  if (body.language !== "en" && body.language !== "tr") throw new ApiError(400, "Unsupported language");
  await ctx.db.update(user).set({ language: body.language, updatedAt: new Date() }).where(eq(user.id, u.id));
  return { ok: true, language: body.language };
}
