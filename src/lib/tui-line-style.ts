import type { TuiPluginApi } from "@opencode-ai/plugin/tui";

export function getSidebarBodyLineColor(
  line: string,
  theme: Pick<TuiPluginApi["theme"]["current"], "text" | "textMuted">,
): TuiPluginApi["theme"]["current"]["text"] | TuiPluginApi["theme"]["current"]["textMuted"] {
  return line.trim().length === 0 || /[█░]/u.test(line) ? theme.textMuted : theme.text;
}
