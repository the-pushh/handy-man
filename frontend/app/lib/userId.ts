/* One browser is one user (no login). A random ID made once and kept in
   this browser; it keys this browser's History on the server. Clearing
   site data starts a new, empty history. */

const KEY = "handyman-user";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function userId(): string | null {
  try {
    let id = window.localStorage.getItem(KEY);
    if (!id || !UUID.test(id)) {
      id = crypto.randomUUID();
      window.localStorage.setItem(KEY, id);
    }
    return id;
  } catch {
    return null; // storage blocked: history stays local-only
  }
}
