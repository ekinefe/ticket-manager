import { api } from "../api.js";
import { state, navigate } from "../main.js";

// Shown instead of the normal app shell whenever state.user.mustChangePassword
// is true (accounts an admin created or reset by hand) — blocks the rest of
// the app until the user sets their own password.
export async function renderForcePassword(root) {
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand-big">TM</div>
        <h1>Set your password</h1>
        <p class="sub">An admin created this account for you. Choose your own password to continue.</p>
        <div id="fp-error" class="form-error hidden"></div>
        <form id="fp-form">
          <div class="field">
            <label for="fp-current">Temporary password</label>
            <input id="fp-current" type="password" autocomplete="current-password" required />
          </div>
          <div class="field">
            <label for="fp-new">New password <span style="font-weight:400">(min. 8 characters)</span></label>
            <input id="fp-new" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <div class="field">
            <label for="fp-new2">Confirm password</label>
            <input id="fp-new2" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <button class="btn" type="submit" style="width:100%" id="fp-btn">Set password</button>
        </form>
        <p style="text-align:center;margin:14px 0 0"><a href="#" id="fp-signout">Sign out instead</a></p>
      </div>
    </div>`;

  root.querySelector("#fp-signout").addEventListener("click", async (e) => {
    e.preventDefault();
    await api.signOut().catch(() => {});
    state.user = null;
    navigate("/login");
  });

  const form = root.querySelector("#fp-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errBox = root.querySelector("#fp-error");
    const btn = root.querySelector("#fp-btn");
    errBox.classList.add("hidden");
    const currentPassword = form.querySelector("#fp-current").value;
    const newPassword = form.querySelector("#fp-new").value;
    if (newPassword !== form.querySelector("#fp-new2").value) {
      errBox.textContent = "Passwords do not match.";
      errBox.classList.remove("hidden");
      return;
    }
    btn.disabled = true;
    try {
      await api.changePassword(currentPassword, newPassword);
      state.user.mustChangePassword = false;
      navigate("/dashboard");
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove("hidden");
      btn.disabled = false;
    }
  });
}
