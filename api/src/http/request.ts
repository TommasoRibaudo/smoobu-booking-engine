import { randomUUID } from "crypto";
import { ApiError } from "./errors";
import { HeadersMap, HttpMethod, LambdaHttpRequest } from "../types";

export function normalizeHeaders(headers: LambdaHttpRequest["headers"]): HeadersMap {
  const normalized: HeadersMap = {};

  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
    }
  }

  return normalized;
}

export function getHeader(headers: HeadersMap, name: string): string | undefined {
  return headers[name.toLowerCase()];
}

export function getMethod(event: LambdaHttpRequest): HttpMethod {
  const method = event.httpMethod ?? event.requestContext?.http?.method ?? event.routeKey?.split(" ")[0] ?? "GET";
  const upper = method.toUpperCase();

  if (["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(upper)) {
    return upper as HttpMethod;
  }

  throw new ApiError(405, "method_not_allowed", "HTTP method is not allowed.");
}

export function getPath(event: LambdaHttpRequest): string {
  const rawPath = event.rawPath ?? event.path ?? event.requestContext?.http?.path ?? "/";
  const normalized = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  return normalized.replace(/\/+$/, "") || "/";
}

export function getQuery(event: LambdaHttpRequest): Record<string, string> {
  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }

  return result;
}

export function getCorrelationId(headers: HeadersMap): string {
  const provided = getHeader(headers, "x-correlation-id");
  if (provided && provided.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(provided)) {
    return provided;
  }

  return randomUUID();
}

export function getRawBody(event: LambdaHttpRequest, maxBodyBytes: number): string {
  if (!event.body) {
    return "";
  }

  const bytes = event.isBase64Encoded
    ? Buffer.from(event.body, "base64")
    : Buffer.from(event.body, "utf8");

  if (bytes.length > maxBodyBytes) {
    throw new ApiError(413, "payload_too_large", "Request body is too large.");
  }

  return bytes.toString("utf8");
}

export function parseJsonBody(
  rawBody: string,
  headers: HeadersMap,
  required: boolean,
  allowFormEncodedBody = false
): unknown {
  if (!rawBody) {
    if (required) {
      throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
    }

    return undefined;
  }

  const contentType = getHeader(headers, "content-type");

  // Form-encoded bodies are left unparsed for the handler to read from rawBody.
  if (allowFormEncodedBody && contentType?.toLowerCase().includes("application/x-www-form-urlencoded")) {
    return undefined;
  }

  if (!contentType?.toLowerCase().includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "Content-Type must be application/json.");
  }

  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

export function getClientIp(event: LambdaHttpRequest): string | undefined {
  return event.requestContext?.http?.sourceIp ?? event.requestContext?.identity?.sourceIp;
}

export function getUserAgent(event: LambdaHttpRequest, headers: HeadersMap): string | undefined {
  return (
    event.requestContext?.http?.userAgent ??
    event.requestContext?.identity?.userAgent ??
    getHeader(headers, "user-agent")
  );
}
