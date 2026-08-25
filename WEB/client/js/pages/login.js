import { api } from "../api.js";
import { navigate, state } from "../main.js";

export async function renderLogin(root) {
  const params = new URLSearchParams(location.search);
  const next = params.get("next") || "/projects";

  root.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand-big">TM</div>
        <h1>Sign in</h1>
        <p class="sub">Ticket Manager &middot; internal workspace</p>
        <div id="login-error" class="form-error hidden"></div>
        <form id="login-form">
          <div class="field">
            <label for="email">E-mail</label>
            <input id="email" name="email" type="email" autocomplete="username" required autofocus />
          </div>
          <div class="field">
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required />
          </div>
          <button class="btn" type="submit" style="width:100%" id="login-btn">Sign in</button>
        </form>
        <p style="text-align:center;margin:12px 0 0"><a href="/reset-password" data-nav>Forgot password?</a></p>
        <div class="demo-box">
          <strong>Demo accounts</strong> (seeded locally)
          <table>
            <tr><td><code>ekin@plannedlost.dev</code></td><td><code>admin123!</code></td><td>super admin</td></tr>
            <tr><td><code>ayse@plannedlost.dev</code></td><td><code>member123!</code></td><td>member</td></tr>
            <tr><td><code>mehmet@plannedlost.dev</code></td><td><code>member123!</code></td><td>member</td></tr>
          </table>
        </div>
      </div>
    </div>`;

  const form = root.querySelector("#login-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = root.querySelector("#login-btn");
    const errBox = root.querySelector("#login-error");
    errBox.classList.add("hidden");
    btn.disabled = true;
    try {
      await api.signIn(form.email.value.trim(), form.password.value);
      const session = await api.session();
      state.user = session?.user ?? null;
      navigate(next.startsWith("/") ? next : "/projects");
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove("hidden");
      btn.disabled = false;
    }
  });
}
