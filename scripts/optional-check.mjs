const [name, message] = process.argv.slice(2);

if (!name || !message) {
  console.error("Usage: optional-check.mjs <name> <message>");
  process.exit(2);
}

console.log(`${name}: skipped. ${message}`);
