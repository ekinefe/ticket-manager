# Ticket Manager — user guide

## Concepts

- **Project** — has a prefix (e.g. `TM`); tickets get IDs `TM-1`, `TM-2`, …
- **Sprint** — a swim lane on the board (`TM-S1`, …). Tickets outside any sprint
  sit in the "Everything else" lane.
- **Ticket** — title, rich-text description, type (Task/Bug), priority, status,
  assignee, sprint, comments, attachments and an activity log.
- **Statuses** (any move is allowed, so accidental drags can be undone):
  To Do → In Progress → Under Review → Merged → Deployed → Test → Done.

## Roles

| Role | Scope | Can do |
| --- | --- | --- |
| Super admin | whole app | everything, incl. **Admin → Settings**, **All Tickets**, dashboard filters |
| Admin | account | manage users/projects they administer |
| Project admin | one project | change type/priority/assignee, delete tickets, share tickets, manage members and sprints |
| Member | one project | edit tickets they created or are assigned to; others only with the *MOVE_OTHERS_TICKETS* permission |

Project permissions (for example `CREATE_TICKET`, `DELETE_TICKET`,
`VIEW_ALL_TICKETS`) are granted per member in the project's Members tab.

## Working with tickets

- **Create**: *+ New ticket* on the board, or *+ Create* inside a column. The
  ticket is created as soon as it has a title; every field then autosaves.
- **Move**: drag a card between columns/lanes, or change Status/Sprint in the
  ticket's side panel.
- **Board / List view**: toggle in the toolbar. The List view has checkboxes
  for bulk actions.
- **Bulk delete**: select tickets, choose delete. It is permanent, needs
  `DELETE_TICKET`; tickets you may not delete are skipped and reported.
- **Search**: `Ctrl K` — tickets (opens the ticket), sprints, projects, users.
  Typing an ID such as `TM-3` or a sprint such as `TM-S1` works.
- **Mentions**: type `@` in a comment to notify someone.
- **Export**: *Export JSON* (full detail: sprints, people, comments, activity,
  GitHub links) or *Export CSV* from the board toolbar.

## Updating a project from an edited JSON

Instead of deleting a project and importing it again, project admins can edit
an export and apply only the differences:

0. Every **Export JSON** starts with an `instructions` block: what can be changed
   per ticket, what must not be touched, how to create / move / delete tickets,
   and the allowed values for this project (statuses, sprints, members). Give the
   file to Claude as is and it knows the rules — no extra prompt needed.
1. On the board, **Export JSON**; edit the file (for example with Claude).
   Keep each ticket's `ticketId` — it is how tickets are matched. Only the
   fields you leave in a ticket are compared; fields you remove are left alone
   (use `null` / `""` to clear: `"sprintId": null` moves to Backlog,
   `"assignee": null` unassigns).
2. **Update from JSON** and choose the file. A preview lists new tickets,
   changed tickets (field: old → new), tickets in the project that are not in
   the file, and warnings.
3. Choose what to apply: create new tickets, update existing ones (content,
   status/order, sprint, assignee/labels/due date) and, off by default,
   delete tickets that are missing from the file (permanent).
4. **Apply changes**. Entries without a known ticket ID become new tickets with
   the next free ID; unknown sprint names create new sprints.

## My Tickets, Unassigned, All Tickets

- **My Tickets** lists tickets assigned to you across projects, plus an
  **Unassigned** section for projects where you have `VIEW_ALL_TICKETS`.
- **All Tickets** (super admin only) lists every ticket with an assignee filter.

## Sharing a ticket

A project admin can open *Share…* on a ticket and choose:

- **Off** — members only (default).
- **Signed-in users** — any logged-in user gets a read-only view.
- **Anyone with the link** — read-only public page.

Viewers see description, comments, attachments, people's names and activity —
never e-mail addresses. Turning sharing off revokes the link immediately.

## GitHub

One private repo per project via a GitHub App; see
[`github-setup.md`](github-setup.md). Linked commits/PRs show on tickets
(use the ticket ID in branch names, commits and PR titles), PR open/merge can
auto-move tickets, and the project's **Git graph** page shows branches and
commits.

## Dashboard

Counts are all-time. The *Range* filter (super admin) affects only the time
charts (Created vs Completed, Recent Activity).

## E-mail and settings (super admin)

*Admin → Settings* holds the app URL, e-mail transport (`resend` or local
`file`), Resend API key, from-address and GitHub App credentials. Changes apply
without a restart. To send real e-mail, set transport to **Resend** and paste a
Resend API key; the from-address must be on a domain verified in Resend.

Scheduled e-mails: a daily digest, a weekly report, and super-admin
daily/weekly/monthly summaries (see `WEB/src/cron/`).
