import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = { title: "懂你" };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// 在首帧前定好主题，避免闪一下
const themeScript = `document.documentElement.dataset.theme = localStorage.getItem("dongni:theme") || "light";`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
