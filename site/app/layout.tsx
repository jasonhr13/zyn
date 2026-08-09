import type { Metadata } from "next";
import "./globals.css";

export function generateMetadata(): Metadata {
  const origin = "https://zynbot.app";

  return {
    title: "Zyn — Peak Target Checkout Performance",
    description: "Target monitoring, cookie harvesting, and checkout automation in one focused desktop app. Join the free beta.",
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
      title: "Zyn — Peak Target Checkout Performance",
      description: "Target automation built to move from restock to confirmed order. Join the free beta and get one year free after paid access launches.",
      type: "website",
      url: origin,
      images: [{
        url: `${origin}/og-target-beta.png`,
        width: 1200,
        height: 630,
        alt: "Zyn — Peak Target Checkout Performance",
      }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Zyn — Peak Target Checkout Performance",
      description: "Target automation for desktop. Free during beta, plus one year free for every beta user.",
      images: [`${origin}/og-target-beta.png`],
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
