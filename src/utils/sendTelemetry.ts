import { configService, Telemetry } from '@config/env.config';
import axios from 'axios';
import fs from 'fs';

const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));

export interface TelemetryData {
  route: string;
  apiVersion: string;
  timestamp: Date;
}

export const sendTelemetry = async (route: string): Promise<void> => {
  const telemetryConfig = configService.get<Telemetry>('TELEMETRY');

  if (!telemetryConfig.ENABLED) {
    return;
  }

  if (route === '/') {
    return;
  }

  const telemetry: TelemetryData = {
    route,
    apiVersion: `${packageJson.version}`,
    timestamp: new Date(),
  };

  const url =
    telemetryConfig.URL && telemetryConfig.URL !== '' ? telemetryConfig.URL : 'https://log.evolution-api.com/telemetry';

  axios
    .post(url, telemetry)
    .then(() => {})
    .catch(() => {});
};
