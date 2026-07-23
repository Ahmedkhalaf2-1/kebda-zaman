// Loads .env into process.env so these integration tests can reach the same
// Docker PostgreSQL instance the app uses (Node's built-in loader; no extra
// dependency needed — DATABASE_URL falls back to whatever is already exported
// in the shell if no .env file is present).
try {
  process.loadEnvFile();
} catch {
  // No .env file found — assume DATABASE_URL is already set in the environment.
}
