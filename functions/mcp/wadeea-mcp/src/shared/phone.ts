// UAE phone handling. normalizeUae accepts every format a caller plausibly
// gives (+971…, 00971…, 971…, local 05x…) and returns the canonical +971…
// form, or null when the number is not UAE. Keeping this in code (not in the
// prompt) is what lets the workflow prompts stay short: the tool understands
// formats so the model doesn't have to.

// Country code 971, then 7–9 subscriber digits (mobiles 5x + 7 digits,
// landlines area code + 7 digits).
const UAE = /^971\d{7,9}$/;

export function normalizeUae(raw: string): string | null {
  let digits = raw.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  else if (digits.startsWith("00")) digits = digits.slice(2);
  else if (/^0\d{9}$/.test(digits)) digits = "971" + digits.slice(1); // local 05x xxx xxxx
  return UAE.test(digits) ? "+" + digits : null;
}

export function isUaeNumber(raw: string): boolean {
  return normalizeUae(raw) !== null;
}
