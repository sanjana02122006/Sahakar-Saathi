import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { I18nProvider } from "@/lib/i18n/provider";
import { AvatarProvider } from "@/lib/avatar-context";
import "./globals.css";

export const metadata: Metadata = {
  title: "Sahakar Saathi — Cooperative Governance Assistant",
  description:
    "Multilingual AI assistant for cooperative laws, Ministry of Cooperation schemes, PACS services, PMFBY and grievance redressal.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body className="min-h-screen font-sans">
        <I18nProvider>
          <AvatarProvider>{children}</AvatarProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
