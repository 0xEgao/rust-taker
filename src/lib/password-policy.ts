export const MIN_WALLET_PASSWORD_LENGTH = 8;

export function validateNewPassword(password: string, confirmation: string): string | undefined {
  if (!password.trim()) return "Enter a wallet password.";
  if ([...password].length < MIN_WALLET_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_WALLET_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirmation) return "Passwords do not match.";
  return undefined;
}
