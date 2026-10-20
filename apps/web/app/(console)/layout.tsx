import Link from "next/link";
import { ToastStack } from "@/lib/toasts";
import { ConsoleNav } from "./console-nav";
import { LogoutButton } from "./logout-button";
import { ThemeToggle } from "./theme-toggle";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-accent)";

/**
 * Component 20: the console chrome. Sticky translucent header +
 * sidebar per the stack spec (liquid glass on chrome, solid data
 * surfaces); mono reserved for IDs/hashes/timestamps.
 */
export default function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:z-20 focus:bg-(--color-card) focus:px-3 focus:py-2"
      >
        Skip to main content
      </a>
      <header className="chrome-bar sticky top-0 z-10 border-b border-(--color-hairline) bg-(--color-card)/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <Link
            href="/"
            className={`text-lg font-semibold tracking-tight ${FOCUS_RING}`}
          >
            Polymer
          </Link>
          <ConsoleNav />
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
      </header>
      <main id="main-content" className="mx-auto max-w-6xl px-4 py-6">
        {children}
      </main>
      {/* Single shared toast mount for the whole console: individual
          buttons only push, never mount their own stack. */}
      <ToastStack />
    </div>
  );
}
