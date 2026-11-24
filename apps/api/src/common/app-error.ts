export class AppError extends Error {
  code: string;
  status: number;
  /** Structured payload clients need to resolve the error (candidates, headings, revisions). */
  details?: Record<string, unknown>;

  constructor(code: string, message: string, status = 400, details?: Record<string, unknown>) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.status = status;
    if (details) this.details = details;
  }
}
