import { useColorScheme } from "react-native";

/**
 * A small, intentionally minimal token set (colors, spacing, type) used
 * instead of a full design system. Bitacora's app is a single personal
 * tool with two screens — a design system would be overhead here.
 */

export interface ColorTokens {
  background: string;
  surface: string;
  surfaceAlt: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  accent: string;
  accentText: string;
  danger: string;
  dangerSurface: string;
}

const light: ColorTokens = {
  background: "#F7F7F5",
  surface: "#FFFFFF",
  surfaceAlt: "#EEEFEC",
  border: "#DCDDD9",
  textPrimary: "#1B1C19",
  textSecondary: "#6B6D66",
  accent: "#2F6F4F",
  accentText: "#FFFFFF",
  danger: "#B3261E",
  dangerSurface: "#FBE8E6",
};

const dark: ColorTokens = {
  background: "#14150F",
  surface: "#1E1F18",
  surfaceAlt: "#272820",
  border: "#34362B",
  textPrimary: "#EDEFE9",
  textSecondary: "#A6A89E",
  accent: "#6FBF8E",
  accentText: "#0B1A10",
  danger: "#F2B8B5",
  dangerSurface: "#3A1F1D",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  pill: 999,
} as const;

export const typography = {
  body: { fontSize: 15, lineHeight: 21 },
  bodySmall: { fontSize: 13, lineHeight: 18 },
  title: { fontSize: 20, lineHeight: 26, fontWeight: "600" as const },
  label: { fontSize: 12, lineHeight: 16, fontWeight: "600" as const },
} as const;

export function useColors(): ColorTokens {
  const scheme = useColorScheme();
  return scheme === "dark" ? dark : light;
}
