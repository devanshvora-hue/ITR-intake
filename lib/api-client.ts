// Browser-side helper for calling the ITR Intake API through this site's
// /api proxy. The session cookie is HttpOnly: this code never sees or stores
// it. The X-ITR-Request header is required by the server for every
// state-changing request (CSRF protection).

export type ApiResult = {
  ok: boolean;
  status: number;
  data: Record<string, unknown>;
};

// Sends a file as the raw request body (no multipart parsing on the server),
// reporting upload progress. The filename travels percent-encoded in a
// header and is used for display only.
export function uploadFile(path: string, file: File, onProgress?: (fraction: number) => void): Promise<ApiResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", path);
    xhr.withCredentials = false; // same-origin requests send cookies anyway
    xhr.setRequestHeader("X-ITR-Request", "1");
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-Upload-Filename", encodeURIComponent(file.name));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = {};
      }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, data: { error: "unavailable" } });
    xhr.send(file);
  });
}

export async function postJson(path: string, body?: unknown): Promise<ApiResult> {
  try {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-ITR-Request": "1" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: Record<string, unknown> = {};
    try {
      data = await res.json();
    } catch {
      data = {};
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: "unavailable" } };
  }
}
