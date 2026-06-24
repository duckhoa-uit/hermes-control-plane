// Simple ID generators (no crypto dependency for testability)

let counter = 0;

export function generateId(prefix: string): string {
  counter++;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function generateSessionId(): string {
  return generateId("sess");
}

export function generateCommandId(): string {
  return generateId("cmd");
}

export function generateRequestId(): string {
  return generateId("req");
}

export function generateRunnerToken(): string {
  // Use Web Crypto API available in Workers runtime
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
