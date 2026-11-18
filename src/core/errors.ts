export const EXIT = {
  SUCCESS: 0,
  UNEXPECTED: 1,
  USAGE: 2,
  PRECONDITION: 3,
  LOCKED: 4,
  VERIFY: 5,
  ROLLED_BACK: 6,
  NEEDS_HUMAN: 7,
  CONFIRM: 8,
  NOT_FOUND: 9,
} as const;
export class OmaError extends Error {
  constructor(
    public code: string,
    message: string,
    public exitCode: number = 1,
    public hint?: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  code: string,
  message: string,
  exitCode = 3,
): asserts condition {
  if (!condition) throw new OmaError(code, message, exitCode);
}
export function asError(error: unknown): OmaError {
  return error instanceof OmaError
    ? error
    : new OmaError('UNEXPECTED', error instanceof Error ? error.message : String(error));
}
