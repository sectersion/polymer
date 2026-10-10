"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export function ThemeToggle(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <span className="w-16" />;
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      className="rounded-md border border-(--color-hairline) bg-white px-3 py-1 text-sm hover:bg-gray-50"
      aria-label={`Switch to ${next} mode`}
    >
      {next === "dark" ? "Dark" : "Light"}
    </button>
  );
}
