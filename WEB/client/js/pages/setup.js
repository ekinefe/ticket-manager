import { api } from "../api.js";
import { esc } from "../ui.js";
import { navigate } from "../main.js";

export async function renderSetup(root) {
  let needed = false;
  try {
    const status = await fetch("/api/setup/status", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null));
    needed = status?.needed ?? false;
  } catch {}

  if (!needed) {
    root.innerHTML = `
      <div class="auth-wrap">
        <div class="auth-card" style="text-align:center">
          <div class="brand-big" style="margin-inline:auto">TM</div>
          <h1>Already configured</h1>
          <p class="sub">A super admin already exists, so first-run setup is closed.</p>
          <a class="btn" href="/login" data-nav style="width:100%">Sign in</a>
        </div>
      </div>`;
    return;
  }

  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand-big">TM</div>
        <h1>Set up your workspace</h1>
        <p class="sub">Create the initial super admin account. This runs once.</p>
        <div id="setup-error" class="form-error hidden"></div>
        <form id="setup-form">
          <div class="field">
            <label for="st-email">E-mail</label>
            <input id="st-email" type="email" autocomplete="username" required autofocus />
          </div>
          <div class="field">
            <label for="st-name">Name</label>
            <input id="st-name" type="text" autocomplete="name" required />
          </div>
          <div class="field">
            <label for="st-password">Password <span style="font-weight:400">(min. 8 characters)</span></label>
            <input id="st-password" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <div class="field">
            <label for="st-password2">Confirm password</label>
            <input id="st-password2" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <button class="btn" type="submit" id="st-btn" style="width:100%">Create admin account</button>
        </form>
      </div>
    </div>`;

  const form = root.querySelector("#setup-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errBox = root.querySelector("#setup-error");
    const btn = root.querySelector("#st-btn");
    errBox.classList.add("hidden");

    const password = form.querySelector("#st-password").value;
    if (password !== form.querySelector("#st-password2").value) {
      errBox.textContent = "Passwords do not match.";
      errBox.classList.remove("hidden");
      return;
    }

    btn.disabled = true;
    try {
      await api.post("/setup/complete", {
        email: form.querySelector("#st-email").value.trim(),
        name: form.querySelector("#st-name").value.trim(),
        password,
      });
      root.innerHTML = `
        <div class="auth-wrap">
          <div class="auth-card" style="text-align:center">
            <div class="brand-big" style="margin-inline:auto">TM</div>
            <h1>Admin created!</h1>
            <p class="sub">${esc(form.querySelector("#st-email").value.trim())} is now a super admin.</p>
            <a class="btn" href="/login" data-nav style="width:100%">Sign in now</a>
          </div>
        </div>`;
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove("hidden");
      btn.disabled = false;
    }
  });
}
