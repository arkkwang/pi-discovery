// A directory is not a ranked recommendation and never implies tool activation.
export const directoryHint = 'Unranked full capability catalog; confidence is null. Read Skill files before use. '
  + 'Listing does not load tools or authorize execution; use an exact name to load the tools you need.';

export function fullCatalogFallback(catalog, error) {
  return {
    fallback: 'full-catalog',
    routingError: String(error?.message ?? error),
    suggestions: catalog.map(c => ({ ...c, confidence: null })),
    hint: directoryHint,
  };
}
