import { serviceOriginForRequest } from "../../domain";

function extensionDownloadResponse(request: Request) {
  return new Response(null, {
    status: 302,
    headers: {
      location: `${serviceOriginForRequest(request, "updates")}/download/extension`,
      "cache-control": "no-store",
    },
  });
}

export function GET(request: Request) {
  return extensionDownloadResponse(request);
}

export function HEAD(request: Request) {
  return extensionDownloadResponse(request);
}
