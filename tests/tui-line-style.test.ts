import { describe, expect, it } from "vitest";

import { SESSION_TOKEN_SECTION_HEADING } from "../src/lib/session-tokens-format.js";
import { getSidebarBodyLineColor } from "../src/lib/tui-line-style.js";

describe("getSidebarBodyLineColor", () => {
  const theme = {
    text: "white",
    textMuted: "gray",
  };

  it.each([
    "[OpenCode Go] (personal account)",
    "personal account label continuation",
    "Five-hour                       2h0m",
    "Current balance               USD 42.50",
    "Runs out  1d 4h",
    SESSION_TOKEN_SECTION_HEADING,
    SESSION_TOKEN_SECTION_HEADING.slice(0, 18),
  ])("uses normal text color for readable sidebar text: %s", (line) => {
    expect(getSidebarBodyLineColor(line, theme)).toBe("white");
  });

  it.each([
    "",
    "   ",
    "█████████████░░░░░░░░░░░░   50% left",
    "░░░░░░░░░░   0% left",
  ])("keeps blank separators and progress bars muted: %s", (line) => {
    expect(getSidebarBodyLineColor(line, theme)).toBe("gray");
  });
});
