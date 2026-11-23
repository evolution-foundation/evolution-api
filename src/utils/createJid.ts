// Check if the number is MX or AR
function formatMXOrARNumber(jid: string): string {
  const countryCode = jid.substring(0, 2);

  if (Number(countryCode) === 52 || Number(countryCode) === 54) {
    if (jid.length === 13) {
      const number = countryCode + jid.substring(3);
      return number;
    }

    return jid;
  }
  return jid;
}

const BRAZIL_COUNTRY_CODE = '55';
const BRAZIL_PHONE_WITH_NINTH_DIGIT_LENGTH = 13;
const BRAZIL_PHONE_WITHOUT_NINTH_DIGIT_LENGTH = 12;
const BRAZIL_MOBILE_NINTH_DIGIT = '9';
const COUNTRY_AND_AREA_CODE_LENGTH = 4;
const FIRST_SUBSCRIBER_DIGIT_INDEX = 4;
const MINIMUM_MOBILE_FIRST_DIGIT = 6;

export function formatBRNumber(jid: string): string {
  if (!jid.startsWith(BRAZIL_COUNTRY_CODE)) {
    return jid;
  }

  if (jid.length === BRAZIL_PHONE_WITH_NINTH_DIGIT_LENGTH) {
    return jid;
  }

  if (jid.length === BRAZIL_PHONE_WITHOUT_NINTH_DIGIT_LENGTH) {
    const firstSubscriberDigit = Number.parseInt(jid[FIRST_SUBSCRIBER_DIGIT_INDEX]);
    const isMobileMissingNinthDigit = firstSubscriberDigit >= MINIMUM_MOBILE_FIRST_DIGIT;

    if (isMobileMissingNinthDigit) {
      const countryAndAreaCode = jid.slice(0, COUNTRY_AND_AREA_CODE_LENGTH);
      const subscriberNumber = jid.slice(COUNTRY_AND_AREA_CODE_LENGTH);

      return `${countryAndAreaCode}${BRAZIL_MOBILE_NINTH_DIGIT}${subscriberNumber}`;
    }
  }

  return jid;
}

export function createJid(number: string): string {
  number = number.replace(/:\d+/, '');

  if (
    number.includes('@g.us') ||
    number.includes('@s.whatsapp.net') ||
    number.includes('@lid') ||
    number.includes('@newsletter')
  ) {
    return number;
  }

  if (number.includes('@broadcast')) {
    return number;
  }

  number = number
    ?.replace(/\s/g, '')
    .replace(/\+/g, '')
    .replace(/\(/g, '')
    .replace(/\)/g, '')
    .split(':')[0]
    .split('@')[0];

  if (number.includes('-') && number.length >= 24) {
    number = number.replace(/[^\d-]/g, '');
    return `${number}@g.us`;
  }

  number = number.replace(/\D/g, '');

  if (number.length >= 18) {
    number = number.replace(/[^\d-]/g, '');
    return `${number}@g.us`;
  }

  number = formatMXOrARNumber(number);

  number = formatBRNumber(number);

  return `${number}@s.whatsapp.net`;
}
