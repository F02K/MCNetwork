const TOKEN_KEY = 'mcnetwork.token';

export const auth = {
  get token() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch {
      return ''; // storage blocked: the token only lives until the page is reloaded
    }
  },
  set(value) {
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage blocked */
    }
  },
};

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** One JSON request to the daemon. A 401 raises the "auth-required" event so the login screen can show. */
export async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'The MCNetwork daemon is not reachable');
  }
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('auth-required'));
    throw new ApiError(res.status, json?.error || res.statusText);
  }
  return json;
}

export const get = (path) => api('GET', path);
export const post = (path, body = {}) => api('POST', path, body);
export const put = (path, body = {}) => api('PUT', path, body);
export const del = (path) => api('DELETE', path);

export function eventsUrl() {
  return `/api/events${auth.token ? `?token=${encodeURIComponent(auth.token)}` : ''}`;
}
