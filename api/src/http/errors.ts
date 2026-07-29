import { FieldErrors } from "../types";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly fieldErrors?: FieldErrors;
  readonly retryable: boolean;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { fieldErrors?: FieldErrors; retryable?: boolean } = {}
  ) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.fieldErrors = options.fieldErrors;
    this.retryable = options.retryable ?? false;
  }
}

export function validationError(fieldErrors: FieldErrors): ApiError {
  return new ApiError(422, "validation_failed", "Please check the highlighted fields.", {
    fieldErrors,
  });
}

export function notImplemented(message: string): ApiError {
  return new ApiError(501, "not_implemented", message, { retryable: false });
}
