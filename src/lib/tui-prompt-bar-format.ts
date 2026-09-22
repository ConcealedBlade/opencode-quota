import {
  formatAccountingBoolean,
  formatAccountingComponentLabel,
  formatAccountingQuantity,
  getAccountingEntryLabel,
} from "./accounting-format.js";
import { sanitizeSingleLineDisplayText } from "./display-sanitize.js";
import {
  type AccountingSemantic,
  isBooleanEntry,
  isPercentEntry,
  isQuantityEntry,
  isValueEntry,
  type QuotaPercentEntry,
  type QuotaToastEntry,
} from "./entries.js";
import {
  formatDisplayedPercentLabel,
  formatResetCountdown,
  isResetTimeDecimals,
} from "./format-utils.js";
import { formatGroupedHeader } from "./grouped-header-format.js";
import {
  classifyQuotaWindowText,
  extractSingleWindowWindowLabel,
  normalizeSingleWindowLabelText,
} from "./quota-entry-display.js";
import { compareQuotaRunwayUrgency, formatQuotaRunway } from "./quota-exhaustion-projection.js";
import type { QuotaRenderData } from "./quota-render-data.js";
import type { PromptBarEntry } from "./tui-panel-state.js";
import type { PercentDisplayMode } from "./types.js";

/** Prompt-bar fill is a fixed 12-cell bar. There is no width setting. */
export const PROMPT_BAR_WIDTH = 12;
export const PROMPT_BAR_MAX_LABEL_WIDTH = 50;

const ELLIPSIS = "…";
const FALLBACK_IDENTITY_LABEL = "Quota";

type PromptBarIdentityFields = Pick<PromptBarEntry, "name" | "group" | "label"> & {
  semantic?: AccountingSemantic;
};

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function truncateSingleLine(text: string, maxWidth: number): string {
  const width = Math.max(0, Math.trunc(maxWidth));
  const singleLine = sanitizeSingleLineDisplayText(text);
  if (width === 0) return "";
  if (singleLine.length <= width) return singleLine;
  if (width === 1) return ELLIPSIS;
  return `${singleLine.slice(0, width - ELLIPSIS.length).trimEnd()}${ELLIPSIS}`;
}

function stripWindowSuffix(text: string, window: string): string {
  return sanitizeSingleLineDisplayText(
    text.replace(new RegExp(`\\s+${escapeRegExp(window)}\\s*$`, "iu"), ""),
  );
}

function identityNameText(entry: PromptBarIdentityFields): string {
  return sanitizeSingleLineDisplayText((entry.name ?? "").replace(/^\[([^\]]+)\]/u, "$1"));
}

function getNamedOrComponentMetricText(semantic: AccountingSemantic | undefined): string | null {
  const metric = semantic?.metric;
  if (metric?.kind === "named") {
    const name = metric.name.trim();
    return name ? sanitizeSingleLineDisplayText(name) : null;
  }
  if (metric?.kind === "component") {
    if (metric.component === "remaining_credits") return "Credits";
    return formatAccountingComponentLabel(metric.component);
  }
  return null;
}

function joinPromptBarIdentity(provider: string, metric: string | null, name: string): string {
  if (metric) {
    if (!provider) return metric;
    const providerLower = provider.toLowerCase();
    const metricLower = metric.toLowerCase();
    if (providerLower === metricLower || providerLower.endsWith(` ${metricLower}`)) {
      return provider;
    }
    return `${provider} ${metric}`;
  }
  return name || provider || FALLBACK_IDENTITY_LABEL;
}

export function getPromptBarProviderText(entry: PromptBarIdentityFields): string {
  const group = entry.group?.trim();
  if (group) {
    return sanitizeSingleLineDisplayText(
      formatGroupedHeader(group).replace(/^\[([^\]]+)\]/u, "$1"),
    );
  }

  const name = sanitizeSingleLineDisplayText(entry.name ?? "");
  if (!name) return "";

  const strippedBrackets = name.replace(/^\[([^\]]+)\]/u, "$1");
  const window =
    extractSingleWindowWindowLabel(entry.label ?? "") ?? extractSingleWindowWindowLabel(name);
  if (window) {
    return stripWindowSuffix(strippedBrackets, window) || strippedBrackets;
  }
  return strippedBrackets;
}

export function getPromptBarWindowText(entry: PromptBarIdentityFields): string | null {
  const classifiedLabel = extractSingleWindowWindowLabel(entry.label ?? "");
  if (classifiedLabel) return classifiedLabel;

  const strippedLabel = normalizeSingleWindowLabelText(entry.label);
  if (strippedLabel) return sanitizeSingleLineDisplayText(strippedLabel);

  const semanticMetric = getNamedOrComponentMetricText(entry.semantic);
  if (semanticMetric) return semanticMetric;

  return extractSingleWindowWindowLabel(entry.name ?? "");
}

function fitPromptBarIdentityLabel(
  full: string,
  provider: string,
  window: string | null,
  maxWidth: number,
): string {
  const width = Math.max(0, Math.trunc(maxWidth));
  if (full.length <= width) return full;
  if (width === 0) return "";
  if (width === 1) return ELLIPSIS;

  if (provider && window) {
    const suffix = ` ${window}`;
    const prefixWidth = width - suffix.length;
    if (prefixWidth >= 2) {
      return sanitizeSingleLineDisplayText(`${truncateSingleLine(provider, prefixWidth)}${suffix}`);
    }
  }

  return truncateSingleLine(full, width);
}

