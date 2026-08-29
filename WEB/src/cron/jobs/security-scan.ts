import { and, eq } from "drizzle-orm";
import { securityFindings } from "../../db/schema";
import { getDb } from "../../db/client";
import { listSuperAdminEmails } from "../../lib/rbac";
import { renderTemplate, htmlToText, escapeHtml, emptyRow } from "../../lib/mail/templates";
import { getTransport } from "../../lib/mail";
import { runOnce } from "../guard";

const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const OSV_VULN_URL = "https://api.osv.dev/v1/vulns/";

interface OsvVulnSummary {
  cve: string;
  packageName: string;
  severity: string;
  fixedVersion: string | null;
}

function parsePackages(spec?: string): { name: string; version: string }[] {
  try {
    return JSON.parse(spec ?? "[]").map((entry: string) => {
      const at = entry.lastIndexOf("@");
      if (at <= 0) throw new Error(`bad spec: ${entry}`);
      return { name: entry.slice(0, at), version: entry.slice(at + 1) };
    });
  } catch (e) {
    console.error("OSV_PACKAGES parse failed:", e);
    return [];
  }
}

function severityLabel(vuln: Record<string, unknown>): string {
  const sev =
    ((vuln.database_specific as Record<string, unknown> | undefined)?.severity as string | undefined) ??
    ((vuln.severity as { type?: string; score?: string }[] | undefined)?.[0]?.score as string | undefined) ??
    "UNKNOWN";
  return String(sev).toUpperCase();
}

function fixedVersion(vuln: Record<string, unknown>, packageName: string): string | null {
  const affected = vuln.affected as { package?: { name?: string }; ranges?: { events?: { fixed?: string }[] }[] }[] | undefined;
  for (const a of affected ?? []) {
    if (a.package?.name !== packageName) continue;
    for (const range of a.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) return event.fixed;
      }
    }
  }
  return null;
}

export async function runSecurityScan(env: Env, dateKey: string): Promise<void> {
  if (!(await runOnce(env, "security_scan", `${dateKey}`))) return;

  const packages = parsePackages(env.OSV_PACKAGES);
  if (packages.length === 0) return;

  const batchRes = await fetch(OSV_BATCH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queries: packages.map((p) => ({ package: { name: p.name, ecosystem: "npm" }, version: p.version })),
    }),
  });
  if (!batchRes.ok) throw new Error(`OSV querybatch failed: ${batchRes.status}`);
  const batch = (await batchRes.json()) as { results: { vulns?: { id: string }[] }[] };

  const ids = [...new Set(batch.results.flatMap((r) => r.vulns?.map((v) => v.id) ?? []))].slice(0, 20);
  const findings: OsvVulnSummary[] = [];

  const db = getDb(env.DB);

  for (const id of ids) {
    const vulnRes = await fetch(OSV_VULN_URL + id);
    if (!vulnRes.ok) continue;
    const vuln = (await vulnRes.json()) as Record<string, unknown>;

    const aliases = (vuln.aliases as string[] | undefined) ?? [];
    const cve = aliases.find((a) => a.startsWith("CVE-")) ?? (vuln.id as string);
    const severity = severityLabel(vuln);
    if (!severity.includes("HIGH") && !severity.includes("CRITICAL")) continue;

    const pkgName =
      ((vuln.affected as { package?: { name?: string } }[] | undefined)?.[0]?.package?.name) ?? "unknown";
    const fixedVersion_ = fixedVersion(vuln, pkgName);

    const [alreadyReported] = await db
      .select({ resolvedAt: securityFindings.resolvedAt })
      .from(securityFindings)
      .where(and(eq(securityFindings.cve, cve), eq(securityFindings.packageName, pkgName)));
    if (alreadyReported && alreadyReported.resolvedAt === null) continue;

    await db
      .insert(securityFindings)
      .values({
        id: crypto.randomUUID(),
        cve,
        packageName: pkgName,
        severity,
        fixedVersion: fixedVersion_,
        reportedAt: Date.now(),
      })
      .onConflictDoNothing();

    findings.push({ cve, packageName: pkgName, severity, fixedVersion: fixedVersion_ });
  }

  const rows =
    findings
      .map(
        (f) =>
          `<tr>` +
          `<td style="padding:8px 12px;border-bottom:1px solid #ececec;font-size:13px;color:#242424;">${escapeHtml(f.packageName)}</td>` +
          `<td style="padding:8px 12px;border-bottom:1px solid #ececec;font-size:13px;">` +
          `<span style="color:#CD5F23;font-weight:bold;">${escapeHtml(f.severity)}</span></td>` +
          `<td style="padding:8px 12px;border-bottom:1px solid #ececec;font-size:13px;color:#4b4b4b;">${escapeHtml(f.cve)}</td>` +
          `<td style="padding:8px 12px;border-bottom:1px solid #ececec;font-size:13px;color:#236E37;font-weight:bold;">${escapeHtml(f.fixedVersion ?? "-")}</td>` +
          `</tr>`
      )
      .join("") || emptyRow("No high or critical findings this week");

  const html = renderTemplate("security-report", {
    report_date: dateKey,
    finding_count: String(findings.length),
    findings_rows: rows,
  });

  const transport = await getTransport(env);
  const recipients = await listSuperAdminEmails(env.DB);
  await Promise.all(
    recipients.map((to) =>
      transport.send({
        to,
        subject: `Weekly security report (${dateKey}) - ${findings.length} finding(s)`,
        html,
        text: htmlToText(html),
      })
    )
  );
}
