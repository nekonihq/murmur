// Resolves the active color palette from the user's preference (system / light
// / dark) and the OS color scheme, and persists the choice. Default is
// "system", so a fresh install follows the phone's appearance setting and
// updates live when the user flips it.

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useColorScheme } from "react-native";

import {
  palettes,
  type ColorScheme,
  type ThemeColors,
  type ThemeMode,
} from "./theme.ts";
import { loadThemePref, saveThemePref } from "./storage/keys.ts";

interface ThemeValue {
  colors: ThemeColors;
  /** Effective scheme after resolving "system". */
  scheme: ColorScheme;
  /** The user's stored preference. */
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const system = useColorScheme(); // "light" | "dark" | null (unknown)
  const [mode, setModeState] = useState<ThemeMode>("system");

  useEffect(() => {
    void loadThemePref().then(setModeState);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    void saveThemePref(next);
  }, []);

  // Fall back to dark when the OS scheme is unknown/unspecified.
  const resolved: ColorScheme =
    mode === "light" || mode === "dark" ? mode : system === "light" ? "light" : "dark";
  const scheme = resolved;

  const value = useMemo<ThemeValue>(
    () => ({ colors: palettes[scheme], scheme, mode, setMode }),
    [scheme, mode, setMode],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error("useTheme must be used within a ThemeProvider");
  return v;
}
