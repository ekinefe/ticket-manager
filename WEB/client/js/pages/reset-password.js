import { api } from "../api.js";
import { esc } from "../ui.js";

export async function renderResetPassword(root) {
  const params = new URLSearchParams(location.search);
  const token = params.get("token") || "";

  if (token) return renderNewPasswordForm(root, token);
  return renderRequestForm(root);
}

function renderRequestForm(root) {
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand-big">TM</div>
        <h1>Forgot password</h1>
        <p class="sub">Enter your e-mail and we will send you a reset link.</p>
        <div id="rp-error" class="form-error hidden"></div>
        <form id="rp-form">
          <div class="field">
            <label for="rp-email">E-mail</label>
            <input id="rp-email" type="email" autocomplete="username" required autofocus />
          </div>
          <button class="btn" type="submit" style="width:100%" id="rp-btn">Send reset link</button>
        </form>
        <p style="text-align:center;margin:14px 0 0"><a href="/login" data-nav>Back to sign in</a></p>
      </div>
    </div>`;

  const form = root.querySelector("#rp-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = root.querySelector("#rp-btn");
    btn.disabled = true;
    try {
      // The API always answers ok, regardless of account existence.
      await api.post("/auth/request-password-reset", { email: form.querySelector("#rp-email").value.trim() });
      root.querySelector(".auth-card").innerHTML = `
        <div class="brand-big">TM</div>
        <h1>Check your inbox</h1>
        <p class="sub">If an account exists for that address, a single-use reset link valid for one hour has been sent.</p>
        <a class="btn" href="/login" data-nav style="width:100%">Back to sign in</a>`;
    } catch (err) {
      const errBox = root.querySelector("#rp-error");
      errBox.textContent = err.message;
      errBox.classList.remove("hidden");
      btn.disabled = false;
    }
  });
}

function renderNewPasswordForm(root, token) {
  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand-big">TM</div>
        <h1>Choose a new password</h1>
        <div id="rp-error" class="form-error hidden"></div>
        <form id="rp-form">
          <div class="field">
            <label for="rp-password">New password <span style="font-weight:400">(min. 8 characters)</span></label>
            <input id="rp-password" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <div class="field">
            <label for="rp-password2">Confirm password</label>
            <input id="rp-password2" type="password" autocomplete="new-password" required minlength="8" />
          </div>
          <button class="btn" type="submit" style="width:100%" id="rp-btn">Set password</button>
        </form>
      </div>
    </div>`;

  const form = root.querySelector("#rp-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errBox = root.querySelector("#rp-error");
    const btn = root.querySelector("#rp-btn");
    const password = form.querySelector("#rp-password").value;
    if (password !== form.querySelector("#rp-password2").value) {
      errBox.textContent = "Passwords do not match.";
      errBox.classList.remove("hidden");
      return;
    }
    btn.disabled = true;
    try {
      await api.post("/auth/reset-password", { token, password });
      root.querySelector(".auth-card").innerHTML = `
        <div class="brand-big">TM</div>
        <h1>Password updated</h1>
        <p class="sub">Your password has been changed and all active sessions were signed out.</p>
        <a class="btn" href="/login" data-nav style="width:100%">Sign in</a>`;
    } catch (err) {
      errBox.textContent = esc(err.message);
      errBox.classList.remove("hidden");
      btn.disabled = false;
    }
  });
}
