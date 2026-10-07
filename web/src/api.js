// JSON fetch helpers. Errors carry the server's message and HTTP status.

export async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: "same-origin" };
  if (body instanceof FormData) {
    opts.body = body;
  } else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opts);
  } catch {
    const err = new Error("network error, is the server reachable?");
    err.status = 0;
    throw err;
  }
  if (!res.ok) {
    let msg = res.statusText || `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j && j.error) msg = j.error;
    } catch {
      /* not json */
    }
    if (res.status === 401 && !url.startsWith("/api/auth/")) {
      window.dispatchEvent(new Event("ul:unauthorized"));
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("application/json") ? res.json() : res;
}

export const get = (url) => api("GET", url);
export const post = (url, body) => api("POST", url, body === undefined ? {} : body);
export const patch = (url, body) => api("PATCH", url, body);
export const del = (url) => api("DELETE", url);
