import core from "./en/core.js";
import board from "./en/board.js";
import dashboard from "./en/dashboard.js";
import projects from "./en/projects.js";
import mytickets from "./en/mytickets.js";
import admin from "./en/admin.js";
import gitgraph from "./en/gitgraph.js";
import share from "./en/share.js";
import auth from "./en/auth.js";
import reports from "./en/reports.js";
import errors from "./en/errors.js";
import pdf from "./en/pdf.js";
import settings from "./en/settings.js";

export default { ...core, ...board, ...dashboard, ...projects, ...mytickets, ...admin, ...gitgraph, ...share, ...auth, ...reports, ...errors, ...pdf, ...settings };
