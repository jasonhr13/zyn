import { serviceOriginForRequest } from "../../domain";

function licenseOrigin(request: Request) {
  return process.env.ZYN_LICENSE_ORIGIN
    || process.env.RCART_LICENSE_ORIGIN
    || serviceOriginForRequest(request, "license");
}

function redirect(request: Request, path: string) {
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL(path, request.url).toString(),
      "cache-control": "no-store",
    },
  });
}

function validEmail(value: string) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export async function POST(request: Request) {
  const form = await request.formData();
  const email = String(form.get("email") || "").trim().toLowerCase();
  const company = String(form.get("company") || "").trim();
  if (company) return redirect(request, "/buy");
  if (!validEmail(email)) return redirect(request, "/buy?error=email");

  try {
    const response = await fetch(`${licenseOrigin(request)}/api/billing/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
      cache: "no-store",
    });
    const payload = await response.json() as { ok?: boolean; url?: string };
    if (response.ok && payload.url) {
      return new Response(null, {
        status: 303,
        headers: {
          location: payload.url,
          "cache-control": "no-store",
        },
      });
    }
    return redirect(request, "/buy?error=service");
  } catch {
    return redirect(request, "/buy?error=service");
  }
}
