// Preflight: the server runs TypeScript via Node's built-in type stripping,
// which needs Node >= 24. Under older majors that surfaces as a cryptic
// ERR_UNKNOWN_FILE_EXTENSION — fail here with the actual fix instead.
// CJS on purpose: parses under any Node version.
const major = Number(process.versions.node.split(".")[0]);
if (major < 24) {
  console.error(
    `antiphon needs Node 24+ (found v${process.versions.node}).\n` +
      "Fix: nvm use 24   (or: nvm alias default 24)",
  );
  process.exit(1);
}
