import { ApiError } from "./errors";
import { getHeader } from "./request";
import { RouteDefinition, RouteHandler, RouteOptions, RouteRequest } from "../types";

interface MatchResult {
  route: RouteDefinition;
  pathParams: Record<string, string>;
}

export class Router {
  private readonly routes: RouteDefinition[] = [];

  get(pattern: string, handler: RouteHandler, options: RouteOptions = {}): void {
    this.routes.push({ method: "GET", pattern, handler, options });
  }

  post(pattern: string, handler: RouteHandler, options: RouteOptions = {}): void {
    this.routes.push({ method: "POST", pattern, handler, options });
  }

  put(pattern: string, handler: RouteHandler, options: RouteOptions = {}): void {
    this.routes.push({ method: "PUT", pattern, handler, options });
  }

  match(request: Pick<RouteRequest, "method" | "path">): MatchResult {
    for (const route of this.routes) {
      if (route.method !== request.method) {
        continue;
      }

      const pathParams = matchPattern(route.pattern, request.path);
      if (pathParams) {
        return { route, pathParams };
      }
    }

    throw new ApiError(404, "not_found", "Endpoint not found.");
  }
}

export function assertRouteHardening(request: RouteRequest, options: RouteOptions): void {
  if (options.requireIdempotencyKey) {
    const key = getHeader(request.headers, "idempotency-key");
    if (!key || key.length < 16 || key.length > 128) {
      throw new ApiError(400, "missing_idempotency_key", "A valid Idempotency-Key header is required.");
    }
  }

  if (options.rejectQuerySecrets) {
    const forbiddenKeys = ["secret", "token", "api_key", "apikey", "key", "password", "auth"];
    const found = forbiddenKeys.find((key) => Object.prototype.hasOwnProperty.call(request.query, key));
    if (found) {
      throw new ApiError(400, "query_secret_not_allowed", `Query-string secret '${found}' is not allowed.`);
    }
  }
}

function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const patternParts = splitPath(pattern);
  const pathParts = splitPath(path);

  if (patternParts.length !== pathParts.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    const actual = pathParts[index];

    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }

    if (expected !== actual) {
      return null;
    }
  }

  return params;
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}