export function formatPromptBarIdentityLabel(
  entry: PromptBarIdentityFields,
  maxWidth: number = PROMPT_BAR_MAX_LABEL_WIDTH,
): string {
  const provider = getPromptBarProviderText(entry);
  const window = getPromptBarWindowText(entry);
  const full = joinPromptBarIdentity(provider, window, identityNameText(entry));
  return fitPromptBarIdentityLabel(full, provider, window, maxWidth);
}

export function resolvePromptBarLabel(entry: PromptBarEntry): string {
  const hasPercent = Number.isFinite(entry.percentRemaining);
  if (entry.semanticSegment && !hasPercent) return entry.semanticSegment;
  return entry.identityLabel ?? formatPromptBarIdentityLabel(entry);
}

export function formatPromptBarPercentMeta(params: {
  percentRemaining: number;
  percentDisplayMode?: PercentDisplayMode;
  resetTimeIso?: string;
  resetTimeDecimals?: number;
  resetTimeSpaced?: boolean;
  runway?: PromptBarEntry["runway"];
}): string {
  const percent = formatDisplayedPercentLabel(
    params.percentRemaining,
    params.percentDisplayMode ?? "remaining",
    "bare",
  );
  const reset = params.resetTimeIso
    ? formatResetCountdown(
        params.resetTimeIso,
        isResetTimeDecimals(params.resetTimeDecimals)
          ? { compactRounded: true, decimals: params.resetTimeDecimals }
          : { spaced: params.resetTimeSpaced },
      )
    : "";
  const runway = formatQuotaRunway(params.runway);
  return [percent, reset, runway ? `r/o ${runway}` : ""].filter(Boolean).join(" | ");
}

function fitPromptBarSemanticSegment(prefix: string, value: string): string | null {
  const full = sanitizeSingleLineDisplayText(`${prefix} ${value}`);
  if (!full) return null;
  if (full.length <= PROMPT_BAR_MAX_LABEL_WIDTH) return full;
  return fitPromptBarIdentityLabel(full, prefix, value, PROMPT_BAR_MAX_LABEL_WIDTH) || null;
}

function buildSemanticPromptBarEntry(entry: QuotaToastEntry): PromptBarEntry | undefined {
  if (!entry.semantic || entry.semantic.prominence !== "primary") return undefined;
  if (isPercentEntry(entry) && Number.isFinite(entry.percentRemaining)) return undefined;

  const value = isQuantityEntry(entry)
    ? formatAccountingQuantity(entry.quantity)
    : isBooleanEntry(entry)
      ? formatAccountingBoolean(entry.value, entry.semantic)
      : isValueEntry(entry)
        ? entry.value
        : null;
  if (!value) return undefined;

  const provider = getPromptBarProviderText(entry);
  const label = getAccountingEntryLabel(entry);
  const prefix = sanitizeSingleLineDisplayText(
    provider && provider !== label ? `${provider}: ${label}` : label,
  );
  const semanticSegment = fitPromptBarSemanticSegment(prefix, value);
  if (!semanticSegment) return undefined;

  return {
    semanticSegment,
    ...(entry.resetTimeIso ? { resetTimeIso: entry.resetTimeIso } : {}),
  };
}

function toPercentPromptBarEntry(entry: QuotaPercentEntry): PromptBarEntry {
  return {
    identityLabel: formatPromptBarIdentityLabel(entry),
    name: entry.name,
    ...(entry.group?.trim() ? { group: entry.group } : {}),
    ...(entry.label?.trim() ? { label: entry.label } : {}),
    percentRemaining: entry.percentRemaining,
    ...(entry.resetTimeIso ? { resetTimeIso: entry.resetTimeIso } : {}),
    ...(entry.runway ? { runway: entry.runway } : {}),
    accounting: entry.accounting,
  };
}

export function pickPromptBarEntry(data: QuotaRenderData | null): PromptBarEntry | undefined {
  if (!data || !Array.isArray(data.entries)) {
    return undefined;
  }

  for (const entry of data.entries) {
    if (
      isPercentEntry(entry) &&
      Number.isFinite(entry.percentRemaining) &&
      entry.semantic?.prominence === "primary"
    ) {
      return toPercentPromptBarEntry(entry);
    }
    const semantic = buildSemanticPromptBarEntry(entry);
    if (semantic) return semantic;
  }

  const projected = data.entries
    .map((entry, index) => ({ entry, index }))
    .filter(
      ({ entry }) =>
        isPercentEntry(entry) && Number.isFinite(entry.percentRemaining) && Boolean(entry.runway),
    )
    .sort(
      (left, right) =>
        compareQuotaRunwayUrgency(
          isPercentEntry(left.entry) ? left.entry.runway : undefined,
          isPercentEntry(right.entry) ? right.entry.runway : undefined,
        ) || left.index - right.index,
    );
  const urgent = projected[0]?.entry;
  if (urgent && isPercentEntry(urgent)) return toPercentPromptBarEntry(urgent);

  let fallback: QuotaPercentEntry | undefined;
  for (const entry of data.entries) {
    if (entry.semantic || !isPercentEntry(entry) || !Number.isFinite(entry.percentRemaining)) {
      continue;
    }
    const kind = classifyQuotaWindowText(entry.label ?? "") ?? classifyQuotaWindowText(entry.name);
    if (kind === "five_hour") {
      return toPercentPromptBarEntry(entry);
    }
    if (!fallback || entry.percentRemaining < fallback.percentRemaining) {
      fallback = entry;
    }
  }
  return fallback ? toPercentPromptBarEntry(fallback) : undefined;
}
