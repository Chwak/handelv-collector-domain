/**
 * Utility functions for input validation
 */

export interface ValidationError {
  field: string;
  message: string;
}

export class ValidationException extends Error {
  constructor(
    public errors: ValidationError[],
    message: string = 'Validation failed'
  ) {
    super(message);
    this.name = 'ValidationException';
  }
}

/**
 * Validate required fields
 */
export function validateRequired(
  data: Record<string, any>,
  fields: string[]
): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const field of fields) {
    if (data[field] === undefined || data[field] === null || data[field] === '') {
      errors.push({
        field,
        message: `${field} is required`,
      });
    }
  }

  return errors;
}

/**
 * Validate string length
 */
export function validateStringLength(
  value: string | undefined,
  field: string,
  min?: number,
  max?: number
): ValidationError[] {
  const errors: ValidationError[] = [];

  if (value === undefined || value === null) {
    return errors;
  }

  if (min !== undefined && value.length < min) {
    errors.push({
      field,
      message: `${field} must be at least ${min} characters`,
    });
  }

  if (max !== undefined && value.length > max) {
    errors.push({
      field,
      message: `${field} must be at most ${max} characters`,
    });
  }

  return errors;
}

/**
 * Validate email format
 */
export function validateEmail(email: string | undefined, field: string = 'email'): ValidationError[] {
  const errors: ValidationError[] = [];

  if (email === undefined || email === null) {
    return errors;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    errors.push({
      field,
      message: `${field} must be a valid email address`,
    });
  }

  return errors;
}

/**
 * Validate UUID format
 */
export function validateUUID(uuid: string | undefined, field: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (uuid === undefined || uuid === null) {
    return errors;
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(uuid)) {
    errors.push({
      field,
      message: `${field} must be a valid UUID`,
    });
  }

  return errors;
}

/**
 * Validate ISO 8601 date format
 */
export function validateISO8601Date(date: string | undefined, field: string): ValidationError[] {
  const errors: ValidationError[] = [];

  if (date === undefined || date === null) {
    return errors;
  }

  const dateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/;
  if (!dateRegex.test(date)) {
    errors.push({
      field,
      message: `${field} must be a valid ISO 8601 date`,
    });
  }

  return errors;
}

/**
 * Validate and throw if errors exist
 */
export function validateOrThrow(errors: ValidationError[]): void {
  if (errors.length > 0) {
    throw new ValidationException(errors);
  }
}
