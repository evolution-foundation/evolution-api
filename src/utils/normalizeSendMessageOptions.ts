import { Logger } from '@config/logger.config';

const logger = new Logger('SendMessageOptions');
const warnedAliases = new Set<string>();

const warnOnce = (key: string, message: string) => {
  if (warnedAliases.has(key)) return;
  warnedAliases.add(key);
  logger.warn(message);
};

export const normalizeFileName = <T extends { fileName?: string }>(data: T): T => {
  if (!data) return data;
  const legacy = (data as any).filename;
  if (data.fileName === undefined && legacy !== undefined) {
    return { ...data, fileName: legacy };
  }
  return data;
};

export const resolveMentionsEveryOne = (input: any): boolean => {
  if (!input) return false;
  if (input.mentionsEveryOne === true) return true;
  if (input.everyOne === true) {
    warnOnce(
      'everyOne',
      '"everyOne" is deprecated and will be removed in a future release. Use "mentionsEveryOne" instead.',
    );
    return true;
  }
  return false;
};
