import { ConfigService, Database } from '@config/env.config';
import { Logger } from '@config/logger.config';
import { Prisma, PrismaClient } from '@prisma/client';

export class Query<T> {
  where?: T;
  sort?: 'asc' | 'desc';
  page?: number;
  offset?: number;
}

export class PrismaRepository extends PrismaClient {
  constructor(private readonly configService: ConfigService) {
    super();
  }

  private readonly logger = new Logger('PrismaRepository');

  public get isMysql(): boolean {
    return this.configService.get<Database>('DATABASE').PROVIDER === 'mysql';
  }

  public jsonPath(...segments: string[]): Prisma.JsonFilterBase<'Message'>['path'] {
    // Prisma generates a different path type for each provider; match that provider at runtime.
    const path = this.isMysql ? '$' + segments.map((segment) => `.${JSON.stringify(segment)}`).join('') : segments;
    return path as Prisma.JsonFilterBase<'Message'>['path'];
  }

  public async onModuleInit() {
    await this.$connect();
    this.logger.info('Repository:Prisma - ON');
  }

  public async onModuleDestroy() {
    await this.$disconnect();
    this.logger.warn('Repository:Prisma - OFF');
  }
}
