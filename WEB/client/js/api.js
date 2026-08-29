const BASE = "/api";

async function request(path, { method = "GET", body } = {}) {
  const res = await fetch(BASE + path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  if (res.status !== 204) data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(data?.error || data?.message || res.statusText || "Request failed");
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: "POST", body }),
  patch: (path, body) => request(path, { method: "PATCH", body }),
  del: (path) => request(path, { method: "DELETE" }),

  async upload(path, formData) {
    const res = await fetch(BASE + path, {
      method: "POST",
      credentials: "same-origin",
      body: formData,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error || "Upload failed");
    return data;
  },

  async session() {
    const data = await fetch("/api/auth/get-session", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json().catch(() => null) : null));
    return data?.user ? data : null;
  },
  async signIn(email, password) {
    const res = await fetch("/api/auth/sign-in/email", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || data.error || "Invalid email or password");
    }
    return data;
  },
  signOut() {
    return fetch("/api/auth/sign-out", { method: "POST", credentials: "same-origin" });
  },

  async changePassword(currentPassword, newPassword) {
    return request("/auth/change-password", {
      method: "POST",
      body: { currentPassword, newPassword },
    });
  },

  async adminSetPassword(userId, password) {
    return request(`/admin/users/${userId}/password`, {
      method: "POST",
      body: { password },
    });
  },
};
