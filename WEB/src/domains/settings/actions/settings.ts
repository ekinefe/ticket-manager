import { user, appSettings } from "../../../db/schema";
import { requireSuperAdmin } from "../../access/index";
import { loadSettings } from "../load";
import type { Ctx } from "../../access/index";
import type { Input } from "../../../shared/route";


// Settings are stored in the DB and applied to the runtime env on save so
// changes take effect without a server restart.
const SETTINGS_KEYS = [
  "app_url", "better_auth_secret", "mail_transport", "mail_from", "resend_api_key",
  "github_app_id", "github_private_key", "github_webhook_secret", "github_branch_create",
  "mail_notify_statuses",
] as const;

export async function getSettings(ctx: Ctx, _input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);
  const rows = await ctx.db.select().from(appSettings);
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.key] = r.value;
  return settings;
}

export async function updateSettings(ctx: Ctx, input: Input) {
  const actor = ctx.user;
  requireSuperAdmin(actor);
  const body = await input.body<Record<string, string>>();
  const now = Date.now();
  for (const key of SETTINGS_KEYS) {
    if (key in body) {
      const value = String(body[key] ?? "").trim();
      await ctx.db
        .insert(appSettings)
        .values({ key, value, updatedAt: now })
        .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } });
    }
  }
  // Apply changes to the running ctx.env immediately.
  await loadSettings(ctx.env);
  return { ok: true };
}
