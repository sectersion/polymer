import Link from "next/link";
import { LogoutButton } from "./logout-button";
import { ThemeToggle } from "./theme-toggle";

const NAV = [
  { href: "/", label: "Fleet" },
  { href: "/agents", label: "Agents" },
  { href: "/tasks", label: "Tasks" },
  { href: "/tokens", label: "Tokens" },
  { href: "/onboarding", label: "Onboarding" },
];

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
      <header className="sticky top-0 z-10 border-b border-(--color-hairline) bg-white/80 backdrop-blur-md">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            Polymer
          </Link>
          <nav className="flex gap-4 text-sm">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-gray-600 hover:text-(--color-accent)"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <ThemeToggle />
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
