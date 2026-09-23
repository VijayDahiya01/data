import { Module } from '@nestjs/common';
import { S3Client } from '@aws-sdk/client-s3';
import { CreativeService, S3 } from './creative.service.js';
import { CreativeController } from './creative.controller.js';
import { CONFIG, type OolixConfig } from '../../config/configuration.js';

@Module({
  controllers: [CreativeController],
  providers: [
    {
      provide: S3,
      inject: [CONFIG],
      useFactory: (config: OolixConfig) =>
        new S3Client({
          region: config.AWS_REGION,
          // LocalStack locally; the real endpoint is derived from the region
          // in hosted environments.
          ...(config.AWS_ENDPOINT_URL
            ? { endpoint: config.AWS_ENDPOINT_URL, forcePathStyle: true }
            : {}),
        }),
    },
    CreativeService,
  ],
  exports: [CreativeService],
})
export class CreativeModule {}
