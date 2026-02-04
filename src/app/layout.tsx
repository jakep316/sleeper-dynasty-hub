import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Dynasty Hub",
  description: "Sleeper dynasty history tracker",
};

function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      className="rounded-xl px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 hover:text-zinc-900"
    >
      {label}
    </a>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-zinc-50 text-zinc-900 antialiased">
        <header className="sticky top-0 z-50 border-b border-zinc-200 bg-white/80 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
            <a href="/" className="flex items-center gap-2">
              <span className="inline-flex h-9 w-9 items-center justify-center rounded-2xl bg-zinc-900 text-white">
                🏈
              </span>
              <div className="leading-tight">
                <div className="font-semibold tracking-tight">Dynasty Hub</div>
                <div className="text-xs text-zinc-500">Sleeper league history</div>
              </div>
            </a>

            <nav className="flex items-center gap-1">
              <NavLink href="/transactions" label="Transactions" />
              <NavLink href="/h2h" label="Head-to-Head" />
            </nav>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>

        <footer className="mx-auto max-w-6xl px-4 pb-10 pt-6 text-xs text-zinc-500">
          Built for your league • Powered by Sleeper
        </footer>
      </body>
    </html>
  );
}
