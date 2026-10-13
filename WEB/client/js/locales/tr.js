import core from "./tr/core.js";
import board from "./tr/board.js";
import dashboard from "./tr/dashboard.js";
import projects from "./tr/projects.js";
import mytickets from "./tr/mytickets.js";
import admin from "./tr/admin.js";
import gitgraph from "./tr/gitgraph.js";
import share from "./tr/share.js";
import auth from "./tr/auth.js";
import reports from "./tr/reports.js";
import errors from "./tr/errors.js";

export default { ...core, ...board, ...dashboard, ...projects, ...mytickets, ...admin, ...gitgraph, ...share, ...auth, ...reports, ...errors };
