export type SidebarTextStyle = "title" | "muted" | "body";

export type SidebarContentSegment = {
  text: string;
  style: SidebarTextStyle;
};

export type SidebarContentRow = {
  kind: "header" | "body";
  text: string;
  segments: SidebarContentSegment[];
};

function sidebarHeadingTitle(params: {
  collapsed: boolean;
  heading: string;
  hasDetailLines: boolean;
}): string {
  return params.hasDetailLines
    ? `${params.collapsed ? "▶" : "▼"} ${params.heading}`
    : params.heading;
}

function sidebarHeadingSuffix(params: {
  collapsed: boolean;
  hasDetailLines: boolean;
  providerCount: number;
}): string | undefined {
  if (params.hasDetailLines && params.collapsed && params.providerCount > 0) {
    return ` (${params.providerCount} providers)`;
  }
  return undefined;
}

export function formatSidebarHeadingSegments(params: {
  collapsed: boolean;
  heading: string;
  hasDetailLines: boolean;
  providerCount: number;
}): SidebarContentSegment[] {
  const title = sidebarHeadingTitle(params);
  const suffix = sidebarHeadingSuffix(params);
  return suffix
    ? [
        { text: title, style: "title" },
        { text: suffix, style: "muted" },
      ]
    : [{ text: title, style: "title" }];
}

export function formatSidebarHeading(params: {
  collapsed: boolean;
  heading: string;
  hasDetailLines: boolean;
  providerCount: number;
}): string {
  return formatSidebarHeadingSegments(params)
    .map((segment) => segment.text)
    .join("");
}

export function buildSidebarContentRows(params: {
  collapsed: boolean;
  heading: string;
  hasDetailLines: boolean;
  providerCount: number;
  lines: string[];
}): SidebarContentRow[] {
  const segments = formatSidebarHeadingSegments(params);
  return [
    {
      kind: "header",
      text: formatSidebarHeading(params),
      segments,
    },
    ...params.lines.map((line) => ({
      kind: "body" as const,
      text: line,
      segments: [{ text: line, style: "body" as const }],
    })),
  ];
}

export function renderSidebarContentFrame(rows: SidebarContentRow[]): string {
  return rows.map((row) => row.text).join("\n");
}

const SIDEBAR_HEADING_RE = /^(?:[▶▼] )?Quota(?: \[(?:Used|Remaining)\])?(?: \(\d+ providers\))?$/;

export function collectSidebarHeadingLines(frame: string): string[] {
  return frame
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => SIDEBAR_HEADING_RE.test(line));
}
