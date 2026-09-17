const MAX_TEXT = 2000;

/** Strip obvious credential shapes before any text leaves the machine. */
export function redact(text: string): string {
  return text
    .replace(/(authorization\s*:\s*)\S+/giu, "$1[redacted]")
    .replace(/([A-Za-z0-9_]*_(?:TOKEN|KEY|SECRET)\s*=\s*)\S+/gu, "$1[redacted]");
}

/** Clip long text for model state, marking the cut. */
export const clip = (text: string, limit = MAX_TEXT): string =>
  text.length <= limit ? text : `${text.slice(0, limit)} … [clipped]`;
