import type { ProviderErrorKind } from "../../../core/ports/model-provider.ts";

const KIND_BY_ERROR_TYPE = new Map<string, ProviderErrorKind>([
  ["authentication_error", "auth"],
  ["permission_error", "auth"],
  ["billing_error", "auth"],
  ["rate_limit_error", "rate_limit"],
  ["overloaded_error", "overloaded"],
  ["api_error", "overloaded"],
  ["invalid_request_error", "invalid_request"],
]);

export function kindForErrorType(errorType: string): ProviderErrorKind {
  return KIND_BY_ERROR_TYPE.get(errorType) ?? "invalid_request";
}
