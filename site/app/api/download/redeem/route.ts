const LICENSE_ORIGIN = process.env.RCART_LICENSE_ORIGIN || "https://license.rcart.app";
const DOWNLOAD_COOKIE = "rcart_download";
const DOWNLOAD_SESSION_SECONDS = 24 * 60 * 60;

function redirect(request: Request, path: string, cookie?: string) {
  const headers = new Headers({
    location: new URL(path, request.url).toString(),
    "cache-control": "no-store",
  });
  if (cookie) headers.set("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

export async function POST(request: Request) {
  const form = await request.formData();
  const key = String(form.get("key") || "");
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(key)) return redirect(request, "/download?error=invalid");

  try {
    const response = await fetch(`${LICENSE_ORIGIN}/api/download/redeem`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": request.headers.get("cf-connecting-ip") || "unknown",
      },
      body: JSON.stringify({ key }),
      cache: "no-store",
    });
    const body = await response.json() as { ok?: boolean; sessionToken?: string; code?: string };
    if (!response.ok || !body.ok || !body.sessionToken) {
      const error = response.status === 429 || body.code === "rate_limited" ? "rate-limited" : "invalid";
      return redirect(request, `/download?error=${error}`);
    }

    const cookie = [
      `${DOWNLOAD_COOKIE}=${encodeURIComponent(body.sessionToken)}`,
      "Path=/download",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      `Max-Age=${DOWNLOAD_SESSION_SECONDS}`,
    ].join("; ");
    return redirect(request, "/download", cookie);
  } catch {
    return redirect(request, "/download?error=service");
  }
}
