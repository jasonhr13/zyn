const LICENSE_ORIGIN = process.env.RCART_LICENSE_ORIGIN || "https://license.rcart.app";

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
  // Silently accept the hidden field when a basic form bot fills it. This avoids giving the bot a
  // signal while keeping junk out of the durable waiting list.
  if (company) return redirect(request, "/join?joined=1");
  if (!validEmail(email)) return redirect(request, "/join?error=email");

  try {
    const response = await fetch(`${LICENSE_ORIGIN}/api/waitlist`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
      cache: "no-store",
    });
    return redirect(request, response.ok ? "/join?joined=1" : "/join?error=service");
  } catch {
    return redirect(request, "/join?error=service");
  }
}
