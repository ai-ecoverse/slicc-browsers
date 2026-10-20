export function redactProtectedURLs(value, matcher) {
  if (typeof value === 'string')
    return value.replace(/https?:\/\/[^\s<>"'\\]+/gi, (text) => {
      const suffix = /[);,]+$/.exec(text)?.[0] ?? '';
      const url = text.slice(0, text.length - suffix.length);
      try {
        return matcher.url(url, { readOnly: true }) ? `${new URL(url).origin}${suffix}` : text;
      } catch {
        return text;
      }
    });
  if (Array.isArray(value)) return value.map((entry) => redactProtectedURLs(entry, matcher));
  if (value && typeof value === 'object') {
    const protectedURL =
      typeof value.url === 'string' && matcher.url(value.url, { readOnly: true });
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        redactProtectedURLs(key, matcher),
        key === 'urlFragment' && protectedURL ? '' : redactProtectedURLs(entry, matcher),
      ])
    );
  }
  return value;
}
