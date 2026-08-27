import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/app/components/ui/tooltip";
import { ThemeProvider } from "@/app/components/theme/theme-provider";
import "./globals.css";

const themeInitializationScript = `
  (() => {
    try {
      const saved = localStorage.getItem("threadmark:theme");
      const preference = saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
      const resolved = preference === "system"
        ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : preference;
      const root = document.documentElement;
      root.classList.toggle("dark", resolved === "dark");
      root.dataset.theme = resolved;
      root.style.colorScheme = resolved;
    } catch {
      // O tema claro continua sendo um fallback seguro quando o storage não está disponível.
    }
  })();
`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  applicationName: "Threadmark",
  title: {
    default: "Threadmark · Suporte local",
    template: "%s · Threadmark",
  },
  description:
    "Threadmark organiza conversas, tickets e conhecimento de suporte com dados locais.",
  icons: {
    icon: "/threadmark-icon.png",
    shortcut: "/threadmark-icon.png",
    apple: "/threadmark-icon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitializationScript }} />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ThemeProvider>
          <TooltipProvider>{children}</TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
