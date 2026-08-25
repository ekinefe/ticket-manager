import { api } from "../api.js";
import { esc } from "../ui.js";
import { navigate } from "../main.js";

export async function renderAcceptInvite(root) {
  const params = new URLSearchParams(location.search);
  const token = params.get("token") || "";

  if (!token) {
    return renderResult(root, "Invalid link", "This invite link is missing its token.", false);
  }

  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand-big">TM</div>
        <h1>Join your team</h1>
        <p class="sub">You have been invited to a project. Set a password to activate your account.</p>
        <div id="invite-error" class="form-error hidden"></div>
        <form id="invite-form">
          <div class="field">
            <label for="iv-name">Your name <span style="font-weight:400">(optional)</span></label>
            <input id="iv-name" type="text" autocomplete="name" />
          </div>
          <div class="field">
            <label for="iv-password">Password <span style="font-weight:400">(min. 8 characters)</span></label>
            <input id="iv-password" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <div class="field">
            <label for="iv-password2">Confirm password</label>
            <input id="iv-password2" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <button class="btn" type="submit" id="iv-btn" style="width:100%">Accept invitation</button>
        </form>
      </div>
    </div>`;

  const form = root.querySelector("#invite-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errBox = root.querySelector("#invite-error");
    const btn = root.querySelector("#iv-btn");
    errBox.classList.add("hidden");

    const password = form.querySelector("#iv-password").value;
    if (password !== form.querySelector("#iv-password2").value) {
      errBox.textContent = "Passwords do not match.";
      errBox.classList.remove("hidden");
      return;
    }

    btn.disabled = true;
    try {
      await api.post("/invitations/accept", {
        token,
        name: form.querySelector("#iv-name").value.trim(),
        password,
      });
      renderSuccess(root);
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove("hidden");
      btn.disabled = false;
    }
  });
}

function renderSuccess(root) {
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card" style="text-align:center">
        <div class="brand-big" style="margin-inline:auto">TM</div>
        <h1>You're in!</h1>
        <p class="sub">Your account is ready and you have joined the project.</p>
        <a class="btn" href="/login" data-nav style="width:100%">Sign in now</a>
      </div>
    </div>`;
}

function renderResult(root, title, message, showLoginLink = true) {
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card" style="text-align:center">
        <div class="brand-big" style="margin-inline:auto;background:${showLoginLink ? "#b3261e" : "#964826"}">${showLoginLink ? "!" : "TM"}</div>
        <h1>${esc(title)}</h1>
        <p class="sub">${esc(message)}</p>
        ${showLoginLink ? `<a class="btn ghost" href="/" data-nav>Go to homepage</a>` : ""}
      </div>
    </div>`;
}
