import { STATUS_COLORS, STATUS_LABELS, type Status } from "../status";
import { TEMPLATES } from "./generated-templates";

export function renderTemplate(name: string, vars: Record<string, string>): string {
  const source = TEMPLATES[name];
  if (!source) throw new Error(`Unknown e-mail template: ${name}`);
  return source.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? "");
}

export function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function ticketRow(ticketId: string, title: string, url: string, status?: Status): string {
  const badge = status
    ? `<span style="display:inline-block;background:${STATUS_COLORS[status]};color:#ffffff;` +
      `font-size:10px;font-weight:bold;letter-spacing:1px;border-radius:999px;padding:3px 10px;">` +
      `${escapeHtml(STATUS_LABELS[status])}</span>`
    : "";
  return (
    `<tr>` +
    `<td style="padding:8px 12px;border-bottom:1px solid #ececec;font-size:13px;white-space:nowrap;">` +
    `<a href="${escapeHtml(url)}" style="color:#964826;font-weight:bold;text-decoration:none;">` +
    `${escapeHtml(ticketId)}</a></td>` +
    `<td style="padding:8px 12px;border-bottom:1px solid #ececec;font-size:13px;color:#4b4b4b;">` +
    `${escapeHtml(title)}</td>` +
    `<td style="padding:8px 12px;border-bottom:1px solid #ececec;">${badge}</td>` +
    `</tr>`
  );
}

export function emptyRow(label: string): string {
  return (
    `<tr><td colspan="3" style="padding:8px 12px;border-bottom:1px solid #ececec;` +
    `font-size:13px;color:#9a9a9a;font-style:italic;">${escapeHtml(label)}</td></tr>`
  );
}

export function statRow(label: string, value: number | string): string {
  return (
    `<tr>` +
    `<td style="padding:8px 12px;border-bottom:1px solid #ececec;font-size:13px;color:#4b4b4b;">` +
    `${escapeHtml(label)}</td>` +
    `<td style="padding:8px 12px;border-bottom:1px solid #ececec;font-size:13px;font-weight:bold;` +
    `color:#242424;text-align:right;">${escapeHtml(String(value))}</td>` +
    `</tr>`
  );
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
