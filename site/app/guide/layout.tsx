import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: {
    default: "How to use Zyn",
    template: "%s — Zyn Guide",
  },
  description: "How to set up Zyn and run Target, Walmart, Pokémon Center US, and Costco drops.",
};

export default function GuideLayout({ children }: { children: ReactNode }) {
  return children;
}
