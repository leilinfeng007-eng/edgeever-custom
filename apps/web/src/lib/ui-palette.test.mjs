import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { contrastRatio } from "./color-contrast";

const globals = readFileSync(new URL("../styles/globals.css", import.meta.url), "utf8");

describe("application color system", () => {
  test("uses the same restrained brand green throughout the application", () => {
    const mobileEditor = readFileSync(new URL("../styles/mobile-markdown-editor.css", import.meta.url), "utf8");

    expect(globals).toContain("--brand-green: #16a06e;");
    expect(globals).toContain("--brand-green-500-rgb: 22 160 110;");
    expect(globals).not.toContain("--brand-green: #00a82d;");
    expect(mobileEditor).toContain("color: #16a06e;");
    expect(contrastRatio("#11694a", "#f0f8f4")).toBeGreaterThanOrEqual(4.5);
  });

  test("keeps menus and switches neutral while solid buttons use the brand green", () => {
    const button = readFileSync(new URL("../components/ui/button.tsx", import.meta.url), "utf8");
    const switchSource = readFileSync(new URL("../components/ui/switch.tsx", import.meta.url), "utf8");
    const checkbox = readFileSync(new URL("../components/ui/checkbox.tsx", import.meta.url), "utf8");

    expect(button).toContain('solid: "bg-emerald-600 text-white border border-emerald-600');
    expect(button).not.toContain("bg-emerald-500");

    expect(globals).toContain("--accent: 210 16% 89%;");
    expect(globals).toContain("--accent-foreground: 0 0% 7%;");
    expect(globals).toContain("--switch-track-on: #525252;");
    expect(globals).toContain("--checkbox-on: #525252;");
    expect(globals).toContain("--switch-track-on: #e8e8e8;");
    expect(switchSource).toContain("data-[state=checked]:bg-[var(--switch-track-on)]");
    expect(switchSource).not.toContain("bg-emerald-500");
    expect(checkbox).toContain("data-[state=checked]:bg-[var(--checkbox-on)]");
    expect(checkbox).not.toContain("bg-emerald-500");
    expect(contrastRatio("#ffffff", "#525252")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#ffffff", "#047857")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#0c1310", "#e8e8e8")).toBeGreaterThanOrEqual(4.5);
  });

  test("keeps the light workspace on a soft green palette while preserving text hierarchy", () => {
    expect(globals).toContain("--workspace-canvas: #dfe9e3;");
    expect(globals).toContain("--workspace-sidebar: #e8f1eb;");
    expect(globals).toContain("--workspace-memo-list: #f3f8f5;");
    expect(globals).toContain("--workspace-editor: #ffffff;");
    expect(globals).toContain("--workspace-selection: #d5eadf;");
    expect(globals).toContain("--color-workspace-canvas: var(--workspace-canvas);");
    expect(globals).toContain("--workspace-hover: #edf5f0;");
    expect(globals).toContain(".edgeever-workspace-sidebar-footer {\n  background: var(--workspace-sidebar);");
    expect(globals).toContain("--slate-500-rgb: 115 115 115;");
    expect(globals).toContain("--slate-950-rgb: 10 10 10;");
    expect(globals).toContain("--amber-50-rgb: 255 251 235;");
    expect(globals).toContain("--amber-300-rgb: 252 211 77;");
    expect(globals).toContain("--amber-400-rgb: 251 191 36;");
    expect(globals).toContain("--amber-500-rgb: 245 158 11;");
    expect(globals).toContain("--rose-50-rgb: 255 241 242;");
    expect(globals).toContain("--rose-400-rgb: 251 113 133;");
    expect(globals).not.toContain("--slate-500-rgb: 100 116 139;");
    expect(contrastRatio("#222222", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#737373", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#27272a", "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#5c6661", "#f3f8f5")).toBeGreaterThanOrEqual(4.5);
  });

  test("keeps dark workspace surfaces distinct and neutral", () => {
    expect(globals).toContain("--workspace-canvas: #0c1310;");
    expect(globals).toContain("--workspace-sidebar: #111a16;");
    expect(globals).toContain("--workspace-memo-list: #16221c;");
    expect(globals).toContain("--workspace-editor: #1b2721;");
    expect(globals).toContain("--foreground: 150 10% 90%;");
    expect(globals).toContain("--border: 158 12% 24%;");
    expect(globals).toContain("--amber-300-rgb: 180 83 9;");
    expect(globals).not.toContain("scrollbar-color: rgba(100, 116, 139, 0.18)");
    expect(contrastRatio("#dedede", "#1b2721")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#a3a3a3", "#1b2721")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#a0a0a0", "#1b2721")).toBeGreaterThanOrEqual(4.5);
  });
});
