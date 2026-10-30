import { and, eq } from "drizzle-orm";
import { projects, projectMembers, user, invitations } from "../../../db/schema";
import { ApiError } from "../../../shared/http";
import { EMAIL_RE } from "../../../shared/validate";
import { requireProjectPermission } from "../../access/index";
import type { Ctx } from "../../access/index";
import type { Input } from "../../../shared/route";
import { validateInvitation, markInvitationAccepted, hashInviteToken, generateInviteToken } from "../invite";
import { renderTemplate, htmlToText, getTransport } from "../../notifications/index";

// Project invitations (by e-mail).
export async function listInvitations(ctx: Ctx, input: Input) {
  const projectId = input.p.id;
  const u = ctx.user;
  await requireProjectPermission(ctx.db, u, projectId, "MANAGE_MEMBERS");
  const rows = await ctx.db
    .select({
      id: invitations.id,
      email: invitations.email,
      invitedRole: invitations.invitedRole,
      expiresAt: invitations.expiresAt,
      acceptedAt: invitations.acceptedAt,
      createdAt: invitations.createdAt,
    })
    .from(invitations)
    .where(eq(invitations.projectId, projectId));
  return rows;
}

export async function inviteToProject(ctx: Ctx, input: Input) {
  // The rate-limit middleware widens Hono's inferred param type.
  const projectId = input.p.id as string;
  const u = ctx.user;
  const access = await requireProjectPermission(ctx.db, u, projectId, "MANAGE_MEMBERS");

  const body = await input.body<{ email?: string; role?: "ADMIN" | "MEMBER" }>();
  const email = body.email?.trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) throw new ApiError(400, "Valid e-mail address is required");
  const invitedRole = body.role === "ADMIN" ? "ADMIN" : "MEMBER";
  // A MEMBER granted MANAGE_MEMBERS may invite other MEMBERs, but only an
  // actual project/super admin can grant the ADMIN role via invite.
  if (invitedRole === "ADMIN" && access.role !== "ADMIN") {
    throw new ApiError(403, "Only a project admin can invite someone as an admin");
  }

  const [project] = await ctx.db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId));
  if (!project) throw new ApiError(404, "Project not found");

  const [existingUser] = await ctx.db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (existingUser) {
    const [member] = await ctx.db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, existingUser.id)));
    if (member) throw new ApiError(409, "This user is already a member of the project");
  }

  const pending = await ctx.db
    .select({ id: invitations.id })
    .from(invitations)
    .where(and(eq(invitations.projectId, projectId), eq(invitations.email, email)));
  if (pending.length > 0) throw new ApiError(409, "An invitation for this e-mail is already pending");

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const token = btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  const { tokenHash, expiresAt } = await hashInviteToken(token);

  const [invitation] = await ctx.db
    .insert(invitations)
    .values({
      id: crypto.randomUUID(),
      projectId,
      email,
      tokenHash,
      invitedRole,
      expiresAt,
      createdBy: u.id,
      createdAt: Date.now(),
    })
    .returning();

  const inviteUrl = `${ctx.env.APP_URL}/accept-invite?token=${token}`;
  const html = renderTemplate("invite", {
    name: email.split("@")[0],
    project: project.name,
    role: invitedRole,
    invite_url: inviteUrl,
  });

  const transport = await getTransport(ctx.env);
  await transport.send({
    to: email,
    subject: `You have been invited to ${project.name}`,
    html,
    text: htmlToText(html),
  });

  return {
      invitation: {
        id: invitation.id,
        email: invitation.email,
        invitedRole: invitation.invitedRole,
        expiresAt: invitation.expiresAt,
      },
      inviteUrl,
    };
}
