// Pull the things a test usually needs out of an email: its links, the one that most likely
// confirms or resets something, and one-time codes.

const LINK_PATTERN = /https?:\/\/[^\s"'<>)\]]+/g;
const ACTION_WORDS = /(verif|confirm|activat|reset|magic|login|log-in|sign-?in|sign-?up|invite|token|auth|validate|unsubscribe)/i;
const CODE_CONTEXT = /(code|otp|one[- ]time|passcode|pin|verification|security|2fa|mfa|token)/i;

export function extractLinks(text: string, known: string[] = []): string[] {
    const found = [...known, ...(text.match(LINK_PATTERN) || [])]
        .map((link) => link.replace(/[.,;:!?]+$/, ''));
    return [...new Set(found)];
}

/** The link most likely to be the one a signup or reset test should follow, if any. */
export function pickActionLink(links: string[]): string | null {
    const scored = links
        .filter((link) => !/unsubscribe|preferences|privacy|terms/i.test(link))
        .map((link) => ({ link, score: ACTION_WORDS.test(link) ? 2 : 0 }))
        .filter((item) => item.score > 0);
    return scored.length ? scored[0].link : null;
}

/**
 * Candidate one-time codes: standalone 4–8 digit numbers, plus short uppercase letter/digit codes
 * near words like "code" or "OTP". Codes on a line that mentions a code come first.
 */
export function extractCodes(text: string): string[] {
    const withContext: string[] = [];
    const without: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        const hasContext = CODE_CONTEXT.test(line);
        const digits = line.match(/(?<![\d.,/:#$-])\d{4,8}(?!\d|[.,/:-]\d)/g) || [];
        const mixed = hasContext ? line.match(/\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{3,4}-?[A-Z0-9]{3,4}\b/g) || [] : [];
        for (const code of [...digits, ...mixed]) {
            if (/^(19|20)\d{2}$/.test(code) && !hasContext) continue; // likely a year
            (hasContext ? withContext : without).push(code);
        }
    }
    return [...new Set([...withContext, ...without])].slice(0, 10);
}
