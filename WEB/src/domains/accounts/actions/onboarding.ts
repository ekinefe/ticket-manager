import { and, eq, count } from "drizzle-orm";
import { projectMembers, user, accountInvites } from "../../../db/schema";
import { ApiError } from "../../../shared/http";
import { EMAIL_RE } from "../../../shared/validate";
import { ensureDefaultMemberPermissions, requireSuperAdmin } from "../../access/index";
import { createProjectNotification } from "../../notifications/index";
import type { Ctx, PublicCtx } from "../../access/index";
import type { Input } from "../../../shared/route";
import { createAuth } from "../../../auth/server";
import { internalSignupSecret } from "../../../shared/signup-secret";
import { validateInvitation, markInvitationAccepted, hashInviteToken, generateInviteToken } from "../../projects/index";
import { renderTemplate, htmlToText, getTransport } from "../../notifications/index";
import { hasPendingAccountInvite, validateAccountInvite, markAccountInviteAccepted } from "../account-invite";
import type { CompleteSetupBody, AcceptInvitationBody, InviteAccountBody } from "../dto";

// First-run setup (creates the initial SUPER_ADMIN, one-time) and invitation acceptance.
export async function setupStatus(ctx: PublicCtx, _input: Input) {
  const [{ superAdminCount }] = await ctx.db
    .select({ superAdminCount: count() })
    .from(user)
    .where(eq(user.role, "SUPER_ADMIN"));
  return { needed: Number(superAdminCount) === 0 };
}

export async function completeSetup(ctx: PublicCtx, input: Input) {
  const [{ superAdminCount }] = await ctx.db
    .select({ superAdminCount: count() })
    .from(user)
    .where(eq(user.role, "SUPER_ADMIN"));
  if (Number(superAdminCount) > 0) throw new ApiError(409, "Super admin already exists");

  const body = await input.body<CompleteSetupBody>();
  const email = body.email?.trim().toLowerCase();
  const name = body.name?.trim();
  const password = body.password ?? "";
  if (!email || !EMAIL_RE.test(email)) throw new ApiError(400, "A valid e-mail address is required");
  if (!name) throw new ApiError(400, "Name is required");
  if (!password || password.length < 8) throw new ApiError(400, "Password must be at least 8 characters");

  const auth = createAuth(ctx.env);
  const internalHeaders = new Headers({ "x-internal-signup": internalSignupSecret() });
  let userId: string;
  try {
    const result = await auth.api.signUpEmail({
      headers: internalHeaders,
      body: { email, name, password },
    });
    userId = result.user.id;
  } catch (e) {
    console.error("setup/complete signup failed:", e);
    throw new ApiError(409, `Could not create admin account: ${e instanceof Error ? e.message : "unknown error"}`);
  }

  await ctx.db
    .update(user)
    .set({ role: "SUPER_ADMIN", updatedAt: new Date() })
    .where(eq(user.id, userId));

  return { ok: true, email, role: "SUPER_ADMIN" };
}

export async function acceptInvitation(ctx: PublicCtx, input: Input) {
  const body = await input.body<AcceptInvitationBody>();
  if (!body.token) throw new ApiError(400, "Missing invite token");
  const name = body.name?.trim();
  if (!name) throw new ApiError(400, "Name is required");
  const password = body.password;
  if (!password || password.length < 8) throw new ApiError(400, "Password must be at least 8 characters");

  const auth = createAuth(ctx.env);
  const internalHeaders = new Headers({ "x-internal-signup": internalSignupSecret() });
  const signUp = async (email: string) => {
    const result = await auth.api.signUpEmail({
      headers: internalHeaders,
      body: { email, name, password },
    });
    return result.user.id;
  };

  // Project invitation
  let projectInvitation;
  try {
    projectInvitation = await validateInvitation(ctx.db, body.token);
  } catch {
    projectInvitation = null;
  }

  if (projectInvitation) {
    const [existingUser] = await ctx.db.select({ id: user.id }).from(user).where(eq(user.email, projectInvitation.email));
    const userId = existingUser ? existingUser.id : await signUp(projectInvitation.email);

    const [alreadyMember] = await ctx.db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.userId, userId), eq(projectMembers.projectId, projectInvitation.projectId)));

    if (!alreadyMember) {
      await ctx.db.insert(projectMembers).values({
        projectId: projectInvitation.projectId,
        userId,
        role: projectInvitation.invitedRole,
      });
      await ensureDefaultMemberPermissions(ctx.db, projectInvitation.projectId, userId, projectInvitation.invitedRole);
      await createProjectNotification({
        db: ctx.db,
        projectId: projectInvitation.projectId,
        actorId: userId,
        type: "MEMBER_ADDED",
        message: `${projectInvitation.email} joined the project as ${projectInvitation.invitedRole}`,
      }).catch((e) => console.error("notification failed:", e));
    }

    await markInvitationAccepted(ctx.db, projectInvitation.id);
    return { ok: true, projectId: projectInvitation.projectId };
  }

  // Standalone account invitation (no project membership)
  const accountInvite = await validateAccountInvite(ctx.db, body.token);
  const [existingUser] = await ctx.db.select({ id: user.id }).from(user).where(eq(user.email, accountInvite.email));
  if (!existingUser) await signUp(accountInvite.email);
  await markAccountInviteAccepted(ctx.db, accountInvite.id);
  return { ok: true, projectId: null };
}

export async function inviteAccount(ctx: Ctx, input: Input) {
  const u = ctx.user;
  requireSuperAdmin(u);

  const body = await input.body<InviteAccountBody>();
  const email = body.email?.trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "A valid e-mail address is required");

  const [existingUser] = await ctx.db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (existingUser) throw new ApiError(409, "An account with this e-mail already exists");
  if (await hasPendingAccountInvite(ctx.db, email)) throw new ApiError(409, "An invitation for this e-mail is already pending");

  const { token, expiresAt } = generateInviteToken();
  const { tokenHash } = await hashInviteToken(token);
  const [invite] = await ctx.db
    .insert(accountInvites)
    .values({ id: crypto.randomUUID(), email, tokenHash, expiresAt, createdBy: u.id, createdAt: Date.now() })
    .returning();

  // The raw token exists only in the link; the DB stores its SHA-256 hash.
  const inviteUrl = `${ctx.env.APP_URL}/accept-invite?token=${token}`;
  const html = renderTemplate("account-invite", {
    name: email.split("@")[0],
    invite_url: inviteUrl,
  });

  const transport = await getTransport(ctx.env);
  await transport.send({
    to: email,
    subject: "You have been invited to Ticket Manager",
    html,
    text: htmlToText(html),
  });

  return {
      invite: { id: invite.id, email: invite.email, expiresAt: invite.expiresAt },
      inviteUrl,
    };
}
