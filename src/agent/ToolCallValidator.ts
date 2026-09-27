import { ToolCall, JSONSchema } from '../types/index.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  sanitizedInput?: unknown;
}

export class ToolCallValidator {
  static validate(toolCall: ToolCall, schema: JSONSchema): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let sanitizedInput: unknown = toolCall.input;

    if (toolCall.input === undefined || toolCall.input === null) {
      if (schema.required && schema.required.length > 0) {
        errors.push('Input is required but was not provided');
        return { valid: false, errors, warnings };
      }
      return { valid: true, errors, warnings, sanitizedInput: {} };
    }

    const inputType = Array.isArray(toolCall.input) ? 'array' : typeof toolCall.input;
    if (schema.type && schema.type !== inputType) {
      errors.push(`Expected ${schema.type}, got ${inputType}`);
      return { valid: false, errors, warnings };
    }

    if (schema.type === 'object' && typeof toolCall.input === 'object' && !Array.isArray(toolCall.input)) {
      const result = this.validateObject(toolCall.input as Record<string, unknown>, schema);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
      sanitizedInput = result.sanitizedInput;
    }

    if (schema.type === 'array' && Array.isArray(toolCall.input)) {
      const result = this.validateArray(toolCall.input, schema);
      errors.push(...result.errors);
      warnings.push(...result.warnings);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      sanitizedInput,
    };
  }

  private static validateObject(
    input: Record<string, unknown>,
    schema: JSONSchema
  ): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const sanitizedInput: Record<string, unknown> = {};

    if (schema.required) {
      for (const field of schema.required) {
        if (!(field in input)) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    if (schema.properties) {
      for (const [key, value] of Object.entries(input)) {
        const propSchema = schema.properties[key] as (JSONSchema & { enum?: unknown[]; pattern?: string }) | undefined;

        if (!propSchema) {
          warnings.push(`Unknown field: ${key}`);
          continue;
        }

        const actualType = Array.isArray(value) ? 'array' : typeof value;
        if (propSchema.type && propSchema.type !== actualType) {
          errors.push(`Field '${key}' should be ${propSchema.type}, got ${actualType}`);
          continue;
        }

        if (propSchema.type === 'string' && typeof value === 'string') {
          if (propSchema.minLength && value.length < propSchema.minLength) {
            errors.push(`Field '${key}' must be at least ${propSchema.minLength} characters`);
          }
          if (propSchema.maxLength && value.length > propSchema.maxLength) {
            errors.push(`Field '${key}' must be at most ${propSchema.maxLength} characters`);
          }
          if (propSchema.pattern) {
            const regex = new RegExp(propSchema.pattern);
            if (!regex.test(value)) {
              errors.push(`Field '${key}' does not match pattern: ${propSchema.pattern}`);
            }
          }
        }

        if (propSchema.type === 'number' && typeof value === 'number') {
          if (propSchema.minimum !== undefined && value < propSchema.minimum) {
            errors.push(`Field '${key}' must be at least ${propSchema.minimum}`);
          }
          if (propSchema.maximum !== undefined && value > propSchema.maximum) {
            errors.push(`Field '${key}' must be at most ${propSchema.maximum}`);
          }
        }

        if (propSchema.enum && !propSchema.enum.includes(value)) {
          errors.push(`Field '${key}' must be one of: ${propSchema.enum.join(', ')}`);
        }

        sanitizedInput[key] = this.sanitizeValue(value, propSchema);
      }
    }

    return { valid: errors.length === 0, errors, warnings, sanitizedInput };
  }

  private static validateArray(input: unknown[], schema: JSONSchema): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (schema.minItems && input.length < schema.minItems) {
      errors.push(`Array must have at least ${schema.minItems} items`);
    }

    if (schema.maxItems && input.length > schema.maxItems) {
      errors.push(`Array must have at most ${schema.maxItems} items`);
    }

    if (schema.items) {
      input.forEach((item, index) => {
        const itemSchema = schema.items as JSONSchema;
        const itemType = Array.isArray(item) ? 'array' : typeof item;

        if (itemSchema.type && itemSchema.type !== itemType) {
          errors.push(`Item at index ${index} should be ${itemSchema.type}, got ${itemType}`);
        }
      });
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  private static sanitizeValue(value: unknown, schema: JSONSchema): unknown {
    if (schema.type === 'string' && typeof value === 'string') {
      return value.trim();
    }

    if (schema.type === 'number' && typeof value === 'number') {
      if (!isFinite(value)) {
        return 0;
      }
    }

    return value;
  }

  static checkSafety(toolCall: ToolCall): { safe: boolean; issues: string[] } {
    const issues: string[] = [];

    const inputStr = JSON.stringify(toolCall.input);

    if (inputStr.includes('../') || inputStr.includes('..\\')) {
      issues.push('Potential path traversal detected');
    }

    if (inputStr.length > 1000000) {
      issues.push('Input size exceeds safe limit (1MB)');
    }

    return {
      safe: issues.length === 0,
      issues,
    };
  }
}
