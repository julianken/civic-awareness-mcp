export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new ConfigurationError(
      `Required environment variable ${name} is not set. See README for setup; this server cannot function without API keys.`,
    );
  }
  return v;
}

export function optionalEnv(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}
