import type { Metadata } from "next";
import "./globals.css";

export function generateMetadata(): Metadata {
  const origin = "https://zynbot.app";

  return {
    title: "Zyn — Precision retail operations",
    description: "Monitor products, organize tasks, and run checkout operations from one precise desktop workspace.",
    metadataBase: new URL(origin),
    manifest: "/manifest.webmanifest",
    icons: {
      icon: [
        { url: "/favicon.png", type: "image/png", sizes: "64x64" },
        { url: "/zyn-icon.png", type: "image/png", sizes: "1024x1024" },
      ],
      shortcut: "/favicon.png",
      apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    },
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
