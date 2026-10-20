"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

const NAV = [
  { href: "/", label: "Fleet" },
  { href: "/agents", label: "Agents" },
  { href: "/tasks", label: "Tasks" },
  { href: "/telemetry", label: "Telemetry" },
  { href: "/tokens", label: "Tokens" },
  { href: "/onboarding", label: "Onboarding" },
];

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-accent)";

/**
 * Client island for console navigation: active-route state plus
 * cmd/ctrl+digit shortcuts. Kept out of the layout so the layout
 * stays a server component (metadata, no client JS for the chrome).
 */
export function ConsoleNav(): React.JSX.Element {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (!(event.metaKey || event.ctrlKey)) return;
      const digit = Number(event.key);
      if (digit >= 1 && digit <= NAV.length) {
        event.preventDefault();
        const target = NAV[digit - 1];
        if (target !== undefined) router.push(target.href);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);

  return (
    <nav aria-label="Console" className="flex gap-4 text-sm">
      {NAV.map((item, index) => {
        const active =
          item.href === "/"
            ? pathname === "/"
            : pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            title={`${item.label} (Γîÿ${index + 1})`}
            className={`text-(--color-fg-muted) hover:text-(--color-accent) ${FOCUS_RING} ${active ? "font-semibold text-(--color-fg)" : ""}`}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
