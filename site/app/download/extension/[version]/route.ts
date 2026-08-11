import { serviceOriginForRequest } from "../../../domain";

function chromeExtensionVersion(pathname: string) {
  const encoded = pathname.split("/").filter(Boolean).at(-1) || "";
  let version: string;
  try {
    version = decodeURIComponent(encoded);
  } catch {
    return null;
  }

  if (!/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}$/.test(version)) return null;
  const components = version.split(".").map(Number);
  if (components.every((component) => component === 0)) return null;
  return components.every((component) => component <= 65_535) ? version : null;
}

function versionedExtensionDownloadResponse(request: Request) {
  const version = chromeExtensionVersion(new URL(request.url).pathname);
  if (!version) return new Response("Not found", { status: 404 });

  return new Response(null, {
    status: 302,
    headers: {
      location: `${serviceOriginForRequest(request, "updates")}/extension/Zyn-Harvester-${version}.zip`,
      "cache-control": "no-store",
    },
  });
}

export function GET(request: Request) {
  return versionedExtensionDownloadResponse(request);
}

export function HEAD(request: Request) {
  return versionedExtensionDownloadResponse(request);
}
