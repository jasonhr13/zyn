import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "rcart.app";
  const protocol = requestHeaders.get("x-forwarded-proto") ?? (host.includes("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;

  return {
    title: "Zyn — Precision retail operations",
    description: "Monitor products, organize tasks, and run checkout operations from one precise desktop workspace.",
    metadataBase: new URL(origin),
    icons: { icon: "/favicon.png", shortcut: "/favicon.png" },
    openGraph: {
      title: "Zyn — The checkout command center built for the drop.",
      description: "Monitor products, organize every task, and run checkout operations from one focused desktop workspace.",
      type: "website",
      url: origin,
      images: [{
        url: `${origin}/og.png`,
        width: 1200,
        height: 630,
        alt: "Zyn — The checkout command center built for the drop.",
      }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Zyn — The checkout command center built for the drop.",
      description: "Precision retail operations from one focused desktop workspace.",
      images: [`${origin}/og.png`],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
