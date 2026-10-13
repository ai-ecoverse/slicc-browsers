export function isSevenLabel(seven, label) {
  if (!label) return false;
  if (seven.excludedLabels?.includes(label)) return false;
  if (seven.excludedLabelPrefixes?.some((p) => label.startsWith(p))) return false;
  return true;
}
