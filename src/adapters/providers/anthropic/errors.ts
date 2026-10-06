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

export function kindForStatus(status: number): ProviderErrorKind {
  switch (status) {
    case 401:
    case 402:
    case 403:
      return "auth";
    case 429:
      return "rate_limit";
    case 500:
    case 502:
    case 503:
    case 504:
    case 529:
      return "overloaded";
    default:
      return "invalid_request";
  }
}
