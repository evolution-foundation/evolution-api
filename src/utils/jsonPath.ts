import { configService, Database } from '@config/env.config';

/**
 * Prisma takes the path of a JSON field filter as an array on PostgreSQL (`['id']`)
 * but as a JSONPath string on MySQL (`'$.id'`).
 */
export const jsonPath = (field: string): any =>
  configService.get<Database>('DATABASE').PROVIDER === 'mysql' ? `$.${field}` : [field];
