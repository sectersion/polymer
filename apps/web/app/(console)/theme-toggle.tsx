"use client";

import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

const OPTIONS = [
  { value: "light", label: "Light", icon: "☀" },
  { value: "dark", label: "Dark", icon: "☾" },
  { value: "system", label: "System", icon: "🖥" },
] as const;

export function ThemeToggle(): React.JSX.Element {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <span className="w-16" />;
  const current = theme ?? "system";
  return (
    <div
      role="radiogroup"
      aria-label="Color theme"
      className="flex rounded-md border border-(--color-hairline) bg-white p-0.5 text-sm"
    >
      {OPTIONS.map((option) => {
        const checked = current === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            title={`${option.label} theme`}
            aria-label={`${option.label} theme`}
            onClick={() => setTheme(option.value)}
            className={`rounded px-2 py-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--color-accent) ${
              checked ? "bg-gray-200 font-semibold" : "hover:bg-gray-50"
            }`}
          >
            <span aria-hidden="true">{option.icon}</span> {option.label}
          </button>
        );
      })}
    </div>
  );
}
