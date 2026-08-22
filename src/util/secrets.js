// Single source of truth for "never read, never persist" filename/dirname patterns.
// Imported by the walker (skip descending) and every inspector (skip opening).

const SECRET_FILENAME_PATTERNS = [
  /^\.env$/i,
  /^\.env\..+$/i,
  /^credentials.*$/i,
  /^secrets.*$/i,
  /\.pem$/i,
  /\.key$/i,
  /^id_rsa$/i,
  /^id_rsa\.pub$/i,
  /^id_ed25519$/i,
  /^id_ed25519\.pub$/i,
  /^cookies.*$/i,
];

const SECRET_DIRNAME_PATTERNS = [
  /wallet/i,
  /^Login Data$/i, // Chromium browser profile credential store
  /^Cookies$/i,
  /^\.aws$/i,
  /^\.ssh$/i,
  /^\.gnupg$/i,
];

export function isSecretFileName(name) {
  return SECRET_FILENAME_PATTERNS.some((re) => re.test(name));
}

export function isSecretDirName(name) {
  return SECRET_DIRNAME_PATTERNS.some((re) => re.test(name));
}

export function isSecretPath(name) {
  return isSecretFileName(name) || isSecretDirName(name);
}
