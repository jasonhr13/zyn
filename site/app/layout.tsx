import type { Metadata } from "next";
import "./globals.css";

export function generateMetadata(): Metadata {
  const origin = "https://zynbot.app";

  return {
    title: "Zyn — Target and Pokémon Center Checkout",
    description: "A desktop app for Target and Pokémon Center US restocks. Watch products, keep working proxies, and check out when they come back.",
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
      title: "Zyn — Target and Pokémon Center Checkout",
      description: "A desktop app for Target and Pokémon Center US restocks. $100 for two months, then $40 every month.",
      type: "website",
      url: origin,
      images: [{
        url: `${origin}/og-retailers-beta.png`,
        width: 1200,
        height: 630,
        alt: "Zyn — Target and Pokémon Center US checkout automation",
      }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Zyn — Target and Pokémon Center Checkout",
      description: "Target and Pokémon Center US checkout automation for desktop. $100 for two months, then $40 every month.",
      images: [`${origin}/og-retailers-beta.png`],
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
