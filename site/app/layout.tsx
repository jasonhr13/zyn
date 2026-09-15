import type { Metadata } from "next";
import "./globals.css";

export function generateMetadata(): Metadata {
  const origin = "https://zynbot.app";

  return {
    title: "ZynAIO — Target, Pokémon Center, Walmart, and Costco",
    description: "Retail automation for Target, Pokémon Center US, Walmart, and Costco. $200 for two months, then $40.",
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
      title: "ZynAIO — Target, Pokémon Center, Walmart, and Costco",
      description: "Retail automation for Target, Pokémon Center US, Walmart, and Costco. $200 for two months, then $40.",
      type: "website",
      url: origin,
      images: [{
        url: `${origin}/og-aio.png`,
        width: 1200,
        height: 630,
        alt: "ZynAIO — Target, Pokémon Center US, Walmart, and Costco",
      }],
    },
    twitter: {
      card: "summary_large_image",
      title: "ZynAIO — Target, Pokémon Center, Walmart, and Costco",
      description: "Retail automation for Target, Pokémon Center US, Walmart, and Costco. $200 for two months, then $40.",
      images: [`${origin}/og-aio.png`],
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
