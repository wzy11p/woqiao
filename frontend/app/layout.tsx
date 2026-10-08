import type { Metadata } from "next";
import AppShell from "@/components/AppShell";
import { APP_NAME, APP_LOGO } from "@/config/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: APP_NAME,
  description: "AI视频生成工具",
  icons: { icon: APP_LOGO, shortcut: APP_LOGO },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className="antialiased"
      >
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
