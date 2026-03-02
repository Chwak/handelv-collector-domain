/**
 * Utility functions for creating standardized API responses
 */

export interface ApiResponse<T = any> {
  statusCode: number;
  body: string;
  headers?: { [key: string]: string };
}

export interface SuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
}

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
}

/**
 * Create a successful API response
 */
export function createSuccessResponse<T>(
  data: T,
  statusCode: number = 200,
  message?: string
): ApiResponse<SuccessResponse<T>> {
  const response: SuccessResponse<T> = {
    success: true,
    data,
    ...(message && { message }),
  };

  return {
    statusCode,
    body: JSON.stringify(response),
    headers: {
      'Content-Type': 'application/json',
    },
  };
}

/**
 * Create an error API response
 */
export function createErrorResponse(
  code: string,
  message: string,
  statusCode: number = 400,
  details?: any
): ApiResponse<ErrorResponse> {
  const response: ErrorResponse = {
    success: false,
    error: {
      code,
      message,
      ...(details && { details }),
    },
  };

  return {
    statusCode,
    body: JSON.stringify(response),
    headers: {
      'Content-Type': 'application/json',
    },
  };
}

/**
 * Create a paginated response
 */
export interface PaginatedResponse<T> {
  items: T[];
  nextToken?: string;
  totalCount?: number;
}

export function createPaginatedResponse<T>(
  items: T[],
  nextToken?: string,
  totalCount?: number
): ApiResponse<SuccessResponse<PaginatedResponse<T>>> {
  const data: PaginatedResponse<T> = {
    items,
    ...(nextToken && { nextToken }),
    ...(totalCount !== undefined && { totalCount }),
  };

  return createSuccessResponse(data);
}
