/**
 * Zod validation -- spec v5 §53, §82.
 *
 * §82: "Schema validation for every request". Failures surface as VAL_001 with
 * per-field detail through the global exception filter, so no controller
 * hand-rolls a validation response.
 */
import { PipeTransform, type ArgumentMetadata } from '@nestjs/common';
import type { ZodType } from 'zod';

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown, _metadata: ArgumentMetadata): T {
    // Throws ZodError, which OolixExceptionFilter maps to VAL_001.
    return this.schema.parse(value);
  }
}

export const zodBody = <T>(schema: ZodType<T>) => new ZodValidationPipe(schema);
