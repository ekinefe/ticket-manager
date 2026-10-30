import { appSettings } from "../../db/schema";

export async function loadGithubSettings(env: Env): Promise<void> {
  const rows = await env.DB.select().from(appSettings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  if (map.get("github_app_id")) env.GITHUB_APP_ID = map.get("github_app_id")!;
  if (map.get("github_private_key")) env.GITHUB_APP_PRIVATE_KEY = map.get("github_private_key")!;
  if (map.get("github_webhook_secret")) env.GITHUB_WEBHOOK_SECRET = map.get("github_webhook_secret")!;
  env.GITHUB_BRANCH_CREATE = map.get("github_branch_create") === "1" ? "1" : "";
}

// Read all settings from the DB and override the matching env fields.
// Loaded once at startup (by the local or the Workers bootstrap) and again
// whenever settings are saved via the admin panel.
export async function loadSettings(env: Env): Promise<void> {
  const rows = await env.DB.select().from(appSettings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  if (map.get("app_url")) env.APP_URL = map.get("app_url")!;
  if (map.get("better_auth_secret")) env.BETTER_AUTH_SECRET = map.get("better_auth_secret")!;
  if (map.get("mail_transport")) env.MAIL_TRANSPORT = map.get("mail_transport") as Env["MAIL_TRANSPORT"];
  if (map.get("mail_from")) env.MAIL_FROM = map.get("mail_from")!;
  if (map.get("resend_api_key")) env.RESEND_API_KEY = map.get("resend_api_key")!;
  if (map.get("github_app_id")) env.GITHUB_APP_ID = map.get("github_app_id")!;
  if (map.get("github_private_key")) env.GITHUB_APP_PRIVATE_KEY = map.get("github_private_key")!;
  if (map.get("github_webhook_secret")) env.GITHUB_WEBHOOK_SECRET = map.get("github_webhook_secret")!;
  // The toggle must be able to switch OFF, so it always follows the DB value.
  env.GITHUB_BRANCH_CREATE = map.get("github_branch_create") === "1" ? "1" : "";
}
