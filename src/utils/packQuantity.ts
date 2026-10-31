/**
 * How many retail units are inside the price printed on a line.
 * "4/6/12 OZ" is 4 six-packs (24). "15/16 OZ" is 15 bottles. "case of 12" is 12.
 * Returns null when the name does not say, so we ask instead of guessing.
 */
export function inferPackQuantity(name: string): number | null {
  const text = name.toLowerCase();

  const caseOf = text.match(/case of\s+(\d+)/);
  if (caseOf?.[1]) return positive(caseOf[1]);

  const triple = text.match(/(\d+)\s*\/\s*(\d+)\s*\/\s*\d+(?:\.\d+)?\s*oz/);
  if (triple?.[1] && triple[2]) return positive(Number(triple[1]) * Number(triple[2]));

  const pair = text.match(/(\d+)\s*\/\s*\d+(?:\.\d+)?\s*oz/);
  if (pair?.[1]) return positive(pair[1]);

  const labeled = text.match(/(\d+)\s*(?:pk|pack|ct)\b/);
  if (labeled?.[1]) return positive(labeled[1]);

  return null;
}

function positive(value: number | string): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
