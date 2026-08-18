import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tarkov // Tracker",
  description: "Personal Escape from Tarkov progression, hideout, quests, keys and loot tracker.",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
