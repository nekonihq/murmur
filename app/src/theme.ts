// Light and dark palettes. Screens don't import a palette directly anymore —
// they read the active one from ThemeContext (useTheme), so switching between
// system / light / dark re-styles the whole app at runtime.

export type ThemeMode = "system" | "light" | "dark";
export type ColorScheme = "light" | "dark";

export interface ThemeColors {
  bg: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  textHigh: string;
  textMid: string;
  accent: string;
  accentText: string;
  disabled: string;
  danger: string;
  success: string;
  warn: string;
  // Terminal / monospaced output blocks stay dark in both themes (that's the
  // conventional terminal look), so these are shared across palettes.
  term: string;
  codeBg: string;
  codeBgAlt: string;
  codeFg: string;
}

const code = {
  term: "#0f0",
  codeBg: "#111827",
  codeBgAlt: "#1f2937",
  codeFg: "#d1d5db",
} as const;

export const darkColors: ThemeColors = {
  bg: "#0d1117",
  surface: "#161b22",
  surfaceAlt: "#1f2937",
  border: "#30363d",
  textHigh: "#f0f6fc",
  textMid: "#9ca3af",
  accent: "#2563eb",
  accentText: "#ffffff",
  disabled: "#374151",
  danger: "#f87171",
  success: "#4ade80",
  warn: "#f59e0b",
  ...code,
};

export const lightColors: ThemeColors = {
  bg: "#ffffff",
  surface: "#f3f4f6",
  surfaceAlt: "#e5e7eb",
  border: "#d1d5db",
  textHigh: "#111827",
  textMid: "#6b7280",
  accent: "#2563eb",
  accentText: "#ffffff",
  disabled: "#9ca3af",
  danger: "#dc2626",
  success: "#16a34a",
  warn: "#b45309",
  ...code,
};

export const palettes: Record<ColorScheme, ThemeColors> = {
  light: lightColors,
  dark: darkColors,
};
